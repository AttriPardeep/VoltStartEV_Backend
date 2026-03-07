// src/routes/users.routes.ts
import { Router, Request, Response } from 'express';
import { steveQuery } from '../config/database.js';
import { appDbQuery, appDbExecute } from '../config/database.js';
import { steveRepository } from '../repositories/steve-repository.js';
import logger from '../config/logger.js';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { steveApiService } from '../services/steve/steve-api.service.js';
import { authenticateJwt } from '../middleware/auth.middleware.js';

const router = Router();

// ─────────────────────────────────────────────────────
// USER MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────

// POST /api/users - Register new user
router.post('/', async (req: Request, res: Response) => {
  try {
    const { username, email, password, firstName, lastName, phone } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'username, email, and password are required'
      });
    }
    
    // Check if user already exists (SELECT returns array)
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
    
    // Insert new user (INSERT returns ResultSetHeader)
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
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const jwtOptions: SignOptions = { 
      expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any 
    };
    
    const token = jwt.sign(
      { id: userId, username, role: 'customer' },
      jwtSecret,
      jwtOptions
    );
    
    logger.info(`✅ User registered: ${username} (ID: ${userId})`);
    
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
    const { username, email, password } = req.body;
    
    if ((!username && !email) || !password) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'username or email, and password are required'
      });
    }
    
    // Find user (SELECT returns array)
    const userRows = await appDbQuery(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username || email, username || email]
    );
    const user = Array.isArray(userRows) ? userRows[0] : userRows;
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid credentials'
      });
    }
    
    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
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
        message: 'Account is disabled'
      });
    }
    
    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const jwtOptions: SignOptions = { 
      expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any 
    };
    
    const token = jwt.sign(
      { id: user.user_id, username: user.username, role: user.role || 'customer' },
      jwtSecret,
      jwtOptions
    );
    
    logger.info(`✅ User logged in: ${user.username}`);
    
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
    
  } catch (error: any) {
    logger.error('Failed to login user', { error });
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

// GET /api/users/:userId/tags - Get tags assigned to a specific user

router.post('/:userId/tags', async (req: Request, res: Response) => {
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
    
    // ✅ PRODUCTION: Use SteVe REST API to verify tag exists (NO auto-provisioning)
    const tagResult = await steveApiService.getTagByIdTag(idTag);
    
    if (!tagResult.success || !Array.isArray(tagResult.data) || tagResult.data.length === 0) {
      logger.warn(`❌ Tag not found in SteVe: ${idTag}`);
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Tag ${idTag} does not exist in SteVe. Please provision it via SteVe admin UI first.`,
        timestamp: new Date().toISOString()
      });
    }
    
    const ocppTagPk = tagResult.data[0].ocppTagPk;
    
    // ✅ ENFORCE 1:1 MAPPING: Check if tag is already assigned to a DIFFERENT user
    const [existingLink] = await steveQuery(
      'SELECT user_pk FROM user_ocpp_tag WHERE ocpp_tag_pk = ? LIMIT 1',
      [ocppTagPk]
    );
    
    if (existingLink && existingLink.user_pk !== userId) {
      logger.warn(`❌ Tag ${idTag} already assigned to user ${existingLink.user_pk}, cannot assign to ${userId}`);
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: `Tag ${idTag} is already assigned to user ${existingLink.user_pk}. Unassign it first via admin endpoint.`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Link user to tag in user_ocpp_tag table
    await steveQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE updated_at = NOW()
    `, [userId, ocppTagPk]);
    
    logger.info(`✅ Tag ${idTag} assigned to user ${userId}`);
    
    res.status(201).json({
      success: true,
      message: 'Tag assigned successfully',
      data: { 
        userId, 
        idTag, 
        nickname,
        ocppTagPk
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    logger.error('Failed to assign tag', { error });
    
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

// POST /api/users/:userId/tags - Assign tag to user
router.post('/:userId/tags', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const { idTag, nickname } = req.body;
    
    if (!idTag) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'idTag is required'
      });
    }
    
    // Ensure tag exists in SteVe
    const tagRows = await steveQuery(
      'SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1',
      [idTag]
    );
    const tag = Array.isArray(tagRows) ? tagRows[0] : tagRows;
    
    if (!tag) {
      // Auto-provision tag
      await steveRepository.upsertTag({
        idTag,
        maxActiveTransactions: 1,
        note: nickname || 'Provisioned by VoltStartEV'
      });
      logger.info(`🏷️ Auto-provisioned tag: ${idTag}`);
    }
    
    // Link user to tag
    await steveQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, (SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1))
      ON DUPLICATE KEY UPDATE updated_at = NOW()
    `, [userId, idTag]);
    
    logger.info(`✅ Tag ${idTag} assigned to user ${userId}`);
    
    res.status(201).json({
      success: true,
      message: 'Tag assigned successfully',
      data: { userId, idTag, nickname }
    });
    
  } catch (error: any) {
    logger.error('Failed to assign tag', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/users/:userId/tags/:idTag - Remove tag from user
router.delete('/:userId/tags/:idTag', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const idTag = req.params.idTag;
    
    await steveQuery(`
      DELETE uot FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE uot.user_pk = ? AND ot.id_tag = ?
    `, [userId, idTag]);
    
    logger.info(`🗑️ Tag ${idTag} removed from user ${userId}`);
    
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

    // Get tag PK
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

    logger.info(`🗑️ Tag ${idTag} unassigned from all users`);

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
router.get('/tags', async (req: Request, res: Response) => {
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
router.get('/tags/:idTag/assignment', async (req: Request, res: Response) => {
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


router.post('/:userId/tags', async (req: Request, res: Response) => {
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

    // ✅ PRODUCTION: Use SteVe REST API to ensure tag exists
    // This replaces direct DB writes to ocpp_tag
    const tagResult = await steveApiService.getOrCreateTag(idTag, {
      maxActiveTransactionCount: maxActiveTransactions || 1,
      expiryDate: expiryDate ? new Date(expiryDate).toISOString() : undefined,
      note: nickname || 'Provisioned by VoltStartEV app',
    });

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
    if (ocppTagPk) {
      // Check if tag is already assigned to a DIFFERENT user
      const [existingLink] = await steveQuery(
        'SELECT user_pk FROM user_ocpp_tag WHERE ocpp_tag_pk = ? LIMIT 1',
        [ocppTagPk]
     );

     if (existingLink && existingLink.user_pk !== userId) {
       return res.status(409).json({
       success: false,
       error: 'Conflict',
       message: `Tag ${idTag} is already assigned to user ${existingLink.user_pk}. Unassign it first.`,
       timestamp: new Date().toISOString()
       });
      }
   }   
    logger.info(`✅ Tag provisioned via SteVe API: ${idTag} (PK: ${ocppTagPk})`);

    // Link user to tag in user_ocpp_tag table (this table is safe to write)
    // Note: user_ocpp_tag.user_pk refers to VoltStartEV app user ID, not SteVe user
    await steveQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE updated_at = NOW()
    `, [userId, ocppTagPk]);

    logger.info(`✅ Tag ${idTag} assigned to user ${userId}`);

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

export default router;
