# VoltStartEV Backend - System Design Document

**Version:** 1.1  
**Last Updated:** March 5, 2026  
**Status:** Production Ready ✅  
**Target SteVe Version:** v3.11.0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Database Schema](#3-database-schema)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [API Endpoints](#5-api-endpoints)
6. [Charging Flows](#6-charging-flows)
7. [Tag Management](#7-tag-management)
8. [Billing & Session History](#8-billing--session-history)
9. [Real-Time Updates](#9-real-time-updates)
10. [Security Considerations](#10-security-considerations)
11. [Deployment & Configuration](#11-deployment--configuration)
12. [Operational Runbook](#12-operational-runbook)
13. [Appendices](#13-appendices)

---

## 1. Executive Summary

VoltStartEV is an EV charging management platform that provides:
- **App-initiated charging** via REST API with JWT authentication
- **Physical RFID tag charging** via OCPP 1.6 protocol (direct charger → SteVe flow)
- **Real-time session monitoring** via WebSocket push notifications
- **Billing and session history** tracking with reconciliation for offline sessions
- **User↔Tag authorization** for enhanced security (app users can only use assigned tags)

### Key Design Decisions

| Decision | Rationale | Implementation Status |
|----------|-----------|---------------------|
| **Service Account Pattern** | SteVe acts as device manager; VoltStartEV backend handles user authentication and business logic | ✅ Implemented |
| **Dual Charging Flows** | Support both physical RFID cards and mobile app control with independent authorization paths | ✅ Implemented |
| **User↔Tag Validation** | Prevent unauthorized app users from using tags not assigned to them via `user_ocpp_tag` linkage | ✅ Implemented |
| **Repository Pattern for SteVe Access** | Isolate SteVe-specific SQL to enable future schema changes without breaking business logic | ✅ Implemented |
| **Transaction ID Polling Bridge** | Handle delay between RemoteStart command and actual transaction ID assignment | ✅ Implemented |
| **Idempotent Stop Logic** | Handle race conditions where session ends naturally before stop command arrives | ✅ Implemented |
| **Reconciliation Worker** | Catch offline/deferred transactions to ensure no revenue loss | ✅ Implemented |

### Four Critical Concerns Addressed

| Concern | Solution | Section |
|---------|----------|---------|
| **Transaction ID Gap** | Frontend polls `/session/active?idTag=X` or waits for WebSocket event to get real transactionId | [6.1](#61-flow-1-app-initiated-charging) |
| **Direct DB Access Tight Coupling** | All SteVe SQL isolated in `src/repositories/steve-repository.ts` with TypeScript interfaces | [7.1](#71-tag-provisioning-workflow) |
| **Race Conditions on Stop** | Idempotent stop logic with double-check; optimistic UI on frontend | [5.1.2](#post-apichargingstop) |
| **Offline/Sync Issues** | Background reconciliation job with UNIQUE constraint on `steve_transaction_pk` | [8.3](#83-reconciliation-worker-handling-offlinedeferred-transactions) |

---

## 2. Architecture Overview

### 2.1 System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         VoltStartEV System                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐ │
│  │ Mobile App   │───▶│ VoltStartEV      │───▶│ SteVe OCPP   │ │
│  │ (React/      │    │ Backend          │    │ Server       │ │
│  │  Flutter)    │    │ (Node.js/TS)     │    │ (Java v3.11) │ │
│  └──────────────┘    └──────────────────┘    └──────┬───────┘ │
│         │                    │                      │          │
│         │ JWT Auth           │ Basic Auth           │ OCPP 1.6 │
│         │                    │ (Service Account)    │ JSON/SOAP│
│         │                    │                      │          │
│         ▼                    ▼                      ▼          │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐ │
│  │ VoltStartEV  │    │ SteVe DB         │    │ Chargers     │ │
│  │ App DB       │    │ (MySQL 8.0)      │    │ (SAP Sim/    │ │
│  │ (Users,      │    │ • ocpp_tag       │    │  Physical)   │ │
│  │  Sessions,   │    │ • user_ocpp_tag  │    │              │ │
│  │  Billing)    │    │ • charge_box     │    │              │ │
│  └──────────────┘    │ • transaction_*  │    └──────────────┘ │
│                      └──────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Service Account Pattern

**Principle**: VoltStartEV backend authenticates to SteVe using a single service account, not individual user credentials.

| Component | Credentials | Purpose | Storage |
|-----------|------------|---------|---------|
| **Mobile App User** | JWT token (issued by VoltStartEV) | Authenticate to VoltStartEV backend | Signed with `JWT_SECRET` |
| **VoltStartEV Backend** | Basic Auth: `voltstart_backend:ServiceSecretKey_2026!` | Call SteVe REST API | `.env` file (never committed) |
| **SteVe Server** | `web_user` table (`api_password` BCrypt-hashed) | Authenticate REST API calls | SteVe DB (`web_user` table) |
| **OCPP Charger** | WebSocket session + OCPP auth | Execute charging commands | Charger config + SteVe `charge_box` table |

> 🔑 **Critical**: The `api_password` field in SteVe's `web_user` table requires a **BCrypt hash**. SteVe hashes the input from HTTP Basic Auth and compares it to the stored hash.

**Benefits**:
- ✅ SteVe never sees VoltStartEV app users — clear separation of concerns
- ✅ Centralized user management in VoltStartEV (authentication, profiles, billing)
- ✅ Simplified credential rotation (one service account vs. thousands of user accounts)
- ✅ Easier auditing: all SteVe API calls logged with service account identity

---

## 3. Database Schema

### 3.1 SteVe Database (`stevedb`) — Read-Only Access

> ⚠️ **Important**: VoltStartEV backend connects to `stevedb` with **SELECT-only permissions** for polling and validation. All writes to SteVe tables go through SteVe's REST API or OCPP protocol.

#### Core Tables (Relevant to VoltStartEV)

| Table | Purpose | Key Columns | VoltStartEV Usage |
|-------|---------|-------------|------------------|
| `charge_box` | Registered charging stations | `charge_box_pk`, `charge_box_id` (UNIQUE), `registration_status`, `ocpp_protocol`, `last_heartbeat_timestamp` | Check charger availability, get connector status |
| `connector` | Individual connectors per charger | `connector_pk`, `charge_box_id`, `connector_id`, `connector_status` | Validate connector exists before starting session |
| `connector_status` | Real-time connector state | `connector_pk`, `status_timestamp`, `status`, `error_code` | Poll for charger status changes |
| `ocpp_tag` | RFID/App tags for authorization | `ocpp_tag_pk`, `id_tag` (UNIQUE), `expiry_date`, `max_active_transaction_count`, `note` | Validate tag exists, not expired, under concurrent limit |
| `ocpp_tag_activity` | Real-time tag status counters | `ocpp_tag_pk`, `active_transaction_count`, `in_transaction`, `blocked` | Check if tag is blocked or at max concurrent sessions |
| `user` | SteVe internal users (operators/admins) | `user_pk`, `first_name`, `last_name`, `e_mail` | Optional: link VoltStartEV app users for SteVe UI display |
| `user_ocpp_tag` | Link SteVe users to OCPP tags | `user_pk`, `ocpp_tag_pk` (composite PK) | **Critical**: VoltStartEV app user ↔ OCPP tag linkage for authorization |
| `web_user` | Web UI + REST API authentication | `web_user_pk`, `username` (UNIQUE), `password` (BCrypt), `api_password` (BCrypt), `authorities` (JSON) | Service account authentication for REST API calls |
| `transaction_start` | Transaction initiation records | `transaction_pk` (PK), `connector_pk`, `id_tag`, `start_timestamp`, `start_value` | **Critical**: Poll for real transactionId after RemoteStart command |
| `transaction_stop` | Transaction completion records | `transaction_pk` (PK), `event_timestamp` (PK), `stop_timestamp`, `stop_value`, `stop_reason` | Detect session end for billing completion |
| `transaction` | Combined transaction view | `transaction_pk`, `start_timestamp`, `stop_timestamp`, `id_tag`, `start_value`, `stop_value` | Historical queries, reporting |
| `reservation` | Reserved charging sessions | `reservation_pk`, `connector_pk`, `id_tag`, `start_datetime`, `expiry_datetime`, `status` | Future: support advance booking |

#### Key Relationships

```sql
-- User↔Tag Linkage (for VoltStartEV app security)
-- This table links VoltStartEV app user IDs to SteVe OCPP tags
-- VoltStartEV backend validates: "Can app user X use tag Y?"
CREATE TABLE user_ocpp_tag (
  user_pk INT NOT NULL COMMENT 'VoltStartEV app user ID (NOT SteVe web_user.user_pk)',
  ocpp_tag_pk INT NOT NULL COMMENT 'SteVe ocpp_tag primary key',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_pk, ocpp_tag_pk),
  FOREIGN KEY (ocpp_tag_pk) REFERENCES ocpp_tag(ocpp_tag_pk) ON DELETE CASCADE,
  INDEX idx_ocpp_tag_pk (ocpp_tag_pk),
  INDEX idx_user_pk (user_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> 🔑 **Note**: The `user_pk` in `user_ocpp_tag` refers to **VoltStartEV app user IDs**, NOT SteVe's `user.user_pk`. This allows VoltStartEV to manage its own user base while leveraging SteVe's OCPP tag infrastructure.

### 3.2 VoltStartEV App Database (`voltstartev_db`) — Read/Write Access

#### Billing & Session History

```sql
CREATE TABLE charging_sessions (
  session_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  
  -- User & Transaction Linkage
  app_user_id INT NOT NULL COMMENT 'VoltStartEV user ID (from users table)',
  steve_transaction_pk INT COMMENT 'SteVe transaction primary key (for reconciliation)',
  
  -- Charger Details
  charge_box_id VARCHAR(64) NOT NULL,
  connector_id INT NOT NULL,
  id_tag VARCHAR(64) NOT NULL COMMENT 'RFID/App tag used (matches SteVe ocpp_tag.id_tag)',
  
  -- Timing
  start_time DATETIME NOT NULL,
  end_time DATETIME NULL,
  duration_seconds INT GENERATED ALWAYS AS (
    CASE 
      WHEN end_time IS NOT NULL THEN TIMESTAMPDIFF(SECOND, start_time, end_time)
      ELSE NULL 
    END
  ) STORED,
  
  -- Energy & Cost Calculation
  start_meter_value DECIMAL(12,2) COMMENT 'Wh at start (from SteVe transaction_start.start_value)',
  end_meter_value DECIMAL(12,2) COMMENT 'Wh at end (from SteVe transaction_stop.stop_value)',
  energy_kwh DECIMAL(10,3) GENERATED ALWAYS AS (
    CASE 
      WHEN end_meter_value IS NOT NULL AND start_meter_value IS NOT NULL 
      THEN ROUND((end_meter_value - start_meter_value) / 1000, 3)
      ELSE NULL 
    END
  ) STORED,
  
  rate_per_kwh DECIMAL(8,4) DEFAULT 0.2500 COMMENT 'USD/kWh (configurable per user/region)',
  session_fee DECIMAL(8,2) DEFAULT 0.50 COMMENT 'Flat fee per session',
  total_cost DECIMAL(10,2) GENERATED ALWAYS AS (
    CASE 
      WHEN energy_kwh IS NOT NULL 
      THEN ROUND((energy_kwh * rate_per_kwh) + session_fee, 2)
      ELSE NULL 
    END
  ) STORED,
  
  -- Status & Metadata
  status ENUM('active', 'completed', 'failed', 'cancelled') DEFAULT 'active',
  stop_reason VARCHAR(64) COMMENT 'OCPP stop reason: Remote, Local, EVDisconnected, PowerLoss, etc.',
  payment_status ENUM('pending', 'paid', 'failed', 'refunded') DEFAULT 'pending',
  payment_method VARCHAR(32) COMMENT 'card, wallet, invoice, etc.',
  
  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Indexes for performance
  INDEX idx_user_id (app_user_id),
  INDEX idx_charge_box (charge_box_id),
  INDEX idx_start_time (start_time),
  INDEX idx_status (status),
  
  -- UNIQUE constraint for reconciliation (prevents duplicate billing for same SteVe transaction)
  UNIQUE KEY uniq_steve_transaction_pk (steve_transaction_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### Users Table (Optional — If Managing App Users Locally)

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Authentication
  username VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL COMMENT 'BCrypt hash',
  
  -- Profile
  first_name VARCHAR(64),
  last_name VARCHAR(64),
  phone VARCHAR(20),
  
  -- Account Status
  is_active BOOLEAN DEFAULT TRUE,
  is_verified BOOLEAN DEFAULT FALSE,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Indexes
  INDEX idx_email (email),
  INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> ⚠️ **Note**: If you use an external identity provider (Auth0, Cognito, etc.), this table may be omitted. The `app_user_id` in `charging_sessions` would then reference your external user ID.

---

## 4. Authentication & Authorization

### 4.1 VoltStartEV Backend → SteVe Authentication

**Method**: HTTP Basic Auth  
**Credentials**: Service account stored in environment variables (never in code)

```bash
# .env file (example — never commit to version control)
STEVE_API_URL=http://localhost:8080/steve
STEVE_API_USER=voltstart_backend
STEVE_API_PASS=ServiceSecretKey_2026!  # Plain text in env; SteVe hashes internally via BCrypt
```

**SteVe Configuration** (run once during setup):
```sql
-- Create service account in SteVe web_user table
-- Both password and api_password require BCrypt hashes
INSERT INTO web_user (username, password, api_password, enabled, authorities)
VALUES (
  'voltstart_backend', 
  '$2a$10$<BCrypt-hash-of-web-password>',  -- For emergency web UI login (optional)
  '$2a$10$<BCrypt-hash-of-api-password>',  -- For REST API authentication (REQUIRED)
  1, 
  CAST('["ROLE_ADMIN","ROLE_API"]' AS JSON)
);
```

> 🔑 **Critical**: 
> - Both `password` and `api_password` fields in `web_user` require **BCrypt hashes**
> - SteVe hashes the input from HTTP Basic Auth and compares it to the stored hash
> - Use a BCrypt generator (e.g., `bcrypt` npm package) to create hashes; do NOT use plain text

**Generating BCrypt Hashes** (Node.js example):
```javascript
const bcrypt = require('bcrypt');
const saltRounds = 10;

// For api_password (used in REST API Basic Auth)
const apiPassword = 'ServiceSecretKey_2026!';
bcrypt.hash(apiPassword, saltRounds, (err, hash) => {
  if (err) throw err;
  console.log('BCrypt hash for api_password:', hash);
  // Use this hash in the INSERT statement above
});
```

### 4.2 Mobile App → VoltStartEV Backend Authentication

**Method**: JWT Bearer Token  
**Payload Structure**:
```typescript
interface JwtPayload {
  id: number;        // App user ID (e.g., 101) — used for user↔tag validation
  username: string;  // App username (e.g., 'user101') — for logging/audit
  role: string;      // App role (e.g., 'customer', 'admin') — for authorization
  iat: number;       // Issued at timestamp
  exp: number;       // Expiration timestamp
}
```

**Middleware Implementation** (`src/middleware/auth.middleware.ts`):
```typescript
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger.js';

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export const authenticateJwt = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  // Skip auth in development mode for easier testing
  if (process.env.NODE_ENV === 'development' && !req.headers.authorization) {
    req.user = { id: 101, username: 'test-user', role: 'customer', iat: Date.now(), exp: Date.now() + 3600000 };
    return next();
  }
  
  // Extract and verify JWT
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required', message: 'Missing Bearer token' });
  }
  
  const token = authHeader.substring(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    
    // Optional: Check expiration explicitly (jwt.verify does this, but extra safety)
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return res.status(401).json({ error: 'Token expired' });
    }
    
    req.user = payload;
    next();
  } catch (error) {
    logger.warn('JWT verification failed', { error: error instanceof Error ? error.message : error });
    return res.status(401).json({ error: 'Invalid token' });
  }
};
```

### 4.3 User↔Tag Authorization (App-Initiated Flow Security)

**Purpose**: Ensure app users can only use RFID tags assigned to them via the `user_ocpp_tag` linkage table.

**Validation Flow** (`src/services/ocpp/auth.service.ts`):
```typescript
import { steveRepository } from '../../repositories/steve-repository.js';
import { AuthorizationStatusSchema } from '../../types/ocpp-1.6';
import { z } from 'zod';

export interface AuthorizationResult {
  status: z.infer<typeof AuthorizationStatusSchema>; // 'Accepted' | 'Blocked' | 'Expired' | 'ConcurrentTx' | 'Invalid' | 'Unknown'
  expiryDate?: string;
  parentIdTag?: string;
  reason?: string;
  userPk?: number; // SteVe user_pk if tag is linked to a SteVe user (for UI display)
  maxActiveTransactions?: number;
  activeTransactionCount?: number;
}

/**
 * Validate that a specific app user is authorized to use this RFID/App tag
 * Checks: (1) tag validity in SteVe, (2) user↔tag linkage in user_ocpp_tag
 */
export async function validateIdTagForUser(
  idTag: string, 
  appUserId: number // VoltStartEV app user ID
): Promise<AuthorizationResult> {
  // 1. Validate the tag itself (expiry, blocked, concurrent tx) via repository
  const tagValidation = await validateIdTag(idTag);
  if (tagValidation.status !== 'Accepted') {
    return tagValidation;
  }
  
  // 2. Check if this app user is linked to this tag via user_ocpp_tag table
  const isLinked = await steveRepository.isUserTagLinked(appUserId, idTag);
  
  if (!isLinked) {
    return { 
      status: 'Invalid', 
      reason: `RFID tag ${idTag} is not assigned to your account`,
      userPk: tagValidation.userPk
    };
  }
  
  return {
    ...tagValidation,
    status: 'Accepted' // Explicitly confirm acceptance after user check
  };
}

/**
 * Validate RFID/App token against SteVe's ocpp_tag + ocpp_tag_activity tables
 * Implements OCPP 1.6 AuthorizationStatus logic per spec Section 4.2
 */
export async function validateIdTag(idTag: string): Promise<AuthorizationResult> {
  try {
    const tagDetails = await steveRepository.getTagDetails(idTag);
    
    if (!tagDetails) {
      return { status: 'Invalid', reason: 'Unknown identifier' };
    }
    
    if (tagDetails.blocked) {
      return { status: 'Blocked', reason: 'Tag administratively blocked' };
    }
    
    if (tagDetails.expired) {
      return { 
        status: 'Expired', 
        expiryDate: tagDetails.expiryDate,
        reason: 'Tag expiry date passed'
      };
    }
    
    if (tagDetails.activeTransactionCount >= tagDetails.maxActiveTransactions) {
      return { 
        status: 'ConcurrentTx',
        reason: `Max ${tagDetails.maxActiveTransactions} concurrent sessions allowed`
      };
    }
    
    return {
      status: 'Accepted',
      userPk: tagDetails.userPk,
      expiryDate: tagDetails.expiryDate,
      parentIdTag: tagDetails.parentIdTag,
      maxActiveTransactions: tagDetails.maxActiveTransactions,
      activeTransactionCount: tagDetails.activeTransactionCount
    };
    
  } catch (error) {
    logger.error('Error validating idTag', { 
      idTag, 
      error: error instanceof Error ? error.message : error 
    });
    // Fail closed for security: never authorize on DB error
    return { status: 'Invalid', reason: 'System error during validation' };
  }
}
```

> 🔑 **Security Note**: This validation runs **before** calling SteVe's REST API. If validation fails, the request is rejected with `403 Forbidden` — no call is made to SteVe, reducing attack surface.

---

## 5. API Endpoints

### 5.1 Charging Session Management

#### POST `/api/charging/start`

**Purpose**: Initiate charging session via mobile app (app-initiated flow)

**Request**:
```json
{
  "chargeBoxId": "CS-SIEMENS-00001",
  "connectorId": 1,
  "idTag": "USER001"
}
```

**Headers**:
```
Authorization: Bearer <JWT-token>
Content-Type: application/json
```

**Response (Success — 202 Accepted)**:
```json
{
  "success": true,
  "message": "Charging session initiated",
  "data": {
    "transactionId": 0,
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "estimatedStartTime": "2026-03-05T12:11:00.514Z"
  },
  "timestamp": "2026-03-05T12:10:30.514Z"
}
```

> ⚠️ **Transaction ID Gap Notice**: The `transactionId: 0` is a placeholder. The real transaction ID is only assigned when the charger sends `StartTransaction` to SteVe (typically 5-10 seconds later). See [Frontend Handling of Transaction ID Gap](#frontend-handling-of-transaction-id-gap) below.

**Response (Error — Unauthorized Tag)**:
```json
{
  "success": false,
  "error": "Authorization failed",
  "message": "RFID tag USER001 is not assigned to your account",
  "timestamp": "2026-03-05T12:10:30.514Z"
}
```

**Validation Sequence**:
1. ✅ JWT authentication (`authenticateJwt` middleware)
2. ✅ Required fields present (`chargeBoxId`, `connectorId`, `idTag`)
3. ✅ Charger status = `'Available'` (query `stevedb.connector_status`)
4. ✅ User↔Tag linkage exists (`user_ocpp_tag` table via `validateIdTagForUser`)
5. ✅ Tag not blocked/expired/over concurrent limit (`ocpp_tag` + `ocpp_tag_activity`)
6. ✅ Call SteVe REST API with service account Basic Auth
7. ✅ Return `202 Accepted` with placeholder `transactionId: 0`

#### Frontend Handling of Transaction ID Gap

> ⚠️ **Critical UX Note**: The `transactionId: 0` returned in the start response is a placeholder. The real transaction ID is only assigned when the charger sends `StartTransaction` to SteVe.

**Frontend Behavior**:
1. After receiving `transactionId: 0`, the UI should:
   - Display "Initiating charging session..."
   - Disable the "Stop" button (prevent premature stop attempts)
   - Poll `GET /api/charging/session/active?idTag=USER001` every 3 seconds **OR** listen for WebSocket event
2. When the polling endpoint returns `status: 'active'` with a real `transactionId`:
   - Update UI to "Charging"
   - Enable the "Stop" button with the real `transactionId`
3. Alternatively, listen for the `transaction:started` WebSocket event (see [Section 9](#9-real-time-updates)) to get the real ID immediately.

**Backend Endpoint**: `GET /api/charging/session/active`
- Queries `stevedb.transaction_start` for recent transactions with the given `idTag`
- Returns `status: 'pending'` while waiting, `status: 'active'` with real `transactionId` when found
- Timeout: 60 seconds (configurable via `POLLING_TIMEOUT_SECONDS` env var)

**Example Polling Response (Pending)**:
```json
{
  "success": true,
  "data": { "status": "pending", "message": "Waiting for charger to start session" },
  "timestamp": "2026-03-05T12:10:33.000Z"
}
```

**Example Polling Response (Active)**:
```json
{
  "success": true,
  "data": {
    "status": "active",
    "transactionId": 215,
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "startTime": "2026-03-05T12:10:35.000Z"
  },
  "timestamp": "2026-03-05T12:10:36.000Z"
}
```

#### POST `/api/charging/stop`

**Purpose**: Stop active charging session (app-initiated flow)

**Request**:
```json
{
  "chargeBoxId": "CS-SIEMENS-00001",
  "transactionId": 215
}
```

**Headers**:
```
Authorization: Bearer <JWT-token>
Content-Type: application/json
```

**Response (Success — 202 Accepted)**:
```json
{
  "success": true,
  "message": "Stop command sent to charger",
  "data": {
    "transactionId": 215,
    "chargeBoxId": "CS-SIEMENS-00001",
    "alreadyStopped": false
  },
  "timestamp": "2026-03-05T12:12:01.479Z"
}
```

**Response (Already Stopped — 202 Accepted)**:
```json
{
  "success": true,
  "message": "Session already finished",
  "data": {
    "transactionId": 215,
    "chargeBoxId": "CS-SIEMENS-00001",
    "alreadyStopped": true
  },
  "timestamp": "2026-03-05T12:12:01.479Z"
}
```

#### Idempotent Stop Logic (Race Condition Handling)

> ⚠️ **Edge Case**: A user may click "Stop" after the session has already ended naturally (e.g., EV battery full, plug pulled, power loss). SteVe might return "Rejected" or the charger might ignore the command.

**Backend Implementation Strategy** (`src/services/ocpp/remote-stop.service.ts`):
```typescript
export async function stopChargingSession(req: RemoteStopRequest): Promise<{ 
  success: boolean; 
  message: string;
  alreadyStopped?: boolean;
}> {
  logger.info(`🛑 Stop request for transaction ${req.transactionId}`, {
    chargeBoxId: req.chargeBoxId
  });
  
  // ─────────────────────────────────────────────────
  // STEP 1: Check if already stopped (idempotency check)
  // ─────────────────────────────────────────────────
  const isAlreadyStopped = await steveRepository.isTransactionStopped(req.transactionId);
  
  if (isAlreadyStopped) {
    logger.info(`✅ Transaction ${req.transactionId} already stopped`, {
      chargeBoxId: req.chargeBoxId
    });
    return { 
      success: true, 
      message: 'Session already finished',
      alreadyStopped: true
    };
  }
  
  // ─────────────────────────────────────────────────
  // STEP 2: Try to stop via SteVe REST API
  // ─────────────────────────────────────────────────
  const steveApiBaseUrl = process.env.STEVE_API_URL || 'http://localhost:8080/steve';
  const steveApiEndpoint = `${steveApiBaseUrl}/api/v1/operations/RemoteStopTransaction`;
  
  try {
    const requestBody = {
      chargeBoxIdList: [req.chargeBoxId],
      transactionId: req.transactionId
    };
    
    const response = await fetch(steveApiEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(
          `${process.env.STEVE_API_USER}:${process.env.STEVE_API_PASS}`
        ).toString('base64')}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10000)
    });
    
    const responseText = await response.text();
    
    if (!response.ok) {
      // ─────────────────────────────────────────────
      // STEP 3: Race condition check - maybe it stopped during API call
      // ─────────────────────────────────────────────
      const doubleCheck = await steveRepository.isTransactionStopped(req.transactionId);
      
      if (doubleCheck) {
        logger.info(`✅ Transaction ${req.transactionId} stopped during API call (race condition handled)`, {
          chargeBoxId: req.chargeBoxId
        });
        return { 
          success: true, 
          message: 'Session finished',
          alreadyStopped: true
        };
      }
      
      // Real error - propagate it
      logger.error(`SteVe RemoteStop API error ${response.status}: ${responseText}`, {
        chargeBoxId: req.chargeBoxId,
        transactionId: req.transactionId
      });
      throw new Error(`SteVe API ${response.status}: ${responseText}`);
    }
    
    // Parse success response
    const result = JSON.parse(responseText) as {
      successResponses?: Array<{ chargeBoxId: string; response: string }>;
      errorResponses?: Array<{ errorCode: string; errorDescription: string }>;
    };
    
    if (result.errorResponses?.length) {
      const err = result.errorResponses[0];
      throw new Error(`SteVe error: ${err.errorCode} - ${err.errorDescription}`);
    }
    
    if (result.successResponses?.length) {
      const success = result.successResponses[0];
      logger.info(`✅ RemoteStop via SteVe REST API succeeded`, { 
        chargeBoxId: success.chargeBoxId, 
        response: success.response 
      });
      
      if (success.response !== 'Accepted') {
        // Check one more time for race condition
        const finalCheck = await steveRepository.isTransactionStopped(req.transactionId);
        if (finalCheck) {
          return { 
            success: true, 
            message: 'Session finished',
            alreadyStopped: true
          };
        }
        return { 
          success: false, 
          message: `SteVe RemoteStop rejected: ${success.response}` 
        };
      }
      
      return { success: true, message: 'Stop command sent to charger' };
    }
    
    throw new Error('SteVe API response did not contain expected fields');
    
  } catch (error: any) {
    logger.error('Failed to stop charging session', {
      error: error.message,
      chargeBoxId: req.chargeBoxId,
      transactionId: req.transactionId
    });
    throw error;
  }
}
```

**Frontend Behavior**:
- Use **optimistic UI**: When "Stop" is clicked, immediately show "Stopping..." and disable the button
- Do NOT wait for API response to update UI state (improves perceived performance)
- Listen for `transaction:stopped` WebSocket event to confirm final state
- If API returns `alreadyStopped: true`, show friendly message: "Session already completed" instead of error

#### GET `/api/charging/sessions`

**Purpose**: Retrieve session history for authenticated user

**Query Parameters**:
- `limit` (optional, default: 20): Number of sessions to return
- `offset` (optional, default: 0): For pagination

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "session_id": 1,
      "charge_box_id": "CS-SIEMENS-00001",
      "connector_id": 1,
      "id_tag": "USER001",
      "start_time": "2026-03-05T12:10:30.000Z",
      "end_time": "2026-03-05T12:40:15.000Z",
      "duration_seconds": 1785,
      "energy_kwh": 12.450,
      "total_cost": 3.61,
      "status": "completed",
      "payment_status": "paid",
      "stop_reason": "Remote"
    }
  ],
  "timestamp": "2026-03-05T12:15:00.000Z"
}
```

#### GET `/api/charging/session/active`

**Purpose**: Get currently active session for user OR poll for real transactionId after start command

**Query Parameters**:
- `idTag` (optional): Filter by specific RFID/App tag (used for Transaction ID Gap polling)

**Response (Active Session Found)**:
```json
{
  "success": true,
  "data": {
    "status": "active",
    "transactionId": 215,
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "startTime": "2026-03-05T12:10:35.000Z"
  },
  "timestamp": "2026-03-05T12:10:36.000Z"
}
```

**Response (Pending — Transaction Not Yet Started)**:
```json
{
  "success": true,
  "data": { 
    "status": "pending", 
    "message": "Waiting for charger to start session" 
  },
  "timestamp": "2026-03-05T12:10:33.000Z"
}
```

**Response (No Active Session)**:
```json
{
  "success": true,
  "data": null,
  "timestamp": "2026-03-05T12:15:00.000Z"
}
```

### 5.2 Tag Management

#### POST `/api/users/me/tags`

**Purpose**: Register physical RFID card for user (triggers provisioning in SteVe)

**Request**:
```json
{
  "tagId": "A1B2C3D4",
  "nickname": "My Work Card"
}
```

**Headers**:
```
Authorization: Bearer <JWT-token>
Content-Type: application/json
```

**Backend Actions**:
1. Insert tag into SteVe's `ocpp_tag` table (for RFID flow) via repository
2. Link tag to app user in `user_ocpp_tag` (for app-flow security) via repository
3. Store tag metadata in VoltStartEV app DB (optional, for user-friendly display)

**Response**:
```json
{
  "success": true,
  "message": "Tag registered successfully",
  "data": {
    "tagId": "A1B2C3D4",
    "ocppTagPk": 191,
    "nickname": "My Work Card"
  }
}
```

#### Tag Provisioning via Repository Pattern

> ⚠️ **Architecture Note**: Direct SQL writes to SteVe's database create tight coupling. To mitigate this, all SteVe-specific SQL is isolated in a repository layer.

**Repository Layer**: `src/repositories/steve-repository.ts`
```typescript
// Interface defines WHAT we need, not HOW we get it
export interface IOcppTagRepository {
  upsertTag(params: { 
    idTag: string; 
    maxActiveTransactions?: number; 
    expiryDate?: Date; 
    note?: string;
  }): Promise<{ ocppTagPk: number }>;
  
  isTagValid(idTag: string): Promise<{ 
    valid: boolean; 
    reason?: string;
    ocppTagPk?: number;
  }>;
  
  isUserTagLinked(appUserId: number, idTag: string): Promise<boolean>;
  
  getTagDetails(idTag: string): Promise<{
    ocppTagPk: number;
    idTag: string;
    blocked: boolean;
    expired: boolean;
    expiryDate?: string;
    parentIdTag?: string;
    activeTransactionCount: number;
    maxActiveTransactions: number;
  } | null>;
}

export class SteveSqlRepository implements IOcppTagRepository {
  async upsertTag(params: { 
    idTag: string; 
    maxActiveTransactions?: number; 
    expiryDate?: Date; 
    note?: string;
  }): Promise<{ ocppTagPk: number }> {
    // SteVe-specific SQL isolated here — only this file knows table/column names
    await steveQuery(`
      INSERT INTO ocpp_tag (
        id_tag,
        max_active_transaction_count,
        expiry_date,
        note
      ) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        max_active_transaction_count = VALUES(max_active_transaction_count),
        expiry_date = VALUES(expiry_date),
        note = VALUES(note),
        updated_at = NOW()
    `, [
      params.idTag,
      params.maxActiveTransactions ?? 1,
      params.expiryDate ?? null,
      params.note ?? 'Provisioned by VoltStartEV app'
    ]);
    
    // Get the primary key for linking
    const [tag] = await steveQuery(
      'SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1',
      [params.idTag]
    );
    
    if (!tag) {
      throw new Error(`Failed to retrieve ocpp_tag_pk for ${params.idTag}`);
    }
    
    return { ocppTagPk: tag.ocpp_tag_pk };
  }
  
  async isUserTagLinked(appUserId: number, idTag: string): Promise<boolean> {
    const [link] = await steveQuery(`
      SELECT 1 FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE uot.user_pk = ? AND ot.id_tag = ?
      LIMIT 1
    `, [appUserId, idTag]);
    
    return !!link;
  }
  
  // ... other methods (isTagValid, getTagDetails, etc.)
}

// Singleton export — use this instance throughout the app
export const steveRepository = new SteveSqlRepository();
```

**Benefits**:
- ✅ If SteVe schema changes (e.g., `id_tag` → `tag_id`), only `steve-repository.ts` needs updating
- ✅ Services/controllers remain unchanged → easier testing with mocks
- ✅ Clear contract via TypeScript interfaces
- ✅ Centralized logging and error handling for SteVe DB operations

**Usage in Service** (`src/services/ocpp/tag-provisioning.service.ts`):
```typescript
import { steveRepository } from '../../repositories/steve-repository.js';

export async function provisionOcppTagInSteVe(
  idTag: string, 
  appUserId: number,
  options?: { nickname?: string; maxActiveTransactions?: number }
): Promise<{ ocppTagPk: number }> {
  // 1. Insert/update tag in SteVe via repository (no direct SQL in this file)
  const { ocppTagPk } = await steveRepository.upsertTag({
    idTag,
    maxActiveTransactions: options?.maxActiveTransactions,
    note: options?.nickname ? `User: ${options.nickname}` : 'Provisioned by VoltStartEV'
  });
  
  // 2. Link to app user in user_ocpp_tag via repository
  const isLinked = await steveRepository.isUserTagLinked(appUserId, idTag);
  if (!isLinked) {
    // Insert linkage (simplified — in production, use transaction)
    await steveQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE updated_at = NOW()
    `, [appUserId, ocppTagPk]);
  }
  
  return { ocppTagPk };
}
```

---

## 6. Charging Flows

### 6.1 Flow 1: App-Initiated Charging

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐     ┌──────────┐
│ Mobile App  │     │ VoltStartEV      │     │ SteVe OCPP  │     │ Charger  │
│             │     │ Backend          │     │ Server      │     │          │
└──────┬──────┘     └────────┬─────────┘     └──────┬──────┘     └────┬─────┘
       │                     │                      │                 │
       │ 1. Click "Start"    │                      │                 │
       │ POST /charging/start│                      │                 │
       │ {chargeBoxId,       │                      │                 │
       │  connectorId,       │                      │                 │
       │  idTag}             │                      │                 │
       │ + JWT               │                      │                 │
       │────────────────────▶│                      │                 │
       │                     │                      │                 │
       │                     │ 2. Validate JWT      │                 │
       │                     │    Extract appUserId │                 │
       │                     │                      │                 │
       │                     │ 3. Check charger     │                 │
       │                     │    status = Available│                 │
       │                     │    (query SteVe DB)  │                 │
       │                     │                      │                 │
       │                     │ 4. Validate user↔tag │                 │
       │                     │    SELECT FROM       │                 │
       │                     │    user_ocpp_tag     │                 │
       │                     │    (via repository)  │                 │
       │                     │                      │                 │
       │                     │ 5. Call SteVe REST   │                 │
       │                     │    POST /api/v1/     │                 │
       │                     │    operations/       │                 │
       │                     │    RemoteStartTrans. │                 │
       │                     │    Auth: Basic       │                 │
       │                     │    voltstart_backend │                 │
       │                     │─────────────────────▶│                 │
       │                     │                      │                 │
       │                     │                      │ 6. Send OCPP    │
       │                     │                      │    RemoteStart  │
       │                     │                      │    Transaction  │
       │                     │                      │────────────────▶│
       │                     │                      │                 │
       │                     │                      │ 7. Charger      │
       │                     │                      │    accepts      │
       │                     │                      │◀────────────────│
       │                     │                      │                 │
       │                     │ 8. 200 OK           │                 │
       │                     │    {response:       │                 │
       │                     │     "Accepted"}     │                 │
       │                     │◀────────────────────│                 │
       │                     │                      │                 │
       │ 9. 202 Accepted     │                      │                 │
       │    {transactionId:0}│                      │                 │
       │◀────────────────────│                      │                 │
       │                     │                      │                 │
       │ 10. Frontend polls  │                      │                 │
       │     /session/active │                      │                 │
       │     OR waits for    │                      │                 │
       │     WebSocket event │                      │                 │
       │◀────────────────────│                      │                 │
       │                     │                      │                 │
       │                     │ 11. Polling detects  │                 │
       │                     │     transaction_start│                 │
       │                     │     in SteVe DB      │                 │
       │                     │                      │                 │
       │ 12. Real transactionId│                     │                 │
       │     returned to frontend                   │                 │
       │◀────────────────────│                      │                 │
       │                     │                      │                 │
       │ 13. UI updates to   │                      │                 │
       │     "Charging", enables Stop button        │                 │
       │                     │                      │                 │
       │ 14. User clicks Stop│                      │                 │
       │     POST /charging/stop                   │                 │
       │     {transactionId: 215}                  │                 │
       │────────────────────▶│                      │                 │
       │                     │ 15. Idempotent stop │                 │
       │                     │     logic (check if │                 │
       │                     │     already stopped)│                 │
       │                     │─────────────────────▶│                 │
       │                     │                      │                 │
       │                     │                      │ 16. OCPP      │
       │                     │                      │    RemoteStop │
       │                     │                      │    Transaction│
       │                     │                      │──────────────▶│
       │                     │                      │                │
       │                     │                      │ 17. Charger  │
       │                     │                      │    stops     │
       │                     │                      │◀─────────────│
       │                     │                      │                │
       │                     │ 18. Polling detects │                │
       │                     │     transaction_stop│                │
       │                     │     in SteVe DB     │                │
       │                     │                      │                │
       │ 19. WebSocket event │                      │                │
       │     transaction:stopped                   │                │
       │◀────────────────────│                      │                │
       │                     │                      │                │
       │ 20. Billing record  │                      │                │
       │     created in      │                      │                │
       │     charging_sessions                     │                │
       │                     │                      │                │
```

### 6.2 Flow 2: RFID-Initiated Charging (Physical Card)

```
┌─────────────┐     ┌─────────────┐     ┌──────────┐
│ Physical    │     │ SteVe OCPP  │     │ Charger  │
│ RFID Card   │     │ Server      │     │          │
└──────┬──────┘     └──────┬──────┘     └────┬─────┘
       │                   │                 │
       │ 1. Tap card       │                 │
       │ (RFID tag:        │                 │
       │  A1B2C3D4)        │                 │
       │──────────────────▶│                 │
       │                   │                 │
       │                   │ 2. OCPP         │
       │                   │    Authorize    │
       │                   │    {idTag:      │
       │                   │     "A1B2C3D4"} │
       │                   │────────────────▶│
       │                   │                 │
       │                   │ 3. Validate tag │
       │                   │    SELECT FROM  │
       │                   │    ocpp_tag +   │
       │                   │    ocpp_tag_act │
       │                   │    - Not blocked│
       │                   │    - Not expired│
       │                   │    - Under limit│
       │                   │                 │
       │                   │ 4. Authorize    │
       │                   │    Response     │
       │                   │    {status:     │
       │                   │     "Accepted"} │
       │                   │◀────────────────│
       │                   │                 │
       │ 5. Display        │                 │
       │    "Authorized"   │                 │
       │◀──────────────────│                 │
       │                   │                 │
       │ 6. User presses   │                 │
       │    Start button   │                 │
       │──────────────────▶│                 │
       │                   │                 │
       │                   │ 7. OCPP         │
       │                   │    StartTransaction
       │                   │    {idTag,      │
       │                   │     meterValue} │
       │                   │────────────────▶│
       │                   │                 │
       │                   │ 8. Create       │
       │                   │    transaction_ │
       │                   │    start record │
       │                   │                 │
       │                   │ 9. StartTransaction
       │                   │    Response     │
       │                   │    {idTagInfo,  │
       │                   │     status}     │
       │                   │◀────────────────│
       │                   │                 │
       │                   │ 10. Polling     │
       │                   │     detects     │
       │                   │     new tx      │
       │                   │                 │
       │                   │ 11. WebSocket   │
       │                   │     to app      │
       │                   │     (optional)  │
       │                   │                 │
       │                   │ 12. Billing     │
       │                   │     record      │
       │                   │     created     │
       │                   │                 │
```

> 🔑 **Key Difference**: In RFID flow, SteVe handles authorization directly — no VoltStartEV backend involvement until polling detects the transaction. This is why `user_ocpp_tag` linkage is only enforced for app-initiated flow.

---

## 7. Tag Management

### 7.1 Tag Provisioning Workflow

When a user registers a physical RFID card in the VoltStartEV app:

```typescript
// src/services/ocpp/tag-provisioning.service.ts
import { steveRepository } from '../../repositories/steve-repository.js';
import { appDbQuery } from '../../config/database.js';

export async function provisionOcppTagInSteVe(
  idTag: string, 
  appUserId: number,
  options?: { nickname?: string; maxActiveTransactions?: number; expiryDate?: Date }
): Promise<{ ocppTagPk: number }> {
  // 1. Insert/update tag in SteVe via repository (no direct SQL in this file)
  const { ocppTagPk } = await steveRepository.upsertTag({
    idTag,
    maxActiveTransactions: options?.maxActiveTransactions,
    expiryDate: options?.expiryDate,
    note: options?.nickname ? `User: ${options.nickname}` : 'Provisioned by VoltStartEV'
  });
  
  // 2. Link to app user in user_ocpp_tag via repository
  const isLinked = await steveRepository.isUserTagLinked(appUserId, idTag);
  if (!isLinked) {
    // Insert linkage (use transaction in production for atomicity)
    await appDbQuery(`
      INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE updated_at = NOW()
    `, [appUserId, ocppTagPk]);
  }
  
  // 3. Optional: Store user-friendly metadata in VoltStartEV app DB
  if (options?.nickname) {
    await appDbQuery(`
      INSERT INTO user_tags (app_user_id, ocpp_tag_id, nickname)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)
    `, [appUserId, idTag, options.nickname]);
  }
  
  return { ocppTagPk };
}
```

### 7.2 Tag Deactivation

Allow users to deactivate lost/stolen cards:

```typescript
// src/services/ocpp/tag-management.service.ts
import { steveRepository } from '../../repositories/steve-repository.js';

export async function deactivateTag(idTag: string): Promise<void> {
  // Set blocked = 1 in ocpp_tag_activity via repository
  await steveQuery(`
    UPDATE ocpp_tag_activity ota
    JOIN ocpp_tag ot ON ot.ocpp_tag_pk = ota.ocpp_tag_pk
    SET ota.blocked = 1
    WHERE ot.id_tag = ?
  `, [idTag]);
  
  // Optional: Log deactivation for audit
  logger.info(`🔒 Tag deactivated: ${idTag}`);
}

export async function reactivateTag(idTag: string): Promise<void> {
  // Set blocked = 0 in ocpp_tag_activity
  await steveQuery(`
    UPDATE ocpp_tag_activity ota
    JOIN ocpp_tag ot ON ot.ocpp_tag_pk = ota.ocpp_tag_pk
    SET ota.blocked = 0
    WHERE ot.id_tag = ?
  `, [idTag]);
  
  logger.info(`🔓 Tag reactivated: ${idTag}`);
}
```

---

## 8. Billing & Session History

### 8.1 Session Creation (Real-Time)

When polling detects a new `transaction_start` record:

```typescript
// src/services/billing/session.service.ts
import { appDbQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

export interface SessionStartData {
  appUserId: number;
  steveTransactionPk?: number;
  chargeBoxId: string;
  connectorId: number;
  idTag: string;
  startMeterValue?: number; // Wh
}

export async function startBillingSession(data: SessionStartData): Promise<{ sessionId: number }> {
  logger.info(`💰 Starting billing session for user ${data.appUserId}`, {
    chargeBoxId: data.chargeBoxId,
    idTag: data.idTag
  });

  const [result] = await appDbQuery(`
    INSERT INTO charging_sessions (
      app_user_id,
      steve_transaction_pk,
      charge_box_id,
      connector_id,
      id_tag,
      start_time,
      start_meter_value,
      status
    ) VALUES (?, ?, ?, ?, ?, NOW(), ?, 'active')
  `, [
    data.appUserId,
    data.steveTransactionPk || null,
    data.chargeBoxId,
    data.connectorId,
    data.idTag,
    data.startMeterValue || null
  ]);

  return { sessionId: (result as any).insertId };
}
```

### 8.2 Session Completion (Real-Time)

When polling detects a `transaction_stop` record:

```typescript
export interface SessionStopData {
  steveTransactionPk: number;
  endMeterValue: number; // Wh
  stopReason?: string;
}

export async function completeBillingSession(data: SessionStopData): Promise<{
  sessionId: number;
  energyKwh: number;
  totalCost: number;
}> {
  logger.info(`💰 Completing billing session for transaction ${data.steveTransactionPk}`, {
    endMeterValue: data.endMeterValue,
    stopReason: data.stopReason
  });

  // Get the session to calculate cost
  const [session] = await appDbQuery(`
    SELECT session_id, start_meter_value, rate_per_kwh, session_fee
    FROM charging_sessions
    WHERE steve_transaction_pk = ? AND status = 'active'
    LIMIT 1
  `, [data.steveTransactionPk]);

  if (!session) {
    throw new Error(`No active session found for SteVe transaction ${data.steveTransactionPk}`);
  }

  // Calculate energy and cost
  const startValue = session.start_meter_value || 0;
  const energyKwh = Math.round((data.endMeterValue - startValue) / 10) / 100; // Wh → kWh, 3 decimals
  const totalCost = Math.round((energyKwh * session.rate_per_kwh + session.session_fee) * 100) / 100;

  // Update session
  await appDbQuery(`
    UPDATE charging_sessions
    SET 
      end_time = NOW(),
      end_meter_value = ?,
      stop_reason = ?,
      status = 'completed',
      payment_status = 'pending'
    WHERE steve_transaction_pk = ?
  `, [data.endMeterValue, data.stopReason || 'Remote', data.steveTransactionPk]);

  logger.info(`✅ Billing session completed: ${energyKwh} kWh, $${totalCost}`, {
    sessionId: session.session_id,
    steveTransactionPk: data.steveTransactionPk
  });

  return {
    sessionId: session.session_id,
    energyKwh,
    totalCost
  };
}
```

### 8.3 Reconciliation Worker: Handling Offline/Deferred Transactions

> ⚠️ **Problem**: If a charger loses internet connectivity, it buffers transactions locally and uploads them hours later. Real-time polling may miss these, causing billing gaps.

**Solution**: Background reconciliation job that "sweeps" for missed transactions.

#### Database Constraint (Critical)
```sql
-- Ensure unique constraint to prevent duplicate billing
-- Run once during setup:
ALTER TABLE charging_sessions ADD UNIQUE KEY uniq_steve_transaction_pk (steve_transaction_pk);
```

#### Reconciliation Job Logic (`src/services/billing/reconciliation.service.ts`)
```typescript
import { appDbQuery, steveQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

export interface ReconciliationResult {
  processed: number;
  inserted: number;
  skipped: number;
  errors: Array<{ transactionPk: number; error: string }>;
}

/**
 * Reconcile SteVe transaction records with VoltStartEV billing sessions.
 * Run this as a background job every 10 minutes.
 * 
 * Handles offline chargers: if a session was missed by real-time polling,
 * this job will catch it and create the billing record retrospectively.
 */
export async function reconcileTransactions(
  options?: {
    lookbackHours?: number;  // How far back to check (default: 24)
    batchSize?: number;      // Process in batches to avoid memory issues
  }
): Promise<ReconciliationResult> {
  const lookbackHours = options?.lookbackHours ?? 24;
  const batchSize = options?.batchSize ?? 100;
  
  const result: ReconciliationResult = {
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: []
  };
  
  try {
    logger.info(`🔄 Starting reconciliation job (lookback: ${lookbackHours}h)`);
    
    // Get all completed transactions from SteVe in the lookback window
    // that are NOT already in charging_sessions (via UNIQUE constraint)
    const transactions = await steveQuery(`
      SELECT 
        ts.transaction_pk,
        ts.connector_pk,
        ts.id_tag,
        ts.start_timestamp,
        ts.start_value,
        tst.stop_timestamp,
        tst.stop_value,
        tst.stop_reason,
        cb.charge_box_id,
        c.connector_id
      FROM transaction_stop tst
      JOIN transaction_start ts ON ts.transaction_pk = tst.transaction_pk
      JOIN connector c ON c.connector_pk = ts.connector_pk
      JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
      WHERE tst.stop_timestamp > DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND tst.transaction_pk NOT IN (
          SELECT steve_transaction_pk 
          FROM charging_sessions 
          WHERE steve_transaction_pk IS NOT NULL
        )
      ORDER BY tst.stop_timestamp ASC
      LIMIT ?
    `, [lookbackHours, batchSize]);
    
    result.processed = transactions.length;
    logger.info(`Found ${transactions.length} transactions to reconcile`);
    
    // Process each transaction
    for (const tx of transactions) {
      try {
        // Calculate energy and cost
        const startValue = parseFloat(tx.start_value) || 0;
        const endValue = parseFloat(tx.stop_value) || 0;
        const energyKwh = Math.round((endValue - startValue) / 10) / 100; // Wh → kWh
        
        // Default billing rates (could be user-specific in production)
        const ratePerKwh = 0.25;
        const sessionFee = 0.50;
        const totalCost = Math.round((energyKwh * ratePerKwh + sessionFee) * 100) / 100;
        
        // Insert into billing table - IGNORE duplicates (already processed by real-time)
        // The UNIQUE constraint on steve_transaction_pk ensures idempotency
        const [insertResult] = await appDbQuery(`
          INSERT IGNORE INTO charging_sessions (
            app_user_id,          -- Will be NULL if user not linked; can be backfilled later
            steve_transaction_pk,
            charge_box_id,
            connector_id,
            id_tag,
            start_time,
            end_time,
            start_meter_value,
            end_meter_value,
            energy_kwh,
            total_cost,
            status,
            stop_reason,
            payment_status
          ) VALUES (
            NULL,                 -- TODO: Link to app user via id_tag mapping (see backfillUserLinks)
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 'pending'
          )
        `, [
          tx.transaction_pk,
          tx.charge_box_id,
          tx.connector_id,
          tx.id_tag,
          tx.start_timestamp,
          tx.stop_timestamp,
          startValue,
          endValue,
          energyKwh,
          totalCost,
          tx.stop_reason
        ]);
        
        // Check if row was actually inserted (not ignored)
        if ((insertResult as any).affectedRows > 0) {
          result.inserted++;
          logger.info(`💰 Reconciled offline transaction #${tx.transaction_pk}: ${energyKwh} kWh @ $${totalCost}`);
          
          // TODO: Trigger retrospective billing here if user is linked
          // await chargeUserForSession(userId, totalCost, tx.transaction_pk);
        } else {
          result.skipped++;
          logger.debug(`⏭️ Transaction #${tx.transaction_pk} already exists (real-time processing)`);
        }
        
      } catch (error: any) {
        result.errors.push({
          transactionPk: tx.transaction_pk,
          error: error.message || 'Unknown error'
        });
        logger.error(`💥 Error reconciling transaction #${tx.transaction_pk}`, { error });
      }
    }
    
    logger.info(`✅ Reconciliation complete: ${result.inserted} inserted, ${result.skipped} skipped, ${result.errors.length} errors`);
    return result;
    
  } catch (error: any) {
    logger.error('💥 Reconciliation job failed', { error });
    throw error;
  }
}

/**
 * Backfill app_user_id for sessions where id_tag is linked to a user
 * Run after reconciliation to link offline sessions to users
 */
export async function backfillUserLinks(): Promise<{ updated: number }> {
  const [result] = await appDbQuery(`
    UPDATE charging_sessions cs
    JOIN user_ocpp_tag uot ON uot.ocpp_tag_pk = (
      SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = cs.id_tag LIMIT 1
    )
    SET cs.app_user_id = uot.user_pk
    WHERE cs.app_user_id IS NULL
      AND cs.id_tag IS NOT NULL
  `);
  
  return { updated: (result as any).changedRows || 0 };
}
```

#### Scheduling the Reconciliation Job

**Option A: Using node-cron (Simple)**
```typescript
// src/jobs/reconciliation.job.ts
import cron from 'node-cron';
import { reconcileTransactions, backfillUserLinks } from '../services/billing/reconciliation.service.js';
import logger from '../config/logger.js';

// Run reconciliation every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  logger.info('⏰ Starting scheduled reconciliation job');
  
  try {
    const result = await reconcileTransactions({ lookbackHours: 24 });
    
    if (result.inserted > 0) {
      // Backfill user links for newly inserted sessions
      const backfillResult = await backfillUserLinks();
      logger.info(`🔗 Backfilled ${backfillResult.updated} user links`);
    }
  } catch (error) {
    logger.error('❌ Scheduled reconciliation failed', { error });
  }
});

export function startReconciliationJob() {
  logger.info('📅 Reconciliation job scheduler started');
}
```

**Option B: Using Bull Queue (Production-Ready)**
```typescript
// src/queues/reconciliation.queue.ts
import Queue from 'bull';
import { reconcileTransactions } from '../services/billing/reconciliation.service.js';
import logger from '../config/logger.js';

const reconciliationQueue = new Queue('reconciliation', {
  redis: { host: process.env.REDIS_HOST || 'localhost', port: 6379 }
});

// Process jobs
reconciliationQueue.process(async (job) => {
  logger.info(`🔄 Processing reconciliation job #${job.id}`);
  return await reconcileTransactions(job.data);
});

// Schedule recurring job
export function scheduleReconciliation() {
  reconciliationQueue.add(
    {}, 
    { 
      repeat: { every: 600000 } // Every 10 minutes
    }
  );
  logger.info('📅 Reconciliation job scheduled (every 10 minutes)');
}
```

#### User Experience for Offline Sessions
- Offline sessions appear in user history with correct past timestamps
- Billing is calculated retrospectively using rates at time of session
- Users are notified via push notification/email when offline session is reconciled (optional)

#### Monitoring & Alerting
- Log reconciliation results: `inserted`, `skipped`, `errors`
- Alert if error rate > 5% or if job fails to complete
- Dashboard metric: "Offline sessions reconciled (24h)"

---

## 9. Real-Time Updates

### 9.1 WebSocket Architecture

**Endpoint**: `ws://localhost:3001/ws/charging` (use `wss://` in production with TLS)

**Authentication**: Bearer token in WebSocket handshake (same JWT as REST API)

**Implementation** (`src/websocket/charging.websocket.ts`):
```typescript
import { Server as WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

interface WebSocketClient {
  ws: any;
  userId?: number;
  chargeBoxIds?: string[]; // Chargers this user is subscribed to
}

class ChargingWebSocketService {
  private wss: WebSocketServer;
  private clients: Map<string, WebSocketClient> = new Map(); // userId -> client
  
  constructor(server: any) {
    this.wss = new WebSocketServer({ 
      noServer: true,
      path: '/ws/charging'
    });
    
    // Handle upgrade from HTTP to WebSocket
    server.on('upgrade', (request: IncomingMessage, socket: any, head: any) => {
      const { pathname } = parse(request.url || '');
      
      if (pathname === '/ws/charging') {
        this.wss.handleUpgrade(request, socket, head, (ws: any) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });
    
    this.wss.on('connection', (ws: any, request: IncomingMessage) => {
      this.handleConnection(ws, request);
    });
    
    logger.info('📡 Charging WebSocket server initialized');
  }
  
  private async handleConnection(ws: any, request: IncomingMessage) {
    const token = this.extractToken(request);
    
    if (!token) {
      ws.send(JSON.stringify({ error: 'Authentication required' }));
      ws.close();
      return;
    }
    
    try {
      // Verify JWT and extract user info
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { 
        id: number; 
        username: string;
        role: string;
      };
      
      const clientId = `user_${payload.id}`;
      
      // Store client
      this.clients.set(clientId, {
        ws,
        userId: payload.id,
        chargeBoxIds: [] // Can be populated based on user permissions
      });
      
      logger.info(`🔌 WebSocket connected: ${clientId}`);
      
      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        userId: payload.id,
        timestamp: new Date().toISOString()
      }));
      
      // Handle incoming messages (optional: client can subscribe to specific chargers)
      ws.on('message', (message: string) => {
        this.handleClientMessage(clientId, message);
      });
      
      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info(`🔌 WebSocket disconnected: ${clientId}`);
      });
      
      ws.on('error', (error: Error) => {
        logger.error(`WebSocket error for ${clientId}`, { error });
        this.clients.delete(clientId);
      });
      
    } catch (error) {
      logger.error('WebSocket authentication failed', { error });
      ws.send(JSON.stringify({ error: 'Invalid token' }));
      ws.close();
    }
  }
  
  private extractToken(request: IncomingMessage): string | null {
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }
  
  private handleClientMessage(clientId: string, message: string) {
    try {
      const data = JSON.parse(message);
      logger.debug(`📨 Received from ${clientId}:`, data);
      
      // Example: Client subscribes to charger updates
      if (data.type === 'subscribe' && data.chargeBoxId) {
        const client = this.clients.get(clientId);
        if (client && !client.chargeBoxIds?.includes(data.chargeBoxId)) {
          client.chargeBoxIds = [...(client.chargeBoxIds || []), data.chargeBoxId];
          this.clients.set(clientId, client);
          
          ws.send(JSON.stringify({
            type: 'subscribed',
            chargeBoxId: data.chargeBoxId,
            timestamp: new Date().toISOString()
          }));
        }
      }
    } catch (error) {
      logger.error(`Error handling message from ${clientId}`, { error });
    }
  }
  
  // ✅ PUBLIC: Emit events to clients
  emitToUser(userId: number, event: string, payload: any) {
    const clientId = `user_${userId}`;
    const client = this.clients.get(clientId);
    
    if (client?.ws?.readyState === 1) { // WebSocket.OPEN
      const message = JSON.stringify({
        type: event,
        data: payload,
        timestamp: new Date().toISOString()
      });
      
      client.ws.send(message);
      logger.debug(`📤 Emitted ${event} to ${clientId}`);
      return true;
    }
    
    logger.debug(`⚠️ Client ${clientId} not connected, message queued (TODO: implement queue)`);
    return false;
  }
  
  emitToChargeBox(chargeBoxId: string, event: string, payload: any) {
    // Emit to all users subscribed to this charger
    let emitted = 0;
    
    for (const [clientId, client] of this.clients) {
      if (client.chargeBoxIds?.includes(chargeBoxId) && client.ws?.readyState === 1) {
        client.ws.send(JSON.stringify({
          type: event,
          chargeBoxId,
          data: payload,
          timestamp: new Date().toISOString()
        }));
        emitted++;
      }
    }
    
    logger.debug(`📤 Emitted ${event} for ${chargeBoxId} to ${emitted} clients`);
    return emitted;
  }
  
  // Broadcast to all connected users (e.g., system alerts)
  broadcast(event: string, payload: any) {
    let emitted = 0;
    
    for (const [clientId, client] of this.clients) {
      if (client.ws?.readyState === 1) {
        client.ws.send(JSON.stringify({
          type: event,
          data: payload,
          timestamp: new Date().toISOString()
        }));
        emitted++;
      }
    }
    
    logger.debug(`📤 Broadcast ${event} to ${emitted} clients`);
    return emitted;
  }
}

export default ChargingWebSocketService;
```

### 9.2 Event Types

| Event | Trigger | Payload | Frontend Action |
|-------|---------|---------|----------------|
| `transaction:started` | New transaction detected via polling | `{transactionId, chargeBoxId, connectorId, idTag, startTime}` | Update UI to "Charging", enable Stop button |
| `transaction:completed` | Transaction stop detected | `{transactionId, energyKwh, totalCost, duration, stopReason}` | Show completion summary, update billing |
| `charger:status` | Connector status change | `{chargeBoxId, connectorId, status, timestamp}` | Update charger availability in UI |
| `session:billing` | Billing calculation complete | `{sessionId, energyKwh, totalCost, paymentStatus}` | Show receipt, trigger payment flow |
| `system:alert` | System-wide notification | `{level: 'info' | 'warning' | 'error', message}` | Show toast notification |

### 9.3 Integration with Polling Service

When polling detects a new/updated transaction:

```typescript
// In src/services/ocpp/polling.service.ts

// When transaction STARTS:
if (newTransaction) {
  logger.info(`⚡ Transaction started: #${newTransaction.transaction_pk} | ${newTransaction.charge_box_id}:${newTransaction.connector_id} | tag=${newTransaction.id_tag}`);
  
  // ✅ Emit to affected user (if user_pk is known via user_ocpp_tag)
  if (newTransaction.user_pk) {
    const wsService = app.get('websocketService');
    wsService?.emitToUser(newTransaction.user_pk, 'transaction:started', {
      transactionId: newTransaction.transaction_pk,
      chargeBoxId: newTransaction.charge_box_id,
      connectorId: newTransaction.connector_id,
      idTag: newTransaction.id_tag,
      startTime: newTransaction.start_timestamp
    });
  }
  
  // Also broadcast to all subscribers of this charger
  wsService?.emitToChargeBox(newTransaction.charge_box_id, 'charger:status', {
    chargeBoxId: newTransaction.charge_box_id,
    connectorId: newTransaction.connector_id,
    status: 'Busy',
    transactionId: newTransaction.transaction_pk,
    timestamp: new Date().toISOString()
  });
}

// When transaction STOPS (detected via transaction_stop table polling):
if (stoppedTransaction) {
  // ... emit 'transaction:completed' with energy consumed, cost, etc.
}
```

---

## 10. Security Considerations

### 10.1 Credential Management

| Credential | Storage | Rotation | Notes |
|-----------|---------|----------|-------|
| `STEVE_API_PASS` | Environment variable (.env) | Monthly | Use BCrypt hash in SteVe DB; plain text in .env |
| `JWT_SECRET` | Environment variable (.env) | Quarterly | Use crypto.randomBytes(32).toString('hex') |
| Database passwords | Environment variables | Quarterly | Use strong, unique passwords per DB/user |
| Service account `api_password` | SteVe DB (BCrypt hash) | Monthly | Regenerate hash, update .env, restart backend |

**Best Practices**:
- Never commit `.env` to version control (add to `.gitignore`)
- Use a secrets manager (AWS Secrets Manager, HashiCorp Vault) in production
- Rotate credentials on a schedule; automate with CI/CD
- Log credential usage for audit (but never log the credentials themselves)

### 10.2 Input Validation

```typescript
// Validate all incoming requests with Zod
import { z } from 'zod';

const startChargingSchema = z.object({
  chargeBoxId: z.string().min(1).max(64).regex(/^[A-Z0-9\-_]+$/, 'Invalid chargeBoxId format'),
  connectorId: z.number().int().positive().max(10),
  idTag: z.string().min(1).max(64).regex(/^[A-Z0-9]+$/, 'Invalid idTag format')
});

// Use in route handler
const result = startChargingSchema.safeParse(req.body);
if (!result.success) {
  return res.status(400).json({ 
    error: 'Validation error',
    message: 'Invalid request data',
    details: result.error.flatten()
  });
}
```

### 10.3 Rate Limiting

```typescript
// Per-user rate limiting with express-rate-limit
import rateLimit from 'express-rate-limit';

const chargingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window per user/IP
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.id || req.ip,
  message: {
    success: false,
    error: 'Too many requests',
    message: 'Please try again later',
    retryAfter: 900 // seconds
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Apply to charging endpoints
app.use('/api/charging', chargingLimiter);
```

### 10.4 Audit Logging

Log all critical operations for compliance and debugging:

```typescript
// Example: Log charging start
logger.info('Charging started', {
  userId: appUserId,
  chargeBoxId,
  connectorId,
  idTag,
  timestamp: new Date().toISOString(),
  ipAddress: req.ip,
  userAgent: req.get('User-Agent')
});

// Example: Log tag provisioning
logger.info('Tag provisioned', {
  userId: appUserId,
  tagId: idTag,
  ocppTagPk,
  timestamp: new Date().toISOString()
});

// Example: Log reconciliation job
logger.info('Reconciliation job completed', {
  inserted: result.inserted,
  skipped: result.skipped,
  errors: result.errors.length,
  timestamp: new Date().toISOString()
});
```

**Log Storage**:
- Development: Console + file (`/var/log/voltstartev/backend.log`)
- Production: Structured JSON logs → ELK stack or cloud logging service
- Retention: 90 days minimum for compliance

---

## 11. Deployment & Configuration

### 11.1 Environment Variables

```bash
# .env file (VoltStartEV Backend) — NEVER COMMIT TO VERSION CONTROL
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.voltstartev.com

# SteVe REST API
STEVE_API_URL=http://localhost:8080/steve
STEVE_API_USER=voltstart_backend
STEVE_API_PASS=ServiceSecretKey_2026!  # Plain text in env; SteVe hashes internally

# Database — SteVe (READ-ONLY)
STEVE_DB_HOST=localhost
STEVE_DB_PORT=3306
STEVE_DB_NAME=stevedb
STEVE_DB_USER=voltstartev_user  # SELECT-only permissions
STEVE_DB_PASSWORD=VoltStartEv@2026Secure!

# Database — VoltStartEV App (READ/WRITE)
APP_DB_HOST=localhost
APP_DB_PORT=3306
APP_DB_NAME=voltstartev_db
APP_DB_USER=voltstartev_user
APP_DB_PASSWORD=VoltStartEv@2026Secure!

# JWT
JWT_SECRET=STh0J/t5Wwk2pNNTg4N11bsfNThieH3gkZft9m8gXAE=  # Generate with crypto.randomBytes(32)
JWT_EXPIRES_IN=7d

# WebSocket
WS_PORT=3001
WS_PATH=/ws/charging
APP_ORIGIN=https://app.voltstartev.com,https://admin.voltstartev.com

# Logging
LOG_LEVEL=info  # Use 'debug' for development
LOG_FILE=/var/log/voltstartev/backend.log

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100

# Reconciliation Job
RECONCILIATION_LOOKBACK_HOURS=24
RECONCILIATION_BATCH_SIZE=100
RECONCILIATION_INTERVAL_MINUTES=10

# Optional: Redis for Bull queue (production)
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 11.2 SteVe Configuration (`application-prod.properties`)

```properties
# src/main/resources/application-prod.properties

# REST API — REQUIRED for VoltStartEV integration
rest.enabled=true
rest.api.path=/steve/api/v1

# Database
db.ip = localhost
db.port = 3306
db.schema = stevedb
db.user = steve
db.password = <secure-password>

# Server
server.address = 0.0.0.0
server.port = 8080
server.gzip.enabled = true

# OCPP WebSocket Server (CRITICAL for chargers)
ocpp.j.server.port = 8880
ocpp.j.server.host = 0.0.0.0

# WebSocket session strategy
ws.session.select.strategy = ALWAYS_LAST

# Security: Reject unknown chargers (do NOT enable auto.register.unknown.stations in production)
auto.register.unknown.stations = false

# Logging
logging.level.de.rwth.idsg.steve=INFO
logging.level.de.rwth.idsg.steve.ocpp=INFO
logging.level.de.rwth.idsg.steve.web.api=INFO

# Optional: Disable Swagger UI in production
springdoc.swagger-ui.enabled=false
springdoc.api-docs.enabled=false
```

### 11.3 Deployment Checklist

| Step | Command/Action | Verification |
|------|---------------|-------------|
| 1. Build backend | `npm run build` | `dist/` directory created |
| 2. Set environment variables | Export `.env` values or use secrets manager | `echo $STEVE_API_USER` shows value |
| 3. Start SteVe | `java -Dspring.profiles.active=prod -jar target/steve.war &` | `curl http://localhost:8080/steve/manager` returns login page |
| 4. Start VoltStartEV backend | `node dist/server.js` or PM2 | `curl http://localhost:3000/health` returns `{"status":"healthy"}` |
| 5. Test database connections | `curl http://localhost:3000/health` | `database.steve: true, database.app: true` |
| 6. Test REST API auth | `curl -u voltstart_backend:pass http://localhost:8080/steve/api/v1/ocppTags` | `200 OK` with JSON |
| 7. Test WebSocket | Connect via `wscat -c ws://localhost:3001/ws/charging -H "Authorization: Bearer <JWT>"` | Receives `{"type":"connected"}` |
| 8. Test end-to-end flow | Start charging via app, verify transaction in SteVe UI | Transaction appears in SteVe `transaction_start` table |

---

## 12. Operational Runbook

### 12.1 Monitoring & Alerting

**Key Metrics to Monitor**:
- API response times (p95 < 500ms)
- Database connection pool usage (< 80%)
- WebSocket connection count
- Reconciliation job success rate (> 95%)
- Error rate per endpoint (< 1%)

**Alerting Rules** (example for Prometheus/Grafana):
```yaml
# Alert if reconciliation job fails 3 times in 10 minutes
- alert: ReconciliationJobFailing
  expr: increase(reconciliation_job_errors_total[10m]) > 3
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Reconciliation job failing"
    description: "Reconciliation job has failed {{ $value }} times in last 10 minutes"

# Alert if SteVe DB connection pool > 90%
- alert: SteVeDBPoolHigh
  expr: steve_db_pool_active / steve_db_pool_max > 0.9
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "SteVe DB connection pool high"
    description: "SteVe DB pool usage is {{ $value | humanizePercentage }}"
```

### 12.2 Backup & Recovery

**Database Backups**:
```bash
# Daily backup script (run via cron)
#!/bin/bash
DATE=$(date +%Y%m%d)
mysqldump -u root -p stevedb > /backups/stevedb-$DATE.sql
mysqldump -u root -p voltstartev_db > /backups/voltstartev_db-$DATE.sql
# Encrypt and upload to S3 (optional)
```

**Recovery Procedure**:
1. Stop VoltStartEV backend
2. Restore databases from backup:
   ```bash
   mysql -u root -p stevedb < /backups/stevedb-20260305.sql
   mysql -u root -p voltstartev_db < /backups/voltstartev_db-20260305.sql
   ```
3. Restart backend
4. Verify with health check: `curl http://localhost:3000/health`

### 12.3 Incident Response

**Common Issues & Fixes**:

| Issue | Symptoms | Immediate Fix | Root Cause Prevention |
|-------|----------|--------------|---------------------|
| Service account auth fails | `401 Unauthorized` from SteVe API | Verify `api_password` is BCrypt-hashed in SteVe DB; restart backend | Automate credential rotation; add pre-deployment validation |
| Charger not recognized | `[ERROR] ChargeBoxId 'X' is not recognized` in SteVe logs | Register charger in `charge_box` table via SteVe UI or SQL | Add charger registration workflow to onboarding |
| Tag validation fails | `403 Authorization failed` from `/charging/start` | Check `user_ocpp_tag` linkage exists; verify tag not blocked/expired | Add admin UI for tag management; alert on validation failures |
| WebSocket connection fails | `Invalid token` or connection drops | Verify JWT is valid and not expired; check CORS/origin settings | Add connection retry logic in frontend; monitor WebSocket health |
| Reconciliation job stuck | No new billing records for offline chargers | Check job logs; increase batch size or lookback window; restart job | Add job timeout; implement dead-letter queue for failed records |

**Escalation Path**:
1. L1: Check logs (`/var/log/voltstartev/backend.log`, SteVe logs)
2. L2: Verify database connectivity and permissions
3. L3: Engage DevOps for infrastructure issues (network, disk, memory)
4. L4: Contact SteVe maintainers if OCPP protocol issues suspected

---

## 13. Appendices

### A. Database Migration Scripts

See `migrations/` directory for version-controlled schema changes.

**Example migration**: `migrations/20260305_add_reconciliation_constraint.sql`
```sql
-- Add UNIQUE constraint for reconciliation (idempotent billing)
ALTER TABLE charging_sessions 
ADD UNIQUE KEY uniq_steve_transaction_pk (steve_transaction_pk);

-- Add index for backfillUserLinks query
CREATE INDEX idx_charging_sessions_id_tag ON charging_sessions(id_tag);
```

### B. API Documentation

Generated OpenAPI spec available at: `/api-docs` (disable in production via `springdoc.api-docs.enabled=false`)

**Interactive Swagger UI**: `/swagger-ui/index.html` (disable in production)

### C. Troubleshooting Guide

| Issue | Symptom | Solution |
|-------|---------|----------|
| Service account auth fails | `401 Unauthorized` from SteVe | Verify `api_password` is BCrypt-hashed in `web_user` table; restart SteVe after DB changes |
| Charger not recognized | `[ERROR] ChargeBoxId 'X' is not recognized` | Register charger in `charge_box` table; ensure `registration_status = 'Accepted'` |
| Tag validation fails | `403 Authorization failed` | Check `user_ocpp_tag` linkage; verify tag not blocked/expired in `ocpp_tag_activity` |
| WebSocket connection fails | `Invalid token` or drops | Verify JWT is valid; check `APP_ORIGIN` CORS settings; ensure WS path matches |
| Transaction ID gap not resolved | Frontend stuck with `transactionId: 0` | Verify polling endpoint `/session/active?idTag=X` returns real ID; check WebSocket events |
| Duplicate billing records | `charging_sessions` has duplicate `steve_transaction_pk` | Ensure UNIQUE constraint exists; check reconciliation job uses `INSERT IGNORE` |
| Reconciliation job errors | Logs show `ERROR` for specific transactions | Check SteVe DB connectivity; verify `transaction_stop` records exist; increase lookback window |

### D. Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.1 | 2026-03-05 | Added Transaction ID Gap handling, Repository Pattern docs, Idempotent Stop logic, Reconciliation Worker section |
| 1.0 | 2026-03-05 | Initial release with Service Account pattern, dual charging flows, billing, WebSocket updates |

### E. Glossary

| Term | Definition |
|------|-----------|
| **Service Account** | A dedicated backend user (`voltstart_backend`) used for authenticating VoltStartEV → SteVe API calls |
| **OCPP Tag** | An RFID/App identifier used for authorization in OCPP protocol (stored in SteVe `ocpp_tag` table) |
| **Transaction ID Gap** | The delay between RemoteStart command acceptance and actual `transaction_pk` assignment in SteVe |
| **Reconciliation** | Background job that catches offline/deferred transactions to ensure complete billing |
| **Idempotent Stop** | Logic that treats "Stop" as "Ensure stopped", handling race conditions gracefully |

---

## Document Maintenance

**This document should be updated whenever**:
- New API endpoints are added or modified
- Database schema changes are made (SteVe or VoltStartEV DB)
- Security configurations are modified (auth, rate limiting, CORS)
- Architecture patterns are updated (e.g., switching from polling to WebSockets for transaction detection)
- Operational procedures change (backup, monitoring, incident response)

**Review Cycle**: Quarterly, or after any major incident

**Owners**: 
- Architecture: Backend Lead
- Security: DevSecOps Engineer
- Operations: SRE Team

---

*Document generated on: March 5, 2026*  
*Next scheduled review: June 5, 2026*  

⚡ **VoltStartEV — Powering the Future of EV Charging** ⚡
