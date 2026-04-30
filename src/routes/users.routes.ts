// src/routes/users.routes.ts
import { verifyOtpInternal } from './auth.routes.js';
import { Router, Request, Response } from 'express';
import { steveQuery, steveDbExecute } from '../config/database.js';
import { appDbQuery, appDbExecute } from '../config/database.js';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { steveApiService } from '../services/steve/steve-api.service.js';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import validator from 'validator';
import { resolveUserIdForTag, validateTagForUser, getUserTags, getTagAssignment } from '../services/auth/tag-resolver.service.js';
import { generateMonthlyReport } from '../services/reports/monthly.service.js';
import { getUserIdTag, assignOcppTagToUser } from '../services/auth/tag.service.js';

import logger from '../config/logger.js';

const router = Router();

// ─────────────────────────────────────────────────────
// USER MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────

// POST /api/users - Register new user
router.post('/', async (req: Request, res: Response) => {
  try {
    const { username, email, password, firstName, lastName, phone } = req.body;

    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'username, email, and password are required'
      });
    }
    
    // Validate password strength
    if (!validator.isStrongPassword(password, {
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1
    })) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Password does not meet security requirements'
      });
    }
    
    // Check if user already exists (voltstartev_db.users)
    const existingRows = await appDbQuery(
      'SELECT user_id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    
    if (existingRows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Username or email already registered'
      });
    }

    const otpCheck = await verifyOtpInternal(email, req.body.otp, 'registration');
    if (!otpCheck.valid) {
      return res.status(400).json({
        success: false,
        error: otpCheck.reason || 'Email not verified'
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Insert new user (voltstartev_db.users)
    const insertResult = await appDbExecute(`
      INSERT INTO users (username, email, password_hash, first_name, last_name, phone, is_active, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, TRUE, FALSE)
    `, [username, email, passwordHash, firstName || null, lastName || null, phone || null]);
    
    const userId = insertResult.insertId;
    
    if (!userId) {
      throw new Error('Failed to retrieve inserted user ID');
    }
 
    const newUserId = (insertResult as any).insertId;
    // Assign OCPP tag immediately
    let idTag: string | null = null;
    try {
      idTag = await assignOcppTagToUser(newUserId, username);
      logger.info(`Tag assigned to new user`, { userId: newUserId, idTag });
    } catch (err: any) {
      // Don't fail registration if tag assignment fails
      // User can still register, tag assigned on next login
      logger.error(`Tag assignment failed for user ${newUserId}`, { error: err.message });
    }

    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }
    
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '30d';
    
    const token = jwt.sign(
      { id: userId, username, role: 'customer' },
      jwtSecret,
      { expiresIn: jwtExpiresIn as jwt.SignOptions['expiresIn'] }
    );
    
    logger.info(` User registered: ${username} (ID: ${userId})`);
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        token,
        user: {
          userId: newUserId,
          username,
          email,
          firstName: firstName || null,
          lastName: lastName || null,
          phone: phone || null,
          idTag: idTag ?? null, 
          role: 'customer',
          targetSocPercent: 80,  // Default value
          isVerified: false,
        }
      }
    });

  } catch (error: any) {
    logger.error(' Failed to register user', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/users/login - Authenticate user
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    
    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Username and password are required'
      });
    }
    
    // Find user by username (voltstartev_db.users)
    const users = await appDbQuery(
      'SELECT * FROM users WHERE username = ? LIMIT 1',
      [username.trim()]
    );
    
    const user = users[0];
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid credentials'
      });
    }
    
    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Account is inactive'
      });
    }
    
    // Compare password
    if (!user.password_hash) {
      logger.error('User record missing password_hash', { userId: user.user_id });
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: 'Unable to authenticate. Please contact support.'
      });
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid credentials'
      });
    }

    let idTag = await getUserIdTag(user.user_id);
    if (!idTag) {
      // User has no tag — assign one now (handles existing users without tags)
      try {
        idTag = await assignOcppTagToUser(user.user_id, user.username);
      } catch (err: any) {
        logger.warn(`Could not assign tag on login for user ${user.user_id}`);
      }
    }

    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }
    
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '30d';
    
    const token = jwt.sign(
      { id: user.user_id, username: user.username, role: user.role },
      jwtSecret,
      { expiresIn: jwtExpiresIn as jwt.SignOptions['expiresIn'] }
    );    
    
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          userId: user.user_id,
          username: user.username,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          idTag: idTag,  
          role: user.role,        
          vehicleModel: user.vehicle_model || null,        
          batteryCapacityKwh: user.battery_capacity_kwh 
            ? parseFloat(user.battery_capacity_kwh) : null, 
          targetSocPercent: user.target_soc_percent || 80,  
        }
      }      
    });
    
  } catch (error) {
    const errorDetails = error instanceof Error 
      ? { name: error.name, message: error.message, stack: error.stack }
      : { error: JSON.stringify(error), type: typeof error };
    
    logger.error('Login failed', { 
      username: req.body.username,
      error: errorDetails 
    });
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to login. Please try again.'
    });
  }
});

// In users.routes.ts GET /me:
router.get('/me', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const [user] = await appDbQuery<any>(
    `SELECT u.user_id, u.username, u.email, u.role, u.push_enabled,
            -- Legacy fields (kept for backward compat)
            u.vehicle_model, u.battery_capacity_kwh, u.target_soc_percent,
            -- Primary vehicle from new table
            v.id        as pv_id,
            v.brand     as pv_brand,
            v.model     as pv_model,
            v.variant   as pv_variant,
            v.battery_kwh as pv_battery_kwh,
            v.target_soc  as pv_target_soc,
            v.nickname    as pv_nickname
     FROM users u
     LEFT JOIN user_vehicles v
       ON v.user_id = u.user_id AND v.is_primary = 1
     WHERE u.user_id = ?
     LIMIT 1`,
    [userId]
  );

  res.json({
    success: true,
    data: {
      userId:           user.user_id,
      username:         user.username,
      email:            user.email,
      role:             user.role,
      // Primary vehicle — prefer new table, fall back to legacy
      batteryCapacityKwh: user.pv_battery_kwh ?? user.battery_capacity_kwh,
      targetSocPercent:   user.pv_target_soc  ?? user.target_soc_percent,
      vehicleModel:       user.pv_brand && user.pv_model
                            ? `${user.pv_brand} ${user.pv_model}`
                            : user.vehicle_model,
      // Full primary vehicle object
      primaryVehicle: user.pv_id ? {
        id:         user.pv_id,
        brand:      user.pv_brand,
        model:      user.pv_model,
        variant:    user.pv_variant,
        batteryKwh: user.pv_battery_kwh,
        targetSoc:  user.pv_target_soc,
        nickname:   user.pv_nickname,
      } : null,
    }
  });
});

// GET /api/users/:id - Get user profile by ID (admin only or self)
router.get('/:id', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const requestedUserId = parseInt(req.params.id);
    const currentUserId = (req as any).user?.id;
    const isAdmin = (req as any).user?.role === 'admin';

    // Authorization: users can only view their own profile unless admin
    if (!isAdmin && requestedUserId !== currentUserId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'You can only view your own profile'
      });
    }

    const users = await appDbQuery(
      'SELECT user_id, username, email, first_name, last_name FROM users WHERE user_id = ?',
      [requestedUserId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'User not found'
      });
    }

    const user = users[0];

    res.status(200).json({
      success: true,
      data: {
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name
      }
    });
  } catch (error: any) {
    logger.error(' Failed to fetch user', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ─────────────────────────────────────────────────────
// TAG MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────

// POST /api/users/:userId/tags - Assign tag to user
router.post('/:userId/tags', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const { idTag, nickname, maxActiveTransactions, expiryDate } = req.body;

    if (!idTag) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'idTag is required',
        timestamp: new Date().toISOString()
      });
    }

    // Get or create tag via SteVe API
    const tagResult = await steveApiService.getOrCreateTag(idTag, {
      maxActiveTransactionCount: maxActiveTransactions || 1,
      expiryDate: expiryDate ? new Date(expiryDate).toISOString() : undefined,
      note: nickname || 'Provisioned by VoltStartEV app',
    });

    if (!tagResult.success || !tagResult.data) {
      logger.error(' Failed to provision tag via SteVe API', {
        idTag,
        error: tagResult.error,
      });

      return res.status(502).json({
        success: false,
        error: 'Bad gateway',
        message: `Failed to provision tag ${idTag} via SteVe: ${tagResult.error?.message}`,
        timestamp: new Date().toISOString()
      });
    }

    const ocppTagPk = tagResult.data.ocppTagPk;
    
    // Check if tag is already assigned to a DIFFERENT user
    const existingLinkages = await steveQuery(
      'SELECT user_pk FROM user_ocpp_tag WHERE ocpp_tag_pk = ? LIMIT 1',
      [ocppTagPk]
    );

    if (existingLinkages.length > 0) {
      const existingLink = existingLinkages[0];
      
      if (existingLink.user_pk !== userId) {
        // Tag assigned to DIFFERENT user → Reject with 409
        return res.status(409).json({
          success: false,
          error: 'Conflict',
          message: `Tag ${idTag} is already assigned to user ${existingLink.user_pk}. Unassign it first.`,
          timestamp: new Date().toISOString()
        });
      } else {
        // Tag already assigned to SAME user → Idempotent success
        return res.status(200).json({
          success: true,
          message: 'Tag already assigned',
          data: { userId, idTag, nickname }
        });
      }
    }
    
    // Link user to tag in user_ocpp_tag table (stevedb)
    await steveQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, ?)
    `, [userId, ocppTagPk]);

    logger.info(` Tag ${idTag} assigned to user ${userId}`);

    res.status(201).json({
      success: true,
      message: 'Tag assigned successfully',
      data: {
        userId,
        idTag,
        nickname,
        ocppTagPk,
        provisionedVia: 'steve-api'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error(' Failed to assign tag', { error });

    if (error.message?.includes('SteVe API')) {
      return res.status(502).json({
        success: false,
        error: 'Bad gateway',
        message: `SteVe API error: ${error.message}`,
        timestamp: new Date().toISOString()
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'Unable to assign tag. Please try again.',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/users/:userId/tags - Get all tags for a user
router.get('/:userId/tags', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    
    const tags = await getUserTags(userId);
    
    res.status(200).json({
      success: true,
      data: {
        userId,
        tags
      }
    });
    
  } catch (error: any) {
    logger.error(' Failed to get user tags', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/users/:userId/tags/:idTag - Remove tag from user
router.delete('/:userId/tags/:idTag', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const idTag = req.params.idTag;
    
    // Get ocpp_tag_pk first
    const tagRows = await steveQuery(
      'SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1',
      [idTag]
    );
    
    if (tagRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Tag ${idTag} not found`
      });
    }
    
    const ocppTagPk = tagRows[0].ocpp_tag_pk;
    
    // Delete linkage from user_ocpp_tag
    await steveQuery(`
      DELETE FROM user_ocpp_tag
      WHERE user_pk = ? AND ocpp_tag_pk = ?
    `, [userId, ocppTagPk]);
    
    logger.info(` Tag ${idTag} removed from user ${userId}`);
    
    res.status(200).json({
      success: true,
      message: 'Tag removed successfully'
    });
    
  } catch (error: any) {
    logger.error(' Failed to remove tag', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/tags/:idTag/assignment - Get user assigned to a specific tag
router.get('/tags/:idTag/assignment', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const idTag = req.params.idTag;
    
    const assignment = await getTagAssignment(idTag);
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Tag ${idTag} is not assigned to any user`
      });
    }
    
    res.status(200).json({
      success: true,
      data: assignment
    });
    
  } catch (error: any) {
    logger.error(' Failed to fetch tag assignment', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/tags - List all tags with assignment status
router.get('/tags', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const tags = await steveQuery(`
      SELECT 
        ot.ocpp_tag_pk, 
        ot.id_tag, 
        ot.expiry_date, 
        ot.max_active_transaction_count,
        ota.blocked, 
        ota.active_transaction_count, 
        uot.user_pk AS assigned_to_user
      FROM ocpp_tag ot
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      LEFT JOIN user_ocpp_tag uot ON uot.ocpp_tag_pk = ot.ocpp_tag_pk
      ORDER BY ot.id_tag
    `);
    
    res.status(200).json({
      success: true,
      data: { tags }
    });
    
  } catch (error: any) {
    logger.error(' Failed to fetch tags', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// PUT /api/users/me/push-token
router.put('/me/push-token', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { token, platform } = req.body;
    
    await appDbExecute(
      'UPDATE users SET push_token = ?, push_platform = ? WHERE user_id = ?',
      [token, platform, userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

//  PUT /api/users/me/vehicle - MUST be BEFORE export default router
router.put('/me/vehicle', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { vehicleModel, batteryCapacityKwh, targetSocPercent } = req.body;
    
    await appDbExecute(`
      UPDATE users 
      SET vehicle_model = ?,
          battery_capacity_kwh = ?,
          target_soc_percent = ?,
          updated_at = NOW()
      WHERE user_id = ?
    `, [
      vehicleModel || null, 
      batteryCapacityKwh || null, 
      targetSocPercent || 80, 
      userId
    ]);

    logger.info(` Vehicle profile updated for user ${userId}`);
    
    res.json({ 
      success: true, 
      message: 'Vehicle profile updated',
      data: { vehicleModel, batteryCapacityKwh, targetSocPercent }
    });
  } catch (error: any) {
    logger.error(' Failed to update vehicle profile', { error });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update vehicle profile',
      message: error.message 
    });
  }
});

router.get('/me/report/:year/:month', authenticateJwt,
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);

    const report = await generateMonthlyReport(userId, year, month);
    res.json({ success: true, data: report });
  }
);


// GET /api/users/me/vehicles — list all vehicles
router.get('/me/vehicles', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const vehicles = await appDbQuery(
    'SELECT * FROM user_vehicles WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC',
    [userId]
  );
  res.json({ success: true, data: vehicles });
});

// POST /api/users/me/vehicles — add vehicle
router.post('/me/vehicles', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { nickname, brand, model, variant, batteryKwh, targetSoc, isPrimary } = req.body;
  if (!brand || !model || !batteryKwh) {
    return res.status(400).json({ success: false, error: 'brand, model and batteryKwh required' });
  }
  // If setting as primary, unset others first
  if (isPrimary) {
    await appDbExecute('UPDATE user_vehicles SET is_primary = 0 WHERE user_id = ?', [userId]);
  }
  const result = await appDbExecute(
    `INSERT INTO user_vehicles (user_id, nickname, brand, model, variant, battery_kwh, target_soc, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, nickname || null, brand, model, variant || null,
     batteryKwh, targetSoc || 80, isPrimary ? 1 : 0]
  );
  res.json({ success: true, data: { id: result.insertId } });
});

// PUT /api/users/me/vehicles/:id — update vehicle
router.put('/me/vehicles/:id', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { nickname, brand, model, variant, batteryKwh, targetSoc, isPrimary } = req.body;
  if (isPrimary) {
    await appDbExecute('UPDATE user_vehicles SET is_primary = 0 WHERE user_id = ?', [userId]);
  }
  await appDbExecute(
    `UPDATE user_vehicles SET nickname=?, brand=?, model=?, variant=?,
     battery_kwh=?, target_soc=?, is_primary=? WHERE id=? AND user_id=?`,
    [nickname || null, brand, model, variant || null,
     batteryKwh, targetSoc || 80, isPrimary ? 1 : 0,
     req.params.id, userId]
  );
  res.json({ success: true });
});

// DELETE /api/users/me/vehicles/:id — remove vehicle
router.delete('/me/vehicles/:id', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  await appDbExecute(
    'DELETE FROM user_vehicles WHERE id = ? AND user_id = ?',
    [req.params.id, userId]
  );
  res.json({ success: true });
});

// PUT /api/users/me/vehicles/:id/primary — set as primary
router.put('/me/vehicles/:id/primary', authenticateJwt, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  await appDbExecute('UPDATE user_vehicles SET is_primary = 0 WHERE user_id = ?', [userId]);
  await appDbExecute(
    'UPDATE user_vehicles SET is_primary = 1 WHERE id = ? AND user_id = ?',
    [req.params.id, userId]
  );
  res.json({ success: true });
});

// ─── RFID Card Management ────────────────────────────

// GET /api/users/me/rfid — list all RFID cards
/*
router.get('/me/rfid', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;

    const cards = await appDbQuery<any>(`
      SELECT
        ut.id,
        ut.ocpp_tag_id AS id_tag,
        ut.label,
        ut.tag_type,
        ut.is_primary,
        ut.is_active,
        ut.created_at,
        ota.active_transaction_count,
        ota.in_transaction,
        ota.blocked
      FROM user_tags ut
      LEFT JOIN stevedb.ocpp_tag ot
        ON ot.id_tag = ut.ocpp_tag_id
      LEFT JOIN stevedb.ocpp_tag_activity ota
        ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE ut.app_user_id = ?
        AND ut.is_active = 1
      ORDER BY ut.is_primary DESC, ut.created_at ASC
    `, [userId]);

    res.json({
      success: true,
      data: cards
    });

  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
*/

// GET /api/users/me/rfid — list all RFID cards
router.get('/me/rfid', authenticateJwt, async (req: Request, res: Response) => {  
  const userId = (req as any).user.id;
  try {
    const cards = await appDbQuery<any>(`
      SELECT
        ut.id,
        ut.ocpp_tag_id AS id_tag,
        ut.nickname AS label,
        ut.tag_type,
        ut.is_active AS is_primary,
        ut.is_active,
        ut.created_at,
        COALESCE(ota.active_transaction_count, 0) AS active_transaction_count,
        COALESCE(ota.in_transaction, 0) AS in_transaction,
        COALESCE(ota.blocked, 0) AS blocked
      FROM user_tags ut
      LEFT JOIN stevedb.ocpp_tag_activity ota
        ON ota.id_tag = ut.ocpp_tag_id  
      WHERE ut.app_user_id = ?         
        AND ut.is_active = 1          
      ORDER BY ut.is_active DESC, ut.created_at DESC
    `, [userId]);

    res.json({
      success: true,
      data: cards
    });

  } catch (err: any) {
    logger.error('Failed to fetch RFID cards', { userId, err });
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to fetch RFID cards'
    });
  }
});

// POST /api/users/me/rfid — register external RFID card
router.post('/me/rfid', authenticateJwt, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const {
      idTag,
      label = 'My RFID Card'
    } = req.body;

    if (!idTag || typeof idTag !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'RFID idTag is required'
      });
    }

    const cleanTag = idTag.trim().toUpperCase();

    // -------------------------------------------------
    // Get user info
    // -------------------------------------------------
    logger.debug('JWT User', {
      user: (req as any).user
    });

    const users: any = await appDbQuery(`
      SELECT username
      FROM users
      WHERE user_id = ?
      LIMIT 1
    `, [userId]);

    if (!users.length) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const username = users[0].username;

     // -------------------------------------------------
     // Ensure OCPP Tag exists in SteVe + Get pk for mapping
     // -------------------------------------------------
     logger.debug('Creating OCPP tag', { cleanTag, username });
     
     await steveDbExecute(`
       INSERT INTO stevedb.ocpp_tag
         (id_tag, max_active_transaction_count, note)
       VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note)
     `, [cleanTag, `External RFID — ${username}`]);
     
     //  Get the ocpp_tag_pk for the user_ocpp_tag mapping
     const [steveTag] = await steveQuery<{ ocpp_tag_pk: number }>(
       'SELECT ocpp_tag_pk FROM stevedb.ocpp_tag WHERE id_tag = ? LIMIT 1',
       [cleanTag]
     );
     
     //  Create SteVe user_ocpp_tag mapping
     if (steveTag) {
       logger.debug('Creating SteVe user_ocpp_tag mapping', {
         userId, cleanTag, ocpp_tag_pk: steveTag.ocpp_tag_pk
       });
       
       await steveDbExecute(`
         INSERT INTO stevedb.user_ocpp_tag (user_pk, ocpp_tag_pk, created_at, updated_at)
         VALUES (?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE updated_at = NOW()
       `, [userId, steveTag.ocpp_tag_pk]);
     } else {
       logger.warn('Could not find ocpp_tag_pk for tag', { cleanTag });
     }

    // -------------------------------------------------
    // Check if RFID already exists for this user
    // -------------------------------------------------
    const existing: any = await appDbQuery(`
      SELECT id
      FROM user_tags
      WHERE app_user_id = ?
        AND ocpp_tag_id = ?
      LIMIT 1
    `, [userId, cleanTag]);

    // -------------------------------------------------
    // Update existing RFID
    // -------------------------------------------------
    if (existing.length > 0) {
      await appDbExecute(`
        UPDATE user_tags
        SET
          label = ?,
          is_primary = 1,
          is_active = 1,
          updated_at = NOW()
        WHERE id = ?
      `, [label, existing[0].id]);
    }
    // -------------------------------------------------
    // Insert new RFID
    // -------------------------------------------------
    else {
      await appDbExecute(`
        INSERT INTO user_tags (
          app_user_id,
          ocpp_tag_id,
          label,
          tag_type,
          is_primary,
          is_active
        ) VALUES (?, ?, ?, 'external_rfid', 1, 1)
      `, [
        userId,
        cleanTag,
        label
      ]);
    }

    // -------------------------------------------------
    // Return updated list
    // -------------------------------------------------
    const tags: any = await appDbQuery(`
      SELECT
        ut.id,
        ut.ocpp_tag_id AS id_tag,
        ut.label,
        ut.tag_type,
        ut.is_primary,
        ut.is_active,
        ut.created_at,
        ota.active_transaction_count,
        ota.in_transaction,
        ota.blocked
      FROM user_tags ut
      LEFT JOIN stevedb.ocpp_tag_activity ota
        ON ota.id_tag = ut.ocpp_tag_id
      WHERE ut.app_user_id = ?
      ORDER BY ut.is_primary DESC, ut.created_at DESC
    `, [userId]);

    return res.json({
      success: true,
      message: 'RFID registered successfully',
      data: {
        idTag: cleanTag,
        label
      },
      tags
    });
    
  } catch (error: any) {
    logger.error('RFID registration failed FULL', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: error.message || 'RFID registration failed'
    });
  } 
});

// PUT /api/users/me/rfid/:id/primary — set as primary tag
router.put('/me/rfid/:id/primary', authenticateJwt,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;

      // Unset all primary
      await appDbExecute(
        `UPDATE user_tags SET is_primary = 0 WHERE app_user_id = ?`,
        [userId]
      );
      // Set this one as primary
      await appDbExecute(
        `UPDATE user_tags SET is_primary = 1
         WHERE id = ? AND app_user_id = ?`,
        [req.params.id, userId]
      );

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// DELETE /api/users/me/rfid/:id — remove RFID card
router.delete('/me/rfid/:id', authenticateJwt,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;

      const [card] = await appDbQuery<any>(
        `SELECT ocpp_tag_id, is_primary FROM user_tags
         WHERE id = ? AND app_user_id = ?`,
        [req.params.id, userId]
      );

      if (!card) {
        return res.status(404).json({
          success: false, error: 'Card not found'
        });
      }

      // Soft delete
      await appDbExecute(
        `UPDATE user_tags SET is_active = 0
         WHERE id = ? AND app_user_id = ?`,
        [req.params.id, userId]
      );

      // If it was primary, make the system tag primary
      if (card.is_primary) {
        await appDbExecute(`
          UPDATE user_tags SET is_primary = 1
          WHERE app_user_id = ?
            AND is_active = 1
            AND tag_type = 'system'
          LIMIT 1
        `, [userId]);
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);


export default router;
