# VoltStartEV Backend - System Design Document

**Version:** 1.0  
**Last Updated:** March 5, 2026  
**Status:** Production Ready

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
12. [Appendices](#12-appendices)

---

## 1. Executive Summary

VoltStartEV is an EV charging management platform that provides:
- **App-initiated charging** via REST API
- **Physical RFID tag charging** via OCPP 1.6 protocol
- **Real-time session monitoring** via WebSocket
- **Billing and session history** tracking
- **User↔Tag authorization** for enhanced security

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Service Account Pattern** | SteVe acts as device manager; VoltStartEV backend handles user authentication and business logic |
| **Dual Charging Flows** | Support both physical RFID cards and mobile app control |
| **User↔Tag Validation** | Prevent unauthorized app users from using tags not assigned to them |
| **Separate Concerns** | VoltStartEV manages app users; SteVe manages OCPP infrastructure |

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
│  │  Flutter)    │    │ (Node.js/TS)     │    │ (Java)       │ │
│  └──────────────┘    └──────────────────┘    └──────┬───────┘ │
│         │                    │                      │          │
│         │ JWT Auth           │ Basic Auth           │ OCPP 1.6 │
│         │                    │ (Service Account)    │ JSON/SOAP│
│         │                    │                      │          │
│         ▼                    ▼                      ▼          │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐ │
│  │ VoltStartEV  │    │ SteVe DB         │    │ Chargers     │ │
│  │ App DB       │    │ (MySQL)          │    │ (SAP Sim/    │ │
│  │ (Users,      │    │ - ocpp_tag       │    │  Physical)   │ │
│  │  Sessions,   │    │ - user_ocpp_tag  │    │              │ │
│  │  Billing)    │    │ - charge_box     │    │              │ │
│  └──────────────┘    │ - transaction_*  │    └──────────────┘ │
│                      └──────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Service Account Pattern

**Principle**: VoltStartEV backend authenticates to SteVe using a single service account, not individual user credentials.

| Component | Credentials | Purpose |
|-----------|------------|---------|
| **Mobile App User** | JWT token (issued by VoltStartEV) | Authenticate to VoltStartEV backend |
| **VoltStartEV Backend** | Basic Auth: `voltstart_backend:ServiceSecretKey_2026!` | Call SteVe REST API |
| **SteVe Server** | `web_user` table (`api_password` BCrypt-hashed) | Authenticate REST API calls |
| **OCPP Charger** | WebSocket session + OCPP auth | Execute charging commands |

**Benefits**:
- ✅ SteVe never sees VoltStartEV app users
- ✅ Centralized user management in VoltStartEV
- ✅ Simplified credential rotation (one service account)
- ✅ Clear separation of concerns

---

## 3. Database Schema

### 3.1 SteVe Database (`stevedb`)

#### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `charge_box` | Registered charging stations | `charge_box_id`, `registration_status`, `ocpp_protocol` |
| `connector` | Individual connectors per charger | `charge_box_id`, `connector_id`, `connector_status` |
| `ocpp_tag` | RFID/App tags for authorization | `id_tag`, `expiry_date`, `max_active_transaction_count` |
| `ocpp_tag_activity` | Real-time tag status | `active_transaction_count`, `blocked`, `in_transaction` |
| `user` | SteVe internal users (operators/admins) | `user_pk`, `first_name`, `last_name`, `e_mail` |
| `user_ocpp_tag` | Link SteVe users to OCPP tags | `user_pk`, `ocpp_tag_pk` |
| `web_user` | Web UI + API authentication | `username`, `password` (BCrypt), `api_password` (BCrypt), `authorities` (JSON) |
| `transaction_start` | Transaction initiation records | `transaction_pk`, `connector_pk`, `id_tag`, `start_timestamp` |
| `transaction_stop` | Transaction completion records | `transaction_pk`, `stop_timestamp`, `stop_value`, `stop_reason` |
| `reservation` | Reserved charging sessions | `connector_pk`, `id_tag`, `start_datetime`, `expiry_datetime`, `status` |

#### Key Relationships

```sql
-- User↔Tag Linkage (for VoltStartEV app security)
CREATE TABLE user_ocpp_tag (
  user_pk INT NOT NULL COMMENT 'VoltStartEV app user ID',
  ocpp_tag_pk INT NOT NULL COMMENT 'SteVe ocpp_tag primary key',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_pk, ocpp_tag_pk),
  FOREIGN KEY (ocpp_tag_pk) REFERENCES ocpp_tag(ocpp_tag_pk) ON DELETE CASCADE,
  INDEX idx_ocpp_tag_pk (ocpp_tag_pk),
  INDEX idx_user_pk (user_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.2 VoltStartEV App Database

#### Billing & Session History

```sql
CREATE TABLE charging_sessions (
  session_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  app_user_id INT NOT NULL COMMENT 'VoltStartEV user ID',
  steve_transaction_pk INT COMMENT 'SteVe transaction primary key',
  charge_box_id VARCHAR(64) NOT NULL,
  connector_id INT NOT NULL,
  id_tag VARCHAR(64) NOT NULL COMMENT 'RFID/App tag used',
  
  -- Timing
  start_time DATETIME NOT NULL,
  end_time DATETIME NULL,
  duration_seconds INT GENERATED ALWAYS AS (
    CASE 
      WHEN end_time IS NOT NULL THEN TIMESTAMPDIFF(SECOND, start_time, end_time)
      ELSE NULL 
    END
  ) STORED,
  
  -- Energy & Cost
  start_meter_value DECIMAL(12,2) COMMENT 'Wh at start',
  end_meter_value DECIMAL(12,2) COMMENT 'Wh at end',
  energy_kwh DECIMAL(10,3) GENERATED ALWAYS AS (
    CASE 
      WHEN end_meter_value IS NOT NULL AND start_meter_value IS NOT NULL 
      THEN ROUND((end_meter_value - start_meter_value) / 1000, 3)
      ELSE NULL 
    END
  ) STORED,
  
  rate_per_kwh DECIMAL(8,4) DEFAULT 0.2500 COMMENT 'USD/kWh',
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
  stop_reason VARCHAR(64) COMMENT 'OCPP stop reason: Remote, Local, EVDisconnected, etc.',
  payment_status ENUM('pending', 'paid', 'failed', 'refunded') DEFAULT 'pending',
  payment_method VARCHAR(32) COMMENT 'card, wallet, invoice, etc.',
  
  -- Audit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Indexes
  INDEX idx_user_id (app_user_id),
  INDEX idx_charge_box (charge_box_id),
  INDEX idx_start_time (start_time),
  INDEX idx_status (status),
  UNIQUE KEY uniq_steve_transaction (steve_transaction_pk)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 4. Authentication & Authorization

### 4.1 VoltStartEV Backend → SteVe Authentication

**Method**: HTTP Basic Auth  
**Credentials**: Service account stored in environment variables

```bash
# .env file
STEVE_API_URL=http://localhost:8080/steve
STEVE_API_USER=voltstart_backend
STEVE_API_PASS=ServiceSecretKey_2026!  # Plain text in env; SteVe hashes internally
```

**SteVe Configuration**:
```sql
-- Service account in SteVe web_user table
INSERT INTO web_user (username, password, api_password, enabled, authorities)
VALUES (
  'voltstart_backend', 
  '$2a$10$<BCrypt-hash-of-web-password>',  -- For emergency web UI login
  '$2a$10$<BCrypt-hash-of-api-password>',  -- For REST API authentication
  1, 
  CAST('["ROLE_ADMIN","ROLE_API"]' AS JSON)
);
```

> 🔑 **Critical**: Both `password` and `api_password` fields require **BCrypt hashes**. SteVe hashes the input from curl and compares it to the stored hash.

### 4.2 Mobile App → VoltStartEV Backend Authentication

**Method**: JWT Bearer Token  
**Payload Structure**:
```typescript
interface JwtPayload {
  id: number;        // App user ID (e.g., 101)
  username: string;  // App username (e.g., 'user101')
  role: string;      // App role (e.g., 'customer')
  iat: number;       // Issued at timestamp
  exp: number;       // Expiration timestamp
}
```

**Middleware**:
```typescript
// src/middleware/auth.middleware.ts
export const authenticateJwt = (req: Request, res: Response, next: NextFunction) => {
  // Skip auth in development mode
  if (process.env.NODE_ENV === 'development') {
    (req as any).user = { id: 101, username: 'test-user', role: 'customer' };
    return next();
  }
  
  // Extract and verify JWT
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }
  
  const token = authHeader.substring(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    (req as any).user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};
```

### 4.3 User↔Tag Authorization

**Purpose**: Ensure app users can only use RFID tags assigned to them.

**Validation Flow**:
```typescript
// src/services/ocpp/auth.service.ts
export async function validateIdTagForUser(
  idTag: string, 
  appUserId: number
): Promise<AuthorizationResult> {
  // 1. Validate tag itself (expiry, blocked, concurrent tx)
  const tagValidation = await validateIdTag(idTag);
  if (tagValidation.status !== 'Accepted') {
    return tagValidation;
  }
  
  // 2. Check if app user is linked to this tag
  const [link] = await steveQuery(`
    SELECT 1 FROM user_ocpp_tag 
    WHERE user_pk = ? AND ocpp_tag_pk = (
      SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1
    )
    LIMIT 1
  `, [appUserId, idTag]);
  
  if (!link) {
    return { 
      status: 'Invalid', 
      reason: `RFID tag ${idTag} is not assigned to your account`
    };
  }
  
  return { ...tagValidation, status: 'Accepted' };
}
```

---

## 5. API Endpoints

### 5.1 Charging Session Management

#### POST `/api/charging/start`

**Purpose**: Initiate charging session via mobile app

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

**Response (Success)**:
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

**Response (Error - Unauthorized Tag)**:
```json
{
  "success": false,
  "error": "Authorization failed",
  "message": "RFID tag USER001 is not assigned to your account",
  "timestamp": "2026-03-05T12:10:30.514Z"
}
```

**Validation Sequence**:
1. ✅ JWT authentication
2. ✅ Required fields present
3. ✅ Charger status = 'Available'
4. ✅ User↔Tag linkage exists (`user_ocpp_tag`)
5. ✅ Tag not blocked/expired/over concurrent limit
6. ✅ Call SteVe REST API with service account
7. ✅ Return 202 Accepted

#### POST `/api/charging/stop`

**Purpose**: Stop active charging session

**Request**:
```json
{
  "chargeBoxId": "CS-SIEMENS-00001",
  "transactionId": 215
}
```

**Response**:
```json
{
  "success": true,
  "message": "Charging session stop requested",
  "data": {
    "transactionId": 215,
    "chargeBoxId": "CS-SIEMENS-00001"
  },
  "timestamp": "2026-03-05T12:12:01.479Z"
}
```

#### GET `/api/charging/sessions`

**Purpose**: Retrieve session history for authenticated user

**Query Parameters**:
- `limit` (optional, default: 20): Number of sessions to return

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "session_id": 1,
      "charge_box_id": "CS-SIEMENS-00001",
      "energy_kwh": 12.450,
      "total_cost": 3.61,
      "duration_seconds": 1845,
      "status": "completed",
      "payment_status": "pending"
    }
  ],
  "timestamp": "2026-03-05T12:15:00.000Z"
}
```

#### GET `/api/charging/session/active`

**Purpose**: Get currently active session for user

**Response**:
```json
{
  "success": true,
  "data": {
    "session_id": 2,
    "steve_transaction_pk": 215,
    "charge_box_id": "CS-SIEMENS-00001",
    "start_time": "2026-03-05T12:10:30.000Z",
    "status": "active"
  },
  "timestamp": "2026-03-05T12:15:00.000Z"
}
```

### 5.2 Tag Management

#### POST `/api/users/me/tags`

**Purpose**: Register physical RFID card for user

**Request**:
```json
{
  "tagId": "A1B2C3D4",
  "nickname": "My Work Card"
}
```

**Backend Actions**:
1. Insert tag into SteVe's `ocpp_tag` table (for RFID flow)
2. Link tag to app user in `user_ocpp_tag` (for app-flow security)
3. Store tag metadata in VoltStartEV app DB

**Response**:
```json
{
  "success": true,
  "message": "Tag registered successfully",
  "data": {
    "tagId": "A1B2C3D4",
    "ocppTagPk": 191
  }
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
       │                     │                      │                 │
       │                     │ 4. Validate user↔tag │                 │
       │                     │    SELECT FROM       │                 │
       │                     │    user_ocpp_tag     │                 │
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
       │                     │ 10. Polling detects  │                 │
       │                     │     transaction_start│                 │
       │                     │                      │                 │
       │ 11. WebSocket event │                      │                 │
       │     {type:          │                      │                 │
       │      "transaction:  │                      │                 │
       │      started"}      │                      │                 │
       │◀────────────────────│                      │                 │
       │                     │                      │                 │
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
```

---

## 7. Tag Management

### 7.1 Tag Provisioning Workflow

When a user registers a physical RFID card in the VoltStartEV app:

```typescript
// src/services/ocpp/tag-provisioning.service.ts
export async function provisionOcppTagInSteVe(
  idTag: string, 
  options?: {
    maxActiveTransactions?: number;
    expiryDate?: Date;
    note?: string;
  }
): Promise<{ ocppTagPk: number }> {
  // 1. Insert into ocpp_tag (SteVe DB)
  const [result] = await steveQuery(`
    INSERT INTO ocpp_tag (
      id_tag,
      max_active_transaction_count,
      expiry_date,
      note
    ) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE 
      max_active_transaction_count = VALUES(max_active_transaction_count),
      note = VALUES(note)
  `, [
    idTag,
    options?.maxActiveTransactions ?? 1,
    options?.expiryDate ?? null,
    options?.note ?? 'Provisioned by VoltStartEV app'
  ]);
  
  // 2. Get the primary key for linking
  const [tag] = await steveQuery(
    'SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1',
    [idTag]
  );
  
  return { ocppTagPk: tag.ocpp_tag_pk };
}

// 3. Link to app user in user_ocpp_tag
await steveQuery(`
  INSERT INTO user_ocpp_tag (user_pk, ocpp_tag_pk)
  VALUES (?, ?)
  ON DUPLICATE KEY UPDATE updated_at = NOW()
`, [appUserId, ocppTagPk]);
```

### 7.2 Tag Deactivation

Allow users to deactivate lost/stolen cards:

```typescript
// src/services/ocpp/tag-management.service.ts
export async function deactivateTag(idTag: string): Promise<void> {
  // Set blocked = 1 in ocpp_tag_activity
  await steveQuery(`
    UPDATE ocpp_tag_activity ota
    JOIN ocpp_tag ot ON ot.ocpp_tag_pk = ota.ocpp_tag_pk
    SET ota.blocked = 1
    WHERE ot.id_tag = ?
  `, [idTag]);
}
```

---

## 8. Billing & Session History

### 8.1 Session Creation

When polling detects a new `transaction_start` record:

```typescript
// src/services/billing/session.service.ts
export async function startBillingSession(data: SessionStartData): Promise<{ sessionId: number }> {
  const [result] = await appDb.query(`
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

### 8.2 Session Completion

When polling detects a `transaction_stop` record:

```typescript
export async function completeBillingSession(data: SessionStopData): Promise<{
  sessionId: number;
  energyKwh: number;
  totalCost: number;
}> {
  // Get session details
  const [session] = await appDb.query(`
    SELECT session_id, start_meter_value, rate_per_kwh, session_fee
    FROM charging_sessions
    WHERE steve_transaction_pk = ? AND status = 'active'
    LIMIT 1
  `, [data.steveTransactionPk]);
  
  // Calculate energy and cost
  const startValue = session.start_meter_value || 0;
  const energyKwh = Math.round((data.endMeterValue - startValue) / 10) / 100;
  const totalCost = Math.round((energyKwh * session.rate_per_kwh + session.session_fee) * 100) / 100;
  
  // Update session
  await appDb.query(`
    UPDATE charging_sessions
    SET 
      end_time = NOW(),
      end_meter_value = ?,
      stop_reason = ?,
      status = 'completed',
      payment_status = 'pending'
    WHERE steve_transaction_pk = ?
  `, [data.endMeterValue, data.stopReason || 'Remote', data.steveTransactionPk]);
  
  return { sessionId: session.session_id, energyKwh, totalCost };
}
```

---

## 9. Real-Time Updates

### 9.1 WebSocket Architecture

**Endpoint**: `ws://localhost:3001/ws/charging`

**Authentication**: Bearer token in WebSocket handshake

```typescript
// src/websocket/charging.websocket.ts
class ChargingWebSocketService {
  private clients: Map<string, WebSocketClient> = new Map();
  
  emitToUser(userId: number, event: string, payload: any) {
    const clientId = `user_${userId}`;
    const client = this.clients.get(clientId);
    
    if (client?.ws?.readyState === 1) { // WebSocket.OPEN
      client.ws.send(JSON.stringify({
        type: event,
        data: payload,
        timestamp: new Date().toISOString()
      }));
    }
  }
  
  emitToChargeBox(chargeBoxId: string, event: string, payload: any) {
    // Emit to all users subscribed to this charger
    for (const [clientId, client] of this.clients) {
      if (client.chargeBoxIds?.includes(chargeBoxId) && client.ws?.readyState === 1) {
        client.ws.send(JSON.stringify({
          type: event,
          chargeBoxId,
          data: payload,
          timestamp: new Date().toISOString()
        }));
      }
    }
  }
}
```

### 9.2 Event Types

| Event | Trigger | Payload |
|-------|---------|---------|
| `transaction:started` | New transaction detected via polling | `{transactionId, chargeBoxId, connectorId, idTag, startTime}` |
| `transaction:completed` | Transaction stop detected | `{transactionId, energyKwh, totalCost, duration, stopReason}` |
| `charger:status` | Connector status change | `{chargeBoxId, connectorId, status, timestamp}` |
| `session:billing` | Billing calculation complete | `{sessionId, energyKwh, totalCost, paymentStatus}` |

---

## 10. Security Considerations

### 10.1 Credential Management

| Credential | Storage | Rotation |
|-----------|---------|----------|
| `STEVE_API_PASS` | Environment variable (.env) | Monthly |
| `JWT_SECRET` | Environment variable (.env) | Quarterly |
| Database passwords | Environment variables | Quarterly |
| Service account `api_password` | SteVe DB (BCrypt hash) | Monthly |

### 10.2 Input Validation

```typescript
// Validate all incoming requests
const startChargingSchema = z.object({
  chargeBoxId: z.string().min(1).max(64),
  connectorId: z.number().int().positive(),
  idTag: z.string().min(1).max(64)
});

// Use Zod or similar for runtime validation
const result = startChargingSchema.safeParse(req.body);
if (!result.success) {
  return res.status(400).json({ error: 'Invalid request body' });
}
```

### 10.3 Rate Limiting

```typescript
// Per-user rate limiting
import rateLimit from 'express-rate-limit';

const chargingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  keyGenerator: (req) => (req as any).user?.id || req.ip,
  message: 'Too many requests, please try again later'
});

app.use('/api/charging', chargingLimiter);
```

### 10.4 Audit Logging

Log all critical operations:
- User authentication (success/failure)
- Tag provisioning/deactivation
- Charging session start/stop
- Billing calculations
- API errors

```typescript
logger.info('Charging started', {
  userId: appUserId,
  chargeBoxId,
  idTag,
  timestamp: new Date().toISOString(),
  ipAddress: req.ip
});
```

---

## 11. Deployment & Configuration

### 11.1 Environment Variables

```bash
# .env file (VoltStartEV Backend)
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.voltstartev.com

# SteVe REST API
STEVE_API_URL=http://localhost:8080/steve
STEVE_API_USER=voltstart_backend
STEVE_API_PASS=<secure-password>

# Database
STEVE_DB_HOST=localhost
STEVE_DB_PORT=3306
STEVE_DB_NAME=stevedb
STEVE_DB_USER=steve_readonly
STEVE_DB_PASSWORD=<secure-password>

# JWT
JWT_SECRET=<secure-random-string>
JWT_EXPIRES_IN=7d

# WebSocket
WS_PORT=3001
WS_PATH=/ws/charging
APP_ORIGIN=https://app.voltstartev.com

# Logging
LOG_LEVEL=info
LOG_FILE=/var/log/voltstartev/backend.log

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### 11.2 SteVe Configuration

```properties
# src/main/resources/application-prod.properties

# REST API
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

# OCPP WebSocket
ocpp.j.server.port = 8880
ocpp.j.server.host = 0.0.0.0

# Logging
logging.level.de.rwth.idsg.steve=INFO
logging.level.de.rwth.idsg.steve.ocpp=INFO
```

---

## 12. Appendices

### A. Database Migration Scripts

See `migrations/` directory for version-controlled schema changes.

### B. API Documentation

Generated OpenAPI spec available at: `/api-docs`

### C. Troubleshooting Guide

| Issue | Symptom | Solution |
|-------|---------|----------|
| Service account auth fails | `401 Unauthorized` from SteVe | Verify `api_password` is BCrypt-hashed in SteVe DB |
| Charger not recognized | `[ERROR] ChargeBoxId 'X' is not recognized` | Register charger in `charge_box` table |
| Tag validation fails | `403 Authorization failed` | Check `user_ocpp_tag` linkage exists |
| WebSocket connection fails | `Invalid token` | Verify JWT is valid and not expired |

### D. Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-05 | Initial release with Service Account pattern, dual charging flows, billing |

---

**Document End**

---

*This document should be updated whenever:*
- *New API endpoints are added*
- *Database schema changes are made*
- *Security configurations are modified*
- *Architecture patterns are updated*