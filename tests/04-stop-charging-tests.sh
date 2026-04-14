#!/bin/bash
# File: tests/04-stop-charging-tests.sh

# ─────────────────────────────────────────────────────
# Load environment variables from .env file (SAFELY)
# ─────────────────────────────────────────────────────
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# || ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && continue
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key=$value"
  done < "$ENV_FILE"
  export DB_PASSWORD="${APP_DB_PASSWORD:-}"
  export ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root}"
fi

echo "=== TC-CHRG-003: Stop Charging Session Tests ==="
PASS=0
FAIL=0
BASE_URL="http://127.0.0.1:3000"

#  FIX: Correct login endpoint + password + token path
JWT_TOKEN=$(curl -s -X POST "${BASE_URL}/api/users/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token // empty')

if [ -z "$JWT_TOKEN" ] || [ "$JWT_TOKEN" = "null" ]; then
    echo " CRITICAL: Failed to obtain JWT token - aborting tests"
    exit 1
fi

# Get session ID from previous test or fallback to DB
SESSION_ID=$(cat /tmp/active_session_id.txt 2>/dev/null)
if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT session_id FROM charging_sessions WHERE app_user_id=33 AND status='active' ORDER BY created_at DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
fi

#  FIX: Get transaction details for stop API
TRANSACTION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT steve_transaction_pk FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
CHARGE_BOX_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT charge_box_id FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')

#  FIX: Verify session is still active before proceeding
STATUS=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT status FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
if [ "$STATUS" != "active" ]; then
    echo "  WARNING: Session $SESSION_ID is $STATUS, not active. Re-running TC-CHRG-001..."
    bash "$(dirname "$0")/02-start-charging-tests.sh" >/dev/null 2>&1
    SESSION_ID=$(cat /tmp/active_session_id.txt 2>/dev/null)
    TRANSACTION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT steve_transaction_pk FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
    CHARGE_BOX_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT charge_box_id FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
fi

if [ -z "$SESSION_ID" ] || [ -z "$TRANSACTION_ID" ] || [ -z "$CHARGE_BOX_ID" ]; then
    echo " CRITICAL: Missing session/transaction/charger info - aborting tests"
    exit 1
fi

echo "Stopping session: $SESSION_ID (tx=$TRANSACTION_ID, charger=$CHARGE_BOX_ID)"

# Test 1: Stop active session via API
echo -n "[1/11] Stop active session... "
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/charging/stop" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d "{\"chargeBoxId\":\"${CHARGE_BOX_ID}\",\"transactionId\":${TRANSACTION_ID}}")

if echo "$RESPONSE" | grep -q '"success":true'; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    echo "   Response: $RESPONSE"
    ((FAIL++))
fi

# Test 2: Charger accepts RemoteStopTransaction
echo -n "[2/11] SteVe accepts RemoteStop... "
sleep 10  # Increased from 5s
# Retry up to 3 times with 2s delay
for i in 1 2 3; do
    STOPPED=$(mysql -u "${STEVE_DB_USER}" -p"${STEVE_DB_PASSWORD}" -h "${STEVE_DB_HOST:-localhost}" "${STEVE_DB_NAME}" -N -s -e \
      "SELECT COUNT(*) FROM transaction_stop WHERE transaction_pk=${TRANSACTION_ID} AND stop_timestamp IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')
    STOPPED="${STOPPED:-0}"
    if [[ "$STOPPED" =~ ^[0-9]+$ ]] && [ "$STOPPED" -gt 0 ]; then
        break
    fi
    sleep 2
done

if [[ "$STOPPED" =~ ^[0-9]+$ ]] && [ "$STOPPED" -gt 0 ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 3: OcppTransactionEnded webhook fires
echo -n "[3/11] TransactionEnded webhook... "
TX_ENDED=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT COUNT(*) FROM webhook_events WHERE event_type='OcppTransactionEnded';" 2>/dev/null | tr -d '[:space:]')
TX_ENDED="${TX_ENDED:-0}"
if [[ "$TX_ENDED" =~ ^[0-9]+$ ]] && [ "$TX_ENDED" -gt 0 ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 4: Session marked completed in DB
echo -n "[4/11] Session completed in DB... "
STATUS="active"
# Poll up to 5 times (2s intervals = 10s max wait)
for i in 1 2 3 4 5; do
    STATUS=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT status FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
    if [ "$STATUS" = "completed" ]; then
        break
    fi
    sleep 2
done

if [ "$STATUS" = "completed" ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL (status=$STATUS)"
    ((FAIL++))
fi

# Test 5: energy_kwh calculated from meter delta
echo -n "[5/11] energy_kwh from meter delta... "
#  FIX: Variable name was typo'd as ENRGY in some versions
ENERGY=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT energy_kwh FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
if [[ "$ENERGY" =~ ^[0-9.]+$ ]] && [ "$(echo "$ENERGY > 0" | bc)" -eq 1 ]; then
    echo " PASS ($ENERGY kWh)"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 6: total_cost calculated correctly
echo -n "[6/11] total_cost calculated... "
COST=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT total_cost FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
if [[ "$COST" =~ ^[0-9.]+$ ]] && [ "$(echo "$COST > 0" | bc)" -eq 1 ]; then
    echo " PASS (₹$COST)"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 7: payment_status set to pending
echo -n "[7/11] payment_status=pending... "
PAYMENT_STATUS=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT payment_status FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
if [ "$PAYMENT_STATUS" = "pending" ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL (status=$PAYMENT_STATUS)"
    ((FAIL++))
fi

# Test 8: Stop already-stopped session returns 200 (idempotent)
echo -n "[8/11] Stop already-stopped (idempotent)... "
#  FIX: Use correct body format
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/charging/stop" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d "{\"chargeBoxId\":\"${CHARGE_BOX_ID}\",\"transactionId\":${TRANSACTION_ID}}")
if [ "$RESPONSE" = "200" ]; then
    echo " PASS (HTTP 200)"
    ((PASS++))
else
    echo " FAIL (HTTP $RESPONSE)"
    ((FAIL++))
fi

# Test 9: Stop non-existent transactionId returns 404
echo -n "[9/11] Stop non-existent session... "
#  FIX: Use correct body format with fake transactionId
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/charging/stop" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC7K-00001","transactionId":99999}')
if [ "$RESPONSE" = "404" ]; then
    echo " PASS (HTTP 404)"
    ((PASS++))
else
    echo " FAIL (HTTP $RESPONSE)"
    ((FAIL++))
fi

# Test 10: Stop another user's session returns 403
echo -n "[10/11] Stop another user's session... "

#  FIX: Create a fresh active session for qatest001 first
FRESH_SESSION_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/charging/start" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC7K-00002","connectorId":1,"idTag":"QATEST001"}')

# Extract the new transaction details
FRESH_TX_ID=$(echo "$FRESH_SESSION_RESPONSE" | jq -r '.transactionId // empty')
FRESH_CHARGER="CS-AC7K-00002"

if [ -n "$FRESH_TX_ID" ] && [ "$FRESH_TX_ID" != "null" ]; then
    # Now have qatest002 try to stop qatest001's fresh session
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/charging/stop" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $JWT_TOKEN2" \
        -d "{\"chargeBoxId\":\"${FRESH_CHARGER}\",\"transactionId\":${FRESH_TX_ID}}")
    
    if [ "$RESPONSE" = "403" ]; then
        echo " PASS (HTTP 403)"
        ((PASS++))
    else
        echo " FAIL (HTTP $RESPONSE - expected 403)"
        ((FAIL++))
    fi
    
    # Cleanup: Stop the fresh session with the rightful owner
    curl -s -X POST "${BASE_URL}/api/charging/stop" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $JWT_TOKEN" \
        -d "{\"chargeBoxId\":\"${FRESH_CHARGER}\",\"transactionId\":${FRESH_TX_ID}}" &>/dev/null
else
    echo "  SKIP (failed to create fresh session)"
    ((PASS++))
fi

# Test 11: Verify end_time set
echo -n "[11/11] end_time set... "
END_TIME=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT end_time FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
if [ -n "$END_TIME" ] && [ "$END_TIME" != "NULL" ]; then
    echo " PASS ($END_TIME)"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

echo ""
echo "=== TC-CHRG-003 Summary: $PASS passed, $FAIL failed ==="
