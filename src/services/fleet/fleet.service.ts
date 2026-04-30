// src/services/fleet/fleet.service.ts
import { appDbQuery, appDbExecute, steveDbExecute } from '../../config/database.js';
import logger from '../../config/logger.js';

// ── Get fleet for a user ──────────────────────────────
export async function getUserFleet(userId: number) {
  const [member] = await appDbQuery<any>(`
    SELECT fm.*, f.name as fleet_name, f.billing_mode,
           f.monthly_budget, f.contact_email, f.is_active as fleet_active
    FROM fleet_members fm
    JOIN fleets f ON f.id = fm.fleet_id
    WHERE fm.user_id = ? AND fm.is_active = 1 AND f.is_active = 1
    LIMIT 1
  `, [userId]);

  return member || null;
}

// ── Check if user has fleet billing ───────────────────
export async function getFleetBillingContext(userId: number) {
  const member = await getUserFleet(userId);
  if (!member) return null;

  // Check monthly spend so far
  const now = new Date();
  const [spend] = await appDbQuery<any>(`
    SELECT COALESCE(SUM(total_cost), 0) as spent
    FROM charging_sessions
    WHERE app_user_id = ?
      AND status = 'completed'
      AND YEAR(start_time) = ?
      AND MONTH(start_time) = ?
  `, [userId, now.getFullYear(), now.getMonth() + 1]);

  const spentAmount = parseFloat(spend?.spent || '0');

  return {
    fleetId:       member.fleet_id,
    fleetName:     member.fleet_name,
    role:          member.role,
    billingMode:   member.billing_mode,
    monthlyLimit:  member.monthly_limit,
    spentThisMonth: spentAmount,
    remainingBudget: member.monthly_limit
      ? Math.max(0, member.monthly_limit - spentAmount)
      : null,
    overLimit: member.monthly_limit
      ? spentAmount >= member.monthly_limit
      : false,
  };
}

// ── Create fleet ──────────────────────────────────────
export async function createFleet(
  adminUserId: number,
  data: {
    name: string;
    billingMode: 'fleet_pays' | 'driver_pays';
    monthlyBudget?: number;
    gstNumber?: string;
    contactEmail: string;
    contactPhone?: string;
  }
) {
  const result = await appDbExecute(`
    INSERT INTO fleets
      (name, billing_mode, monthly_budget, gst_number,
       contact_email, contact_phone)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    data.name, data.billingMode, data.monthlyBudget ?? null,
    data.gstNumber ?? null, data.contactEmail, data.contactPhone ?? null,
  ]);

  const fleetId = (result as any).insertId;

  // Add creator as admin
  await appDbExecute(`
    INSERT INTO fleet_members (fleet_id, user_id, role)
    VALUES (?, ?, 'admin')
  `, [fleetId, adminUserId]);

  logger.info('Fleet created', { fleetId, adminUserId });
  return fleetId;
}

// ── Add member to fleet ───────────────────────────────
export async function addFleetMember(
  fleetId: number,
  adminUserId: number,
  newUserId: number,
  role: 'admin' | 'driver' = 'driver',
  monthlyLimit?: number
) {
  // Verify requester is admin
  await assertFleetAdmin(fleetId, adminUserId);

  await appDbExecute(`
    INSERT INTO fleet_members (fleet_id, user_id, role, monthly_limit)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE role = ?, monthly_limit = ?, is_active = 1
  `, [fleetId, newUserId, role, monthlyLimit ?? null,
      role, monthlyLimit ?? null]);

  logger.info('Fleet member added', { fleetId, newUserId, role });
}

// ── Add vehicle to fleet ──────────────────────────────
export async function addFleetVehicle(
  fleetId: number,
  adminUserId: number,
  data: {
    registrationNo: string;
    nickname?: string;
    assignedTo?: number;
    monthlyLimit?: number;
  }
) {
  await assertFleetAdmin(fleetId, adminUserId);

  // Generate unique OCPP idTag for this vehicle
  const idTag = `FLT${fleetId}-${data.registrationNo
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(-8)}`;

  // Register idTag in SteVe
  await registerIdTagInSteve(idTag);

  await appDbExecute(`
    INSERT INTO fleet_vehicles
      (fleet_id, registration_no, nickname, ocpp_id_tag,
       assigned_to, monthly_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    fleetId, data.registrationNo, data.nickname ?? null,
    idTag, data.assignedTo ?? null, data.monthlyLimit ?? null,
  ]);

  logger.info('Fleet vehicle added', { fleetId, idTag });
  return idTag;
}

// ── Fleet dashboard stats ─────────────────────────────
export async function getFleetDashboard(
  fleetId: number,
  requestingUserId: number
) {
  await assertFleetAdmin(fleetId, requestingUserId);

  const now = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  // Overall fleet stats this month
  const [stats] = await appDbQuery<any>(`
    SELECT
      COUNT(*)                          as total_sessions,
      COALESCE(SUM(cs.energy_kwh),0)   as total_kwh,
      COALESCE(SUM(cs.total_cost),0)   as total_cost,
      COUNT(DISTINCT cs.app_user_id)   as active_drivers
    FROM charging_sessions cs
    JOIN fleet_members fm ON fm.user_id = cs.app_user_id
      AND fm.fleet_id = ? AND fm.is_active = 1
    WHERE cs.status = 'completed'
      AND YEAR(cs.start_time) = ?
      AND MONTH(cs.start_time) = ?
  `, [fleetId, year, month]);

  // Per-driver breakdown
  const driverStats = await appDbQuery<any>(`
    SELECT
      u.username,
      u.email,
      fm.monthly_limit,
      COUNT(cs.session_id)              as sessions,
      COALESCE(SUM(cs.energy_kwh),0)   as kwh,
      COALESCE(SUM(cs.total_cost),0)   as spent
    FROM fleet_members fm
    JOIN users u ON u.user_id = fm.user_id
    LEFT JOIN charging_sessions cs ON cs.app_user_id = fm.user_id
      AND cs.status = 'completed'
      AND YEAR(cs.start_time) = ?
      AND MONTH(cs.start_time) = ?
    WHERE fm.fleet_id = ? AND fm.is_active = 1
    GROUP BY fm.user_id, u.username, u.email, fm.monthly_limit
    ORDER BY spent DESC
  `, [year, month, fleetId]);

  // Top chargers used
  const topChargers = await appDbQuery<any>(`
    SELECT cs.charge_box_id,
           COUNT(*)                     as sessions,
           SUM(cs.total_cost)           as total_cost
    FROM charging_sessions cs
    JOIN fleet_members fm ON fm.user_id = cs.app_user_id
      AND fm.fleet_id = ?
    WHERE cs.status = 'completed'
      AND YEAR(cs.start_time) = ?
      AND MONTH(cs.start_time) = ?
    GROUP BY cs.charge_box_id
    ORDER BY sessions DESC
    LIMIT 5
  `, [fleetId, year, month]);

  return {
    period: { year, month },
    summary: {
      totalSessions:  parseInt(stats.total_sessions),
      totalKwh:       parseFloat(stats.total_kwh).toFixed(2),
      totalCost:      parseFloat(stats.total_cost).toFixed(2),
      activeDrivers:  parseInt(stats.active_drivers),
    },
    drivers:     driverStats.map((d: any) => ({
      username:     d.username,
      email:        d.email,
      monthlyLimit: d.monthly_limit,
      sessions:     parseInt(d.sessions),
      kwh:          parseFloat(d.kwh).toFixed(2),
      spent:        parseFloat(d.spent).toFixed(2),
      overLimit:    d.monthly_limit && parseFloat(d.spent) >= d.monthly_limit,
    })),
    topChargers: topChargers.map((c: any) => ({
      chargeBoxId: c.charge_box_id,
      sessions:    parseInt(c.sessions),
      totalCost:   parseFloat(c.total_cost).toFixed(2),
    })),
  };
}

// ── Generate monthly invoice ──────────────────────────
export async function generateFleetInvoice(
  fleetId: number,
  year: number,
  month: number
): Promise<any> {
  const sessions = await appDbQuery<any>(`
    SELECT cs.*, u.username, u.email
    FROM charging_sessions cs
    JOIN fleet_members fm ON fm.user_id = cs.app_user_id
      AND fm.fleet_id = ?
    WHERE cs.status = 'completed'
      AND YEAR(cs.start_time) = ?
      AND MONTH(cs.start_time) = ?
    ORDER BY cs.start_time ASC
  `, [fleetId, year, month]);

  const totalAmount = sessions.reduce(
    (sum: number, s: any) => sum + parseFloat(s.total_cost || 0), 0
  );
  const totalEnergy = sessions.reduce(
    (sum: number, s: any) => sum + parseFloat(s.energy_kwh || 0), 0
  );

  // Upsert invoice record
  await appDbExecute(`
    INSERT INTO fleet_invoices
      (fleet_id, period_year, period_month, total_sessions,
       total_energy_kwh, total_amount, status, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', NOW())
    ON DUPLICATE KEY UPDATE
      total_sessions   = VALUES(total_sessions),
      total_energy_kwh = VALUES(total_energy_kwh),
      total_amount     = VALUES(total_amount),
      generated_at     = NOW()
  `, [fleetId, year, month, sessions.length,
      totalEnergy.toFixed(3), totalAmount.toFixed(2)]);

  return {
    fleetId,
    period: { year, month },
    sessions: sessions.length,
    totalEnergyKwh: totalEnergy.toFixed(3),
    totalAmount: totalAmount.toFixed(2),
    lineItems: sessions.map((s: any) => ({
      date:        s.start_time,
      driver:      s.username,
      charger:     s.charge_box_id,
      connector:   s.connector_id,
      energyKwh:   parseFloat(s.energy_kwh).toFixed(3),
      cost:        parseFloat(s.total_cost).toFixed(2),
      duration:    s.duration_seconds,
    })),
  };
}

// ── Helpers ───────────────────────────────────────────
export async function assertFleetAdmin(fleetId: number, userId: number) {
  const [member] = await appDbQuery<any>(`
    SELECT id FROM fleet_members
    WHERE fleet_id = ? AND user_id = ? AND role = 'admin' AND is_active = 1
  `, [fleetId, userId]);

  if (!member) throw new Error('Fleet admin access required');
}

async function registerIdTagInSteve(idTag: string) {
  // Register the vehicle's idTag in SteVe so it can authenticate
  const { steveDbExecute } = await import('../../config/database.js');
  await steveDbExecute(`
    INSERT IGNORE INTO ocpp_tag (id_tag, max_active_transaction_count)
    VALUES (?, 1)
  `, [idTag]);
}
