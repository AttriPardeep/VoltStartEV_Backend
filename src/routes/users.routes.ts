// src/routes/users.routes.ts
import { Router, Request, Response } from 'express';
import { steveQuery } from '../config/database.js';
import { appDbQuery, appDbExecute } from '../config/database.js';
import { steveRepository } from '../repositories/steve-repository.js';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { steveApiService } from '../services/steve/steve-api.service.js';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import validator from 'validator';

import logger from '../config/logger.js';

const router = Router();

// ─────────────────────────────────────────────────────
// USER MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────

// POST /api/users - Register new user
router.post('/', async (req: Request, res: Response) => {
  try {
    const { username, email, password, firstName, lastName, phone } = req.body;

    // Validate required fields first
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
    
    // Check if user already exists
    const existingRows = await appDbQuery(
      'SELECT user_id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    const existing = Array.isArray(existingRows) ? existingRows[0] : existingRows;
    
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Username or email already registered'
      });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Insert new user
    const insertResult = await appDbExecute(`
      INSERT INTO users (username, email, password_hash, first_name, last_name, phone, is_active, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, TRUE, FALSE)
    `, [username, email, passwordHash, firstName || null, lastName || null, phone || null]);
    
    // Handle both possible return formats
    const header = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    const userId = header?.insertId;
    
    if (!userId) {
      throw new Error('Failed to retrieve inserted user ID');
    }
    
    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }
    
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
    
    const token = jwt.sign(
      { id: userId, username, role: 'customer' },
      jwtSecret,
      { expiresIn: jwtExpiresIn as jwt.SignOptions['expiresIn'] }
    );
    
    logger.info(` User registered: ${username} (ID: ${userId})`);
    
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: { userId, username, email, token }
    });
    
  } catch (error: any) {
    logger.error('Failed to register user', { error });
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
    
    // Find user by username (trim whitespace)
    const queryResult = await appDbQuery(
      'SELECT * FROM users WHERE username = ? LIMIT 1',
      [username.trim()]
    );
    
    // Handle different return formats from appDbQuery
    let user: any = null;
    if (Array.isArray(queryResult) && queryResult.length > 0) {
      // SELECT query returned [rows]
      user = queryResult[0];
    } else if (queryResult && typeof queryResult === 'object' && 'user_id' in queryResult) {
      // SELECT query returned single row object (some MySQL drivers do this)
      user = queryResult;
    }
    // else: user remains null → will return 401 below
    
    logger.debug('Login attempt - DB query result', {
      username,
      queryResultType: typeof queryResult,
      queryResultIsArray: Array.isArray(queryResult),
      userFound: !!user,
      userId: user?.user_id,
      passwordHashPreview: user?.password_hash?.substring(0, 20) + '...'
    });
    
    if (!user) {
      // Security: Don't reveal if user exists or not
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
    
    // Safely compare password - ensure password_hash exists
    if (!user.password_hash) {
      logger.error('User record missing password_hash', { userId: user.user_id });
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: 'Unable to authenticate. Please contact support.'
      });
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    logger.debug('Password comparison result', { match: passwordMatch });
    
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }
    
    const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
    
    const token = jwt.sign(
      { id: user.user_id, username: user.username, role: 'customer' },
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
          lastName: user.last_name
        }
      }
    });
    
  } catch (error) {
    // FIX: Properly serialize error for logging
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

    let tagResult;

    // Handle strict mode vs auto-provisioning
    if (req.query.strict === 'true') {
      // Strict mode: fail if tag doesn't exist
      tagResult = await steveApiService.getTagByIdTag(idTag);
      if (!tagResult.success || !Array.isArray(tagResult.data) || tagResult.data.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Not found',
          message: `Tag ${idTag} does not exist in SteVe`,
          timestamp: new Date().toISOString()
        });
      }
      // Extract ocppTagPk from array response
      tagResult = { success: true, data: tagResult.data[0] };
    } else {
      // Default: auto-provision if missing
      tagResult = await steveApiService.getOrCreateTag(idTag, {
        maxActiveTransactionCount: maxActiveTransactions || 1,
        expiryDate: expiryDate ? new Date(expiryDate).toISOString() : undefined,
        note: nickname || 'Provisioned by VoltStartEV app',
      });
    }

    if (!tagResult.success || !tagResult.data) {
      logger.error('❌ Failed to provision tag via SteVe API', {
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
    
    // ✅ Check if tag is already assigned to ANY user
    const [existingLink] = await steveQuery(
      'SELECT user_pk FROM user_ocpp_tag WHERE ocpp_tag_pk = ? LIMIT 1',
      [ocppTagPk]
    );

    if (existingLink) {
      // Tag IS already assigned to someone
      if (existingLink.user_pk !== userId) {
        // Assigned to DIFFERENT user → Reject with 409
        logger.warn(`Tag ${idTag} already assigned to user ${existingLink.user_pk}, cannot assign to ${userId}`);
        return res.status(409).json({
          success: false,
          error: 'Conflict',
          message: `Tag ${idTag} is already assigned to user ${existingLink.user_pk}. Unassign it first.`,
          timestamp: new Date().toISOString()
        });
      } else {
        // Assigned to SAME user → Idempotent success (no need to re-insert)
        logger.info(`Tag ${idTag} already assigned to user ${userId} (idempotent)`);
        return res.status(200).json({
          success: true,
          message: 'Tag already assigned',
          data: { userId, idTag, nickname }  // ✅ Added 'data' key
        });
      }
    }
    
    // ✅ If we get here, tag is NOT assigned to anyone → Insert new linkage
    // ✅ FIX: Removed duplicate INSERT, keep only this one
    await steveQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, ?)
    `, [userId, ocppTagPk]);

    logger.info(`✅ Tag ${idTag} assigned to user ${userId}`);

    res.status(201).json({
      success: true,
      message: 'Tag assigned successfully',
      data: {  // ✅ FIX: Added 'data' key
        userId,
        idTag,
        nickname,
        ocppTagPk,
        provisionedVia: 'steve-api'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error('Failed to assign tag', { error });

    // Handle specific API errors
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

// DELETE /api/users/:userId/tags/:idTag - Remove tag from user
router.delete('/:userId/tags/:idTag', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const idTag = req.params.idTag;

    await steveQuery(`
      DELETE uot FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE uot.user_pk = ? AND ot.id_tag = ?
    `, [userId, idTag]);

    logger.info(` Tag ${idTag} removed from user ${userId}`);

    res.status(200).json({
      success: true,
      message: 'Tag removed successfully'
    });

  } catch (error: any) {
    logger.error('Failed to remove tag', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/admin/tags/:idTag/unassign - Unassign tag from any user (admin only)
router.post('/admin/tags/:idTag/unassign', authenticateJwt, async (req: Request, res: Response) => {
  // TODO: Add admin role check: if ((req as any).user?.role !== 'admin') return res.status(403)...

  try {
    const idTag = req.params.idTag;

    // Get tag PK via SteVe API
    const tagResult = await steveApiService.getTagByIdTag(idTag);
    if (!tagResult.success || !Array.isArray(tagResult.data) || tagResult.data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Tag ${idTag} not found in SteVe`,
        timestamp: new Date().toISOString()
      });
    }

    const ocppTagPk = tagResult.data[0].ocppTagPk;

    // Remove linkage
    await steveQuery(
      'DELETE FROM user_ocpp_tag WHERE ocpp_tag_pk = ?',
      [ocppTagPk]
    );

    logger.info(` Tag ${idTag} unassigned from all users`);

    res.status(200).json({
      success: true,
      message: `Tag ${idTag} unassigned successfully`,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error('Failed to unassign tag', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'Unable to unassign tag.',
      timestamp: new Date().toISOString()
    });
  }
});

// ─────────────────────────────────────────────────────
// TAG LOOKUP ENDPOINTS
// ─────────────────────────────────────────────────────

// GET /api/tags - List all tags with assignment status
router.get('/tags', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const tags = await steveQuery(`
      SELECT ot.ocpp_tag_pk, ot.id_tag, ot.expiry_date, ot.max_active_transaction_count,
             ota.blocked, ota.active_transaction_count, uot.user_pk AS assigned_to_user
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
    logger.error('Failed to fetch tags', { error });
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

    const assignmentRows = await steveQuery(`
      SELECT uot.user_pk AS app_user_id, ot.id_tag AS rfid_tag,
             ot.expiry_date, ota.blocked, uot.created_at AS assigned_at
      FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE ot.id_tag = ?
      LIMIT 1
    `, [idTag]);

    const assignment = Array.isArray(assignmentRows) ? assignmentRows[0] : assignmentRows;

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
    logger.error('Failed to fetch tag assignment', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/users/me - Get current user profile
router.get('/me', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    const [user] = await appDbQuery(
      'SELECT user_id, username, email, first_name, last_name FROM users WHERE user_id = ?',
      [userId]
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error: any) {
    logger.error('Failed to fetch user profile', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
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

    const [user] = await appDbQuery(
      'SELECT user_id, username, email, first_name, last_name FROM users WHERE user_id = ?',
      [requestedUserId]
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error: any) {
    logger.error('Failed to fetch user', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

export default router;
