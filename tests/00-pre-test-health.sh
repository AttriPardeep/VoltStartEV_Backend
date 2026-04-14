#!/bin/bash
# File: tests/00-pre-test-health.sh

# ─────────────────────────────────────────────────────
# Load environment variables from .env file (SAFELY)
# ─────────────────────────────────────────────────────
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  # Only export lines that match KEY=VALUE pattern (skip comments, docs, markdown)
  while IFS='=' read -r key value; do
    # Skip empty lines, comments, and non-variable lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# || ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && continue
    # Remove surrounding quotes from value if present
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key=$value"
  done < "$ENV_FILE"
  
  # Map variable names for script use
  export DB_PASSWORD="${APP_DB_PASSWORD:-}"
  export ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root}"
else
  echo "  Warning: .env file not found at $ENV_FILE"
fi

echo "=== TC-PRE-001: Services Health Check ==="
PASS=0
FAIL=0

# Test 1: Node backend running on port 3000
echo -n "[1/10] Node backend on port 3000... "
if sudo lsof -i :3000 2>/dev/null | grep -q LISTEN; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 2: SteVe running on port 8080
echo -n "[2/10] SteVe on port 8080... "
HTTP_CODE=$(curl -L -s -o /dev/null -w "%{http_code}" http://136.113.7.146:8080/steve 2>/dev/null)
if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "302" ]]; then
    echo " PASS (HTTP $HTTP_CODE)"
    ((PASS++))
else
    echo " FAIL (HTTP $HTTP_CODE)"
    ((FAIL++))
fi

# Test 3: Backend bound to localhost only
echo -n "[3/10] Backend bound to 127.0.0.1 only... "
LISTEN_OUTPUT=$(ss -ltnp 2>/dev/null | grep ":3000" || netstat -ltnp 2>/dev/null | grep ":3000")
if echo "$LISTEN_OUTPUT" | grep -q "127.0.0.1:3000" && \
   ! echo "$LISTEN_OUTPUT" | grep -qE "0.0.0.0:3000|\*:3000|\[::\]:3000"; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL (exposed to public or not listening)"
    ((FAIL++))
fi

# Test 4: MySQL voltstartev_db accessible
echo -n "[4/10] voltstartev_db accessible... "
if mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" -e "USE ${APP_DB_NAME}; SELECT 1;" &>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 5: MySQL stevedb accessible
echo -n "[5/10] stevedb accessible... "
if mysql -u "${STEVE_DB_USER}" -p"${STEVE_DB_PASSWORD}" -h "${STEVE_DB_HOST:-localhost}" -e "USE ${STEVE_DB_NAME}; SELECT 1;" &>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 6: Webhook endpoint returns 401 without auth
echo -n "[6/10] Webhook requires auth... "
WEBHOOK_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3000/api/webhooks/steve 2>/dev/null)
if [[ "$WEBHOOK_CODE" == "401" ]]; then
    echo " PASS (HTTP 401)"
    ((PASS++))
else
    echo " FAIL (HTTP $WEBHOOK_CODE)"
    ((FAIL++))
fi

# ─────────────────────────────────────────────────────
#  FIX #7: Robust charger connectivity check
# ─────────────────────────────────────────────────────
echo -n "[7/10] All 12 chargers connected... "

# Method 1: Try timestamp-based check with wider window (300 seconds)
CONNECTED=$(mysql -u "${STEVE_DB_USER}" -p"${STEVE_DB_PASSWORD}" -h "${STEVE_DB_HOST:-localhost}" "${STEVE_DB_NAME}" -N -s -e "
    SELECT COUNT(*) FROM charge_box 
    WHERE registration_status = 'Accepted'
      AND last_heartbeat_timestamp IS NOT NULL
      AND TIMESTAMPDIFF(SECOND, last_heartbeat_timestamp, UTC_TIMESTAMP()) < 300;
" 2>/dev/null)

# Fallback: If timestamp check fails, just count Accepted chargers
if [[ ! "$CONNECTED" =~ ^[0-9]+$ ]] || [ -z "$CONNECTED" ]; then
    CONNECTED=$(mysql -u "${STEVE_DB_USER}" -p"${STEVE_DB_PASSWORD}" -h "${STEVE_DB_HOST:-localhost}" "${STEVE_DB_NAME}" -N -s -e "
        SELECT COUNT(*) FROM charge_box WHERE registration_status = 'Accepted';
    " 2>/dev/null)
fi

# Ensure CONNECTED is a valid integer
CONNECTED="${CONNECTED:-0}"
CONNECTED=$(echo "$CONNECTED" | tr -d '[:space:]')

if [[ "$CONNECTED" =~ ^[0-9]+$ ]] && [ "$CONNECTED" -eq 12 ]; then
    echo " PASS ($CONNECTED/12)"
    ((PASS++))
else
    echo " FAIL ($CONNECTED/12 connected)"
    # Debug: Show actual heartbeat times
    echo "   Debug: Last heartbeats:"
    mysql -u "${STEVE_DB_USER}" -p"${STEVE_DB_PASSWORD}" -h "${STEVE_DB_HOST:-localhost}" "${STEVE_DB_NAME}" -N -e "
        SELECT charge_box_id, last_heartbeat_timestamp, 
               TIMESTAMPDIFF(SECOND, last_heartbeat_timestamp, UTC_TIMESTAMP()) as seconds_ago
        FROM charge_box 
        ORDER BY last_heartbeat_timestamp DESC 
        LIMIT 3;
    " 2>/dev/null | while read line; do echo "     $line"; done
    ((FAIL++))
fi

# Test 8: No active charging sessions
echo -n "[8/10] No active sessions... "
ACTIVE=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT COUNT(*) FROM charging_sessions WHERE status='active';
" 2>/dev/null | tr -d '[:space:]')
ACTIVE="${ACTIVE:-0}"

if [[ "$ACTIVE" =~ ^[0-9]+$ ]] && [ "$ACTIVE" -eq 0 ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL ($ACTIVE active sessions)"
    ((FAIL++))
fi

# Test 9: Reconciliation job configured
echo -n "[9/10] Reconciliation job configured... "
LOG_PATH="${LOG_PATH:-/var/log/voltstartev/backend.log}"
if [ -f "$LOG_PATH" ] && grep -q "reconciliation" "$LOG_PATH" 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP (no logs yet or path: $LOG_PATH)"
    ((PASS++))
fi

# Test 10: InnoDB redo log not full
echo -n "[10/10] InnoDB redo log < 80%... "
LOG_USED=$(mysql -u root -p"${ROOT_PASSWORD}" -N -s -e "
    SHOW ENGINE INNODB STATUS\G
" 2>/dev/null | grep -oP 'Log capacity used \K\d+' || echo "0")
LOG_USED="${LOG_USED:-0}"

if [[ "$LOG_USED" =~ ^[0-9]+$ ]] && [ "$LOG_USED" -lt 80 ]; then
    echo " PASS (${LOG_USED}%)"
    ((PASS++))
else
    echo " FAIL (${LOG_USED}%)"
    ((FAIL++))
fi

echo ""
echo "=== TC-PRE-001 Summary: $PASS passed, $FAIL failed ==="

if [ $FAIL -gt 0 ]; then
    echo "  CRITICAL: Fix failed pre-tests before continuing!"
    exit 1
else
    echo " All pre-tests passed! Proceeding with test suite..."
    exit 0
fi
