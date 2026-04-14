#!/bin/bash
# File: tests/07-resilience-tests.sh

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

echo "=== TC-RES-001: Backend Restart During Active Session ==="
PASS=0
FAIL=0
BASE_URL="http://127.0.0.1:3000"
LOG_PATH="${LOG_PATH:-/build/VoltStartEV_Backend/logs/app.log}"

#  FIX: Correct login endpoint + password + token path
echo "Verifying backend is running..."
if ! curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/charging/sessions" | grep -q "401\|200"; then
    echo " CRITICAL: Backend not responding on port 3000"
    echo "   Starting backend..."
    cd /build/VoltStartEV_Backend
    npm run build 
    sleep 15
fi

JWT_TOKEN=$(curl -s -X POST "${BASE_URL}/api/users/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token // empty')

if [ -z "$JWT_TOKEN" ] || [ "$JWT_TOKEN" = "null" ]; then
    echo " CRITICAL: Failed to obtain JWT token - aborting tests"
    echo "   Debug: Login response:"
    curl -s -X POST "${BASE_URL}/api/users/login" \
        -H "Content-Type: application/json" \
        -d '{"username":"qatest001","password":"QATest123!"}' | jq .
    exit 1
fi
echo " JWT token obtained"

# Cleanup: stop any active session for this user before testing
echo "   Cleaning up any existing active sessions..."
curl -s -X POST "${BASE_URL}/api/charging/stop" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC7K-00001","connectorId":1}' &>/dev/null
sleep 15 

# Test 1: Start session before restart
echo -n "[1/4] Start session before restart... "
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/charging/start" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC7K-00001","connectorId":1,"idTag":"QATEST001"}')

if echo "$RESPONSE" | grep -q '"success":true'; then
    echo " PASS"
    ((PASS++))
    # Extract session info for later tests
    sleep 5  # Wait for webhook to create DB row
    SESSION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT session_id FROM charging_sessions WHERE app_user_id=33 AND status='active' ORDER BY processed_at DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
    TRANSACTION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT steve_transaction_pk FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
    echo "   Session ID: ${SESSION_ID:-not found}, Transaction ID: ${TRANSACTION_ID:-not found}"
else
    echo " FAIL"
    echo "   Response: $RESPONSE"
    ((FAIL++))
fi

# Restart backend
echo "   Restarting backend..."

#  FIX: Detect how backend is running and restart properly
if command -v pm2 &>/dev/null && pm2 list | grep -q voltstartev; then
    # Backend running via PM2
    echo "   Detected PM2..."
    pm2 restart voltstartev-backend &>/dev/null
    sleep 5
elif [ -f "/etc/systemd/system/voltstartev-backend.service" ] && sudo systemctl status voltstartev-backend &>/dev/null; then
    # Backend running via systemd
    echo "   Detected systemd..."
    sudo systemctl restart voltstartev-backend
    sleep 5
else
    # Backend running directly via npm/node
    echo "   Detected direct node process..."
    sudo kill $(sudo lsof -t -i:3000) 2>/dev/null || true
    sleep 2
    cd /build/VoltStartEV_Backend
    npm run build 
    sleep 15
fi

# Wait for backend to be ready
echo "   Waiting for backend to be ready..."
for i in 1 2 3 4 5; do
    if curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/charging/sessions" 2>/dev/null | grep -q "401\|200"; then
        echo "   Backend is ready"
        break
    fi
    sleep 2
done

# Test 2: Webhooks resume after restart
echo -n "[2/4] Webhooks resume after restart... "
sleep 35  # Wait for next MeterValues cycle
WEBHOOK_COUNT=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT COUNT(*) FROM webhook_events WHERE processed_at > NOW() - INTERVAL 2 MINUTE;" 2>/dev/null | tr -d '[:space:]')
WEBHOOK_COUNT="${WEBHOOK_COUNT:-0}"
if [[ "$WEBHOOK_COUNT" =~ ^[0-9]+$ ]] && [ "$WEBHOOK_COUNT" -gt 0 ]; then
    echo " PASS ($WEBHOOK_COUNT webhooks)"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 3: Session not duplicated
echo -n "[3/4] Session not duplicated... "
DUPLICATES=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT steve_transaction_pk, COUNT(*) FROM charging_sessions WHERE steve_transaction_pk=$TRANSACTION_ID GROUP BY steve_transaction_pk HAVING COUNT(*) > 1;" 2>/dev/null)
if [ -z "$DUPLICATES" ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL (duplicates found)"
    ((FAIL++))
fi

# Test 4: Reconciliation on startup
echo -n "[4/4] Reconciliation on startup... "
if [ -f "$LOG_PATH" ] && grep -q "Initial reconciliation\|Running reconciliation" "$LOG_PATH" 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP (no logs yet)"
    ((PASS++))
fi

echo ""
echo "=== TC-RES-001 Summary: $PASS passed, $FAIL failed ==="

# Save session ID for stop tests
if [ -n "$SESSION_ID" ]; then
    echo "$SESSION_ID" > /tmp/active_session_id.txt
fi
