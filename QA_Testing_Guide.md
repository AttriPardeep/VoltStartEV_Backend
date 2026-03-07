# ⚡ VoltStartEV Backend - QA Testing Guide

**Version:** 1.0  
**Last Updated:** March 6, 2026  
**Audience:** QA Engineers, Testers

---

## 📋 Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Test Data Setup](#2-test-data-setup)
3. [Authentication & User Management](#3-authentication--user-management)
4. [Tag Management](#4-tag-management)
5. [Charging Session Operations](#5-charging-session-operations)
6. [Session History & Billing](#6-session-history--billing)
7. [Health & Status Checks](#7-health--status-checks)
8. [Error Scenarios to Test](#8-error-scenarios-to-test)
9. [Test Results Template](#9-test-results-template)

---

## 1. Prerequisites

### 1.1 Environment Setup

| Component | URL/Value | Notes |
|-----------|-----------|-------|
| **Backend URL** | `http://localhost:3000` | VoltStartEV backend |
| **SteVe API URL** | `http://localhost:8080/steve` | SteVe OCPP server |
| **Database** | MySQL | `stevedb` + `voltstartev_db` |
| **Test Charger** | `CS-SIEMENS-00001` | Must be registered in SteVe |
| **Test Tags** | `USER001`, `USER002`, etc. | Must exist in `stevedb.ocpp_tag` |

### 1.2 Tools Required

```bash
# Required tools
curl          # HTTP requests
jq            # JSON parsing
mysql         # Database verification
```

### 1.3 Verify Backend is Running

```bash
curl http://localhost:3000/health | jq
```

✅ **Expected Response**:
```json
{
  "status": "healthy",
  "database": {
    "steve": true,
    "app": true
  },
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

## 2. Test Data Setup

### 2.1 Create Test User

```bash
# Register new test user
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "qatest001",
    "email": "qa001@voltstartev.com",
    "password": "QATest123!",
    "firstName": "QA",
    "lastName": "Test"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "userId": 10,
    "username": "qatest001",
    "email": "qa001@voltstartev.com",
    "token": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

📝 **Save the `userId` and `token` for subsequent tests.**

---

### 2.2 Verify Tag Exists in SteVe

```bash
# Check if test tag exists via SteVe API
curl -u 'voltstart_backend:ServiceSecretKey_2026!' \
  "http://localhost:8080/steve/api/v1/ocppTags?idTag=USER001" | jq
```

✅ **Expected**: Tag details with `ocppTagPk`

❌ **If tag doesn't exist**, create it via SteVe UI or:
```bash
curl -X POST http://localhost:8080/steve/api/v1/ocppTags \
  -u 'voltstart_backend:ServiceSecretKey_2026!' \
  -H "Content-Type: application/json" \
  -d '{
    "idTag": "USER001",
    "maxActiveTransactionCount": 1,
    "note": "QA Test Tag"
  }' | jq
```

---

### 2.3 Assign Tag to Test User

```bash
# Assign USER001 to the test user (replace USER_ID with actual userId)
curl -X POST http://localhost:3000/api/users/10/tags \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_FROM_REGISTRATION>" \
  -d '{
    "idTag": "USER001",
    "nickname": "QA Test Card"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Tag assigned successfully",
  "data": {
    "userId": 10,
    "idTag": "USER001",
    "nickname": "QA Test Card",
    "ocppTagPk": 191
  }
}
```

---

## 3. Authentication & User Management

### 3.1 Login with Registered User

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "qatest001",
    "password": "QATest123!"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "userId": 10,
      "username": "qatest001",
      "email": "qa001@voltstartev.com",
      "firstName": "QA",
      "lastName": "Test"
    }
  }
}
```

📝 **Save this token for all authenticated requests.**

---

### 3.2 Login with Wrong Password (Negative Test)

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "qatest001",
    "password": "WrongPassword123!"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Invalid credentials"
}
```

---

### 3.3 Login with Non-Existent User (Negative Test)

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "nonexistentuser",
    "password": "AnyPassword123!"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Invalid credentials"
}
```

---

### 3.4 Register Duplicate User (Negative Test)

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "qatest001",
    "email": "qa001@voltstartev.com",
    "password": "QATest123!"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Conflict",
  "message": "Username or email already registered"
}
```

---

### 3.5 Register User with Missing Fields (Negative Test)

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "incompleteuser"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Bad request",
  "message": "username, email, and password are required"
}
```

---


## 4. Tag Management

### 4.1 Get Tags Assigned to User

```bash
# Replace USER_ID and TOKEN with actual values
curl -X GET http://localhost:3000/api/users/10/tags \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "data": {
    "userId": 10,
    "tags": [
      {
        "ocppTagPk": 191,
        "id_tag": "USER001",
        "expiry_date": null,
        "max_active_transaction_count": 1,
        "blocked": false,
        "active_transaction_count": 0,
        "assigned_at": "2026-03-06T18:00:00.000Z"
      }
    ]
  }
}
```

---

### 4.2 Get User Assigned to Specific Tag

```bash
curl -X GET http://localhost:3000/api/tags/USER001/assignment \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "data": {
    "app_user_id": 10,
    "rfid_tag": "USER001",
    "expiry_date": null,
    "blocked": false,
    "assigned_at": "2026-03-06T18:00:00.000Z"
  }
}
```

---

### 4.3 Get All Tags with Assignment Status

```bash
curl -X GET http://localhost:3000/api/tags \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "data": {
    "tags": [
      {
        "ocpp_tag_pk": 191,
        "id_tag": "USER001",
        "expiry_date": null,
        "max_active_transaction_count": 1,
        "blocked": false,
        "active_transaction_count": 0,
        "assigned_to_user": 10
      },
      {
        "ocpp_tag_pk": 192,
        "id_tag": "USER002",
        "expiry_date": null,
        "max_active_transaction_count": 1,
        "blocked": false,
        "active_transaction_count": 0,
        "assigned_to_user": null
      }
    ]
  }
}
```

---

### 4.4 Assign Tag Already Assigned to Another User (Negative Test)

```bash
# First assign USER001 to user 10, then try to assign to user 11
curl -X POST http://localhost:3000/api/users/11/tags \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "idTag": "USER001",
    "nickname": "Another User Card"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Conflict",
  "message": "Tag USER001 is already assigned to user 10. Unassign it first via admin endpoint.",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 4.5 Assign Non-Existent Tag (Negative Test)

```bash
curl -X POST http://localhost:3000/api/users/10/tags \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "idTag": "NONEXISTENT_TAG",
    "nickname": "Fake Card"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Not found",
  "message": "Tag NONEXISTENT_TAG does not exist in SteVe. Please provision it via SteVe admin UI first.",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 4.6 Remove Tag from User

```bash
curl -X DELETE http://localhost:3000/api/users/10/tags/USER001 \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Tag removed successfully"
}
```

---

### 4.7 Admin: Unassign Tag from Any User

```bash
# Admin endpoint - requires admin role (implement role check in production)
curl -X POST http://localhost:3000/api/admin/tags/USER001/unassign \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Tag USER001 unassigned successfully",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

## 5. Charging Session Operations

### 5.1 Start Charging Session (Valid Request)

```bash
# Ensure USER001 is assigned to the authenticated user first
curl -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "idTag": "USER001"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Charging session initiated",
  "data": {
    "transactionId": 0,
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "estimatedStartTime": "2026-03-06T18:05:00.000Z"
  },
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

> ⚠️ **Note**: `transactionId: 0` is a placeholder. Poll `/session/active` to get the real transaction ID.

---

### 5.2 Start Charging Without Authorization (Negative Test)

```bash
curl -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "idTag": "USER001"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Authorization header with Bearer token is required",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 5.3 Start Charging with Invalid Token (Negative Test)

```bash
curl -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid.token.here" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "idTag": "USER001"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Invalid or expired token",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 5.4 Start Charging with Unassigned Tag (Negative Test)

```bash
# Use a tag NOT assigned to the authenticated user
curl -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "idTag": "USER999"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Authorization failed",
  "message": "RFID tag USER999 is not assigned to your account",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 5.5 Start Charging with Missing Fields (Negative Test)

```bash
curl -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Bad request",
  "message": "chargeBoxId, connectorId, and idTag are required",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---
### 5.6 Start Charging with Unavailable Charger (Negative Test)

```bash
# Use a charger that is NOT in 'Available' status
curl -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00002",
    "connectorId": 1,
    "idTag": "USER001"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Conflict",
  "message": "Charger is Faulted. Please try another charger.",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 5.7 Poll for Real Transaction ID

```bash
# Poll every 3 seconds until transactionId is found
for i in {1..10}; do
  echo "=== Poll Attempt $i ==="
  curl -s "http://localhost:3000/api/charging/session/active?idTag=USER001" \
    -H "Authorization: Bearer <TOKEN>" | jq '.data'
  sleep 3
done
```

✅ **Expected Response (Pending)**:
```json
{
  "status": "pending",
  "message": "Waiting for charger to start session"
}
```

✅ **Expected Response (Active)**:
```json
{
  "status": "active",
  "transactionId": 228,
  "chargeBoxId": "CS-SIEMENS-00001",
  "connectorId": 1,
  "startTime": "2026-03-06T18:00:35.000Z"
}
```

📝 **Save the real `transactionId` for stop command.**

---

### 5.8 Stop Charging Session

```bash
# Replace TRANSACTION_ID with real ID from polling
curl -X POST http://localhost:3000/api/charging/stop \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001",
    "transactionId": 228
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Stop command sent to charger",
  "data": {
    "transactionId": 228,
    "chargeBoxId": "CS-SIEMENS-00001",
    "alreadyStopped": false
  },
  "timestamp": "2026-03-06T18:05:00.000Z"
}
```

---

### 5.9 Stop Already Stopped Session (Idempotent Test)

```bash
# Try to stop the same transaction again
curl -X POST http://localhost:3000/api/charging/stop \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001",
    "transactionId": 228
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "message": "Session already finished",
  "data": {
    "transactionId": 228,
    "chargeBoxId": "CS-SIEMENS-00001",
    "alreadyStopped": true
  },
  "timestamp": "2026-03-06T18:05:05.000Z"
}
```

---

### 5.10 Stop with Missing Fields (Negative Test)

```bash
curl -X POST http://localhost:3000/api/charging/stop \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "chargeBoxId": "CS-SIEMENS-00001"
  }' | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Bad request",
  "message": "transactionId and chargeBoxId are required",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

## 6. Session History & Billing

### 6.1 Get Session History for User

```bash
curl -X GET "http://localhost:3000/api/charging/sessions?limit=10" \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "data": [
    {
      "session_id": 1,
      "charge_box_id": "CS-SIEMENS-00001",
      "connector_id": 1,
      "id_tag": "USER001",
      "start_time": "2026-03-06T18:00:30.000Z",
      "end_time": "2026-03-06T18:05:00.000Z",
      "duration_seconds": 270,
      "energy_kwh": 5.450,
      "total_cost": 1.86,
      "status": "completed",
      "payment_status": "pending",
      "stop_reason": "Remote"
    }
  ],
  "timestamp": "2026-03-06T18:10:00.000Z"
}
```

---

### 6.2 Get Session Summary by Transaction ID

```bash
curl -X GET http://localhost:3000/api/charging/sessions/228 \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": true,
  "summary": {
    "transactionId": 228,
    "chargeBoxId": "CS-SIEMENS-00001",
    "connectorId": 1,
    "idTag": "USER001",
    "startTime": "2026-03-06T18:00:30.000Z",
    "stopTime": "2026-03-06T18:05:00.000Z",
    "durationSeconds": 270,
    "startMeterValue": 10000,
    "stopMeterValue": 15450,
    "energyKwh": 5.450,
    "stopReason": "Remote",
    "billing": {
      "ratePerKwh": 0.25,
      "sessionFee": 0.50,
      "totalCost": 1.86,
      "currency": "USD"
    }
  },
  "timestamp": "2026-03-06T18:10:00.000Z"
}
```

---

### 6.3 Get Session Summary for Non-Existent Transaction (Negative Test)

```bash
curl -X GET http://localhost:3000/api/charging/sessions/99999 \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response**:
```json
{
  "success": false,
  "error": "Not found",
  "message": "Transaction 99999 not found or not completed",
  "timestamp": "2026-03-06T18:10:00.000Z"
}
```

---

### 6.4 Get Active Session for User

```bash
curl -X GET http://localhost:3000/api/charging/session/active \
  -H "Authorization: Bearer <TOKEN>" | jq
```

✅ **Expected Response (No Active Session)**:
```json
{
  "success": true,
  "data": null,
  "timestamp": "2026-03-06T18:10:00.000Z"
}
```

✅ **Expected Response (Active Session)**:
```json
{
  "success": true,
  "data": {
    "session_id": 2,
    "steve_transaction_pk": 229,
    "charge_box_id": "CS-SIEMENS-00001",
    "start_time": "2026-03-06T18:10:00.000Z",
    "status": "active"
  },
  "timestamp": "2026-03-06T18:10:05.000Z"
}
```

---

## 7. Health & Status Checks

### 7.1 Health Check Endpoint

```bash
curl http://localhost:3000/health | jq
```

✅ **Expected Response**:
```json
{
  "status": "healthy",
  "database": {
    "steve": true,
    "app": true
  },
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

### 7.2 Health Check with Database Down (Negative Test)

```bash
# Stop MySQL temporarily (only in test environment!)
# sudo systemctl stop mysql

curl http://localhost:3000/health | jq

# Restart MySQL
# sudo systemctl start mysql
```

✅ **Expected Response**:
```json
{
  "status": "unhealthy",
  "database": {
    "steve": false,
    "app": false
  },
  "error": "Database connection failed",
  "timestamp": "2026-03-06T18:00:00.000Z"
}
```

---

## 8. Error Scenarios to Test

| # | Scenario | Endpoint | Expected HTTP Status | Expected Error Message |
|---|----------|----------|---------------------|----------------------|
| 1 | Missing Authorization header | Any authenticated endpoint | `401` | `"Authorization header with Bearer token is required"` |
| 2 | Invalid/Expired JWT token | Any authenticated endpoint | `401` | `"Invalid or expired token"` |
| 3 | Tag not assigned to user | `POST /api/charging/start` | `403` | `"RFID tag X is not assigned to your account"` |
| 4 | Tag doesn't exist in SteVe | `POST /api/users/:id/tags` | `404` | `"Tag X does not exist in SteVe"` |
| 5 | Tag already assigned to another user | `POST /api/users/:id/tags` | `409` | `"Tag X is already assigned to user Y"` |
| 6 | Duplicate user registration | `POST /api/users` | `409` | `"Username or email already registered"` |
| 7 | Invalid credentials (login) | `POST /api/users/login` | `401` | `"Invalid credentials"` |
| 8 | Charger not available | `POST /api/charging/start` | `409` | `"Charger is X. Please try another charger."` |
| 9 | Missing required fields | Any POST endpoint | `400` | `"X, Y, and Z are required"` |
| 10 | Non-existent transaction | `GET /api/charging/sessions/:id` | `404` | `"Transaction X not found"` |
| 11 | Stop already stopped session | `POST /api/charging/stop` | `202` | `"Session already finished"` (success, not error) |
| 12 | Database connection failure | `GET /health` | `503` | `"Database connection failed"` |

---

## 9. Test Results Template

### 9.1 Test Execution Log

| Test ID | Test Name | Endpoint | Expected Status | Actual Status | Pass/Fail | Notes |
|---------|-----------|----------|----------------|---------------|-----------|-------|
| AUTH-01 | User Registration | `POST /api/users` | 201 | | | |
| AUTH-02 | User Login | `POST /api/users/login` | 200 | | | |
| AUTH-03 | Login Wrong Password | `POST /api/users/login` | 401 | | | |
| AUTH-04 | Duplicate User | `POST /api/users` | 409 | | | |
| TAG-01 | Assign Tag to User | `POST /api/users/:id/tags` | 201 | | | |
| TAG-02 | Get User Tags | `GET /api/users/:id/tags` | 200 | | | |
| TAG-03 | Get Tag Assignment | `GET /api/tags/:idTag/assignment` | 200 | | | |
| TAG-04 | Assign Assigned Tag | `POST /api/users/:id/tags` | 409 | | | |
| TAG-05 | Remove Tag | `DELETE /api/users/:id/tags/:idTag` | 200 | | | |
| CHG-01 | Start Charging | `POST /api/charging/start` | 202 | | | |
| CHG-02 | Start Without Auth | `POST /api/charging/start` | 401 | | | |
| CHG-03 | Start Unassigned Tag | `POST /api/charging/start` | 403 | | | |
| CHG-04 | Poll Transaction ID | `GET /api/charging/session/active` | 200 | | | |
| CHG-05 | Stop Charging | `POST /api/charging/stop` | 202 | | | |
| CHG-06 | Stop Already Stopped | `POST /api/charging/stop` | 202 | | | |
| SES-01 | Get Session History | `GET /api/charging/sessions` | 200 | | | |
| SES-02 | Get Session Summary | `GET /api/charging/sessions/:id` | 200 | | | |
| SES-03 | Get Active Session | `GET /api/charging/session/active` | 200 | | | |
| HLTH-01 | Health Check | `GET /health` | 200 | | | |

---

### 9.2 Test Summary

| Category | Total Tests | Passed | Failed | Skipped | Pass Rate |
|----------|-------------|--------|--------|---------|-----------|
| Authentication | 4 | | | | |
| Tag Management | 5 | | | | |
| Charging Operations | 6 | | | | |
| Session History | 3 | | | | |
| Health Checks | 1 | | | | |
| **TOTAL** | **19** | | | | |

**Test Executed By:** ___________________  
**Date:** ___ / ___ / 2026  
**Environment:** ☐ Development ☐ Staging ☐ Production  
**Backend Version:** _______________  
**Sign-off:** ___________________

---

## 📞 Support & Escalation

| Issue Type | Contact | Response Time |
|------------|---------|---------------|
| Test Environment Issues | DevOps Team | 2 hours |
| API Bugs | Backend Team | 4 hours |
| Database Issues | DBA Team | 1 hour |
| Critical Production Issues | On-Call Engineer | 15 minutes |

---

## 📝 Notes for QA Team

1. **Always use fresh test users** for each test cycle to avoid data conflicts
2. **Clean up test data** after each test run (unassign tags, delete test users)
3. **Document any deviations** from expected responses in the test log
4. **Test in order** - some tests depend on previous test results (e.g., need token from login)
5. **Verify database state** after critical operations using MySQL queries
6. **Report all 4xx/5xx errors** even if expected - include full response body
7. **Test with different chargers** if multiple are available
8. **Verify billing calculations** match expected rates (0.25 USD/kWh + 0.50 USD session fee)

---

## 🔗 Quick Reference: Common Variables

```bash
# Set these once per test session
export BASE_URL="http://localhost:3000"
export TOKEN="eyJhbGciOiJIUzI1NiIs..."  # From login response
export USER_ID="10"                      # From registration response
export CHARGER_ID="CS-SIEMENS-00001"
export TAG_ID="USER001"
export TRANSACTION_ID="228"              # From polling response

# Example usage
curl -X POST $BASE_URL/api/charging/start \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"chargeBoxId\":\"$CHARGER_ID\",\"connectorId\":1,\"idTag\":\"$TAG_ID\"}" | jq
```

---

**Document End**

---

*This guide should be updated whenever:*
- *New API endpoints are added*
- *Response formats change*
- *Error messages are modified*
- *New test scenarios are identified*

**Next Review Date:** June 6, 2026

⚡ **VoltStartEV — Powering the Future of EV Charging** ⚡
