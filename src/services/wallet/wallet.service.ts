// src/services/wallet/wallet.service.ts
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { appDbQuery, appDbExecute } from '../../config/database.js';
import { sendPushToUser } from '../notifications/push.service.js';
import logger from '../../config/logger.js';

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

const LOW_BALANCE_THRESHOLD = 100; // ₹100

// ── Get or create wallet ──────────────────────────────
export async function getWallet(userId: number) {
  // Upsert wallet row
  await appDbExecute(`
    INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0.00)
  `, [userId]);

  const [wallet] = await appDbQuery<any>(
    'SELECT * FROM wallets WHERE user_id = ?', [userId]
  );
  return wallet;
}

// ── Create Razorpay order (step 1 of payment) ────────
export async function createLoadOrder(
  userId: number,
  amount: number         // in ₹
): Promise<{ orderId: string; amount: number; currency: string; keyId: string }> {

  if (amount < 50) throw new Error('Minimum load amount is ₹50');
  if (amount > 50000) throw new Error('Maximum load amount is ₹50,000');

  // Razorpay expects amount in paise (₹1 = 100 paise)
  const amountPaise = Math.round(amount * 100);

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `wallet_${userId}_${Date.now()}`,
    notes: { userId: String(userId) },
  });

  // Record order in DB
  await appDbExecute(`
    INSERT INTO payment_orders
      (user_id, razorpay_order_id, amount, status)
    VALUES (?, ?, ?, 'created')
  `, [userId, order.id, amount]);

  logger.info('Payment order created', {
    userId, orderId: order.id, amount
  });

  return {
    orderId:  order.id,
    amount,
    currency: 'INR',
    keyId:    process.env.RAZORPAY_KEY_ID!,
  };
}

// ── Verify payment + credit wallet (step 2) ───────────
export async function verifyAndCreditWallet(
  userId: number,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string
): Promise<{ success: boolean; newBalance: number }> {

  // 1. Verify Razorpay signature
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.warn('Invalid Razorpay signature', { userId, razorpayOrderId });
    throw new Error('Payment verification failed — invalid signature');
  }

  // 2. Check order exists and belongs to user
  const [order] = await appDbQuery<any>(`
    SELECT * FROM payment_orders
    WHERE razorpay_order_id = ? AND user_id = ? AND status = 'created'
  `, [razorpayOrderId, userId]);

  if (!order) throw new Error('Order not found or already processed');

  const amount = parseFloat(order.amount);

  // 3. Credit wallet in a transaction (atomic)
  const connection = await getConnection();
  try {
    await connection.beginTransaction();

    // Lock wallet row
    const [[wallet]] = await connection.query(
      'SELECT * FROM wallets WHERE user_id = ? FOR UPDATE',
      [userId]
    ) as any;

    const balanceBefore = parseFloat(wallet?.balance || '0');
    const balanceAfter  = balanceBefore + amount;

    // Update wallet
    await connection.query(`
      INSERT INTO wallets (user_id, balance, lifetime_loaded)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        balance         = balance + ?,
        lifetime_loaded = lifetime_loaded + ?,
        updated_at      = NOW()
    `, [userId, amount, amount, amount, amount]);

    // Record transaction
    await connection.query(`
      INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after,
         description, razorpay_payment_id, reference_id, status)
      VALUES (?, 'credit', ?, ?, ?, ?, ?, ?, 'completed')
    `, [
      userId, amount, balanceBefore, balanceAfter,
      `Wallet load via Razorpay`,
      razorpayPaymentId, razorpayOrderId
    ]);

    // Mark order paid
    await connection.query(`
      UPDATE payment_orders
      SET status = 'paid', razorpay_payment_id = ?, updated_at = NOW()
      WHERE razorpay_order_id = ?
    `, [razorpayPaymentId, razorpayOrderId]);

    await connection.commit();

    logger.info('Wallet credited', { userId, amount, balanceAfter });

    // Push notification
    await sendPushToUser(userId, {
      title: '💰 Wallet Loaded!',
      body: `₹${amount.toFixed(2)} added. Balance: ₹${balanceAfter.toFixed(2)}`,
      data: { action: 'view_wallet' },
    });

    return { success: true, newBalance: balanceAfter };

  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ── Deduct from wallet (called when session ends) ─────
export async function deductFromWallet(
  userId: number,
  amount: number,
  sessionId: number,
  description: string
): Promise<{ success: boolean; newBalance: number }> {

  const connection = await getConnection();
  try {
    await connection.beginTransaction();

    const [[wallet]] = await connection.query(
      'SELECT * FROM wallets WHERE user_id = ? FOR UPDATE',
      [userId]
    ) as any;

    if (!wallet) throw new Error('Wallet not found');

    const balanceBefore = parseFloat(wallet.balance);
    if (balanceBefore < amount) {
      await connection.rollback();
      return { success: false, newBalance: balanceBefore };
    }

    const balanceAfter = balanceBefore - amount;

    await connection.query(`
      UPDATE wallets
      SET balance = balance - ?,
          lifetime_spent = lifetime_spent + ?,
          updated_at = NOW()
      WHERE user_id = ?
    `, [amount, amount, userId]);

    await connection.query(`
      INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after,
         description, reference_id, status)
      VALUES (?, 'debit', ?, ?, ?, ?, ?, 'completed')
    `, [
      userId, amount, balanceBefore, balanceAfter,
      description, String(sessionId)
    ]);

    // Update session payment status
    await connection.query(`
      UPDATE charging_sessions
      SET payment_status = 'paid', payment_method = 'wallet'
      WHERE session_id = ?
    `, [sessionId]);

    await connection.commit();

    logger.info('Wallet debited', { userId, amount, balanceAfter, sessionId });

    // Low balance alert
    if (balanceAfter < LOW_BALANCE_THRESHOLD) {
      await sendPushToUser(userId, {
        title: '⚠️ Low Wallet Balance',
        body: `Balance ₹${balanceAfter.toFixed(2)} — add money to keep charging`,
        data: { action: 'view_wallet' },
      });
    }

    return { success: true, newBalance: balanceAfter };

  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// ── Get transaction history ───────────────────────────
export async function getWalletHistory(
  userId: number,
  limit = 20,
  offset = 0
) {

  const limitInt = Math.max(1, Math.min(100, Number(limit) || 20));
  const offsetInt = Math.max(0, Number(offset) || 0);	
  const rows = await appDbQuery<any>(`
    SELECT * FROM wallet_transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ${limitInt} OFFSET ${offsetInt}
  `, [userId]);

  return rows.map((r: any) => ({
    id:            r.id,
    type:          r.type,
    amount:        parseFloat(r.amount),
    balanceBefore: parseFloat(r.balance_before),
    balanceAfter:  parseFloat(r.balance_after),
    description:   r.description,
    referenceId:   r.reference_id,
    paymentId:     r.razorpay_payment_id,
    status:        r.status,
    createdAt:     r.created_at,
  }));
}

// ── Handle Razorpay webhook (payment.failed etc.) ─────
export async function handleRazorpayWebhook(
  body: string,
  signature: string
): Promise<void> {
  // Verify webhook signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(body)
    .digest('hex');

  if (expectedSig !== signature) {
    throw new Error('Invalid webhook signature');
  }

  const event = JSON.parse(body);
  logger.info('Razorpay webhook', { event: event.event });

  if (event.event === 'payment.failed') {
    const payment   = event.payload.payment.entity;
    const orderId   = payment.order_id;
    const userId    = parseInt(payment.notes?.userId || '0');
    const reason    = payment.error_description || 'Payment failed';

    await appDbExecute(`
      UPDATE payment_orders
      SET status = 'failed', failure_reason = ?, updated_at = NOW()
      WHERE razorpay_order_id = ?
    `, [reason, orderId]);

    if (userId) {
      await sendPushToUser(userId, {
        title: '❌ Payment Failed',
        body: `Wallet load failed: ${reason}. Please try again.`,
        data: { action: 'view_wallet' },
      });
    }
  }
}

// ── Helper ────────────────────────────────────────────
async function getConnection() {
  const { appPool } = await import('../../config/database.js');
  return appPool.getConnection();
}
