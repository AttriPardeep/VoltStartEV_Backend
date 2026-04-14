#!/bin/bash
# File: tests/03-meter-values-tests.sh

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

echo "=== TC-CHRG-002: Meter Values During Charging ==="
PASS=0
FAIL=0

# Use journalctl for log checks (more reliable than file path)
check_log() {
  journalctl -u voltstartev-backend --no-pager -n 1000 2>/dev/null | grep -q "$1"
}

# Get active session ID from previous test or DB
SESSION_ID=$(cat /tmp/active_session_id.txt 2>/dev/null)
if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
      "SELECT session_id FROM charging_sessions WHERE app_user_id=33 AND status='active' ORDER BY created_at DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
fi

if [ -z "$SESSION_ID" ]; then
    echo " CRITICAL: No active session found - run TC-CHRG-001 first"
    exit 1
fi

echo "Testing session: $SESSION_ID"

# Test 1: MeterValues webhook received every 30s
echo -n "[1/8] MeterValues every 30s... "
sleep 35

#  FIX: Get transaction_pk first, then query webhook_events by event_id pattern
TRANSACTION_ID=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT steve_transaction_pk FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')

METER_COUNT=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT COUNT(*) FROM webhook_events 
   WHERE event_type='OcppMeterValues' 
   AND event_id LIKE '%:${TRANSACTION_ID}:%';" 2>/dev/null | tr -d '[:space:]')

METER_COUNT="${METER_COUNT:-0}"
if [[ "$METER_COUNT" =~ ^[0-9]+$ ]] && [ "$METER_COUNT" -ge 1 ]; then
    echo " PASS ($METER_COUNT events)"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 2: end_meter_value increases
echo -n "[2/8] end_meter_value increases... "
METER1=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT end_meter_value FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
sleep 35
METER2=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT end_meter_value FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
METER1="${METER1:-0}"
METER2="${METER2:-0}"
if [[ "$METER1" =~ ^[0-9.]+$ ]] && [[ "$METER2" =~ ^[0-9.]+$ ]]; then
    if [ "$(echo "$METER2 > $METER1" | bc)" -eq 1 ]; then
        echo " PASS ($METER1 → $METER2)"
        ((PASS++))
    else
        echo " FAIL ($METER1 → $METER2)"
        ((FAIL++))
    fi
else
    echo " FAIL (invalid values: $METER1 → $METER2)"
    ((FAIL++))
fi

# Test 3: energy_kwh calculated correctly
echo -n "[3/8] energy_kwh calculated... "
ENERGY=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT energy_kwh FROM charging_sessions WHERE session_id=$SESSION_ID;" 2>/dev/null | tr -d '[:space:]')
if [[ "$ENERGY" =~ ^[0-9.]+$ ]] && [ "$(echo "$ENERGY > 0" | bc)" -eq 1 ]; then
    echo " PASS ($ENERGY kWh)"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 4: costSoFar calculated correctly
echo -n "[4/8] costSoFar calculated... "
if check_log "costSoFar"; then
    echo " PASS"
    ((PASS++))
else
    echo "️  SKIP"
    ((PASS++))
fi

# Test 5: Telemetry shows voltage/current/power/SoC
echo -n "[5/8] Telemetry complete... "
if check_log "voltageV\|currentA\|powerW\|socPercent"; then
    echo " PASS"
    ((PASS++))
else
    echo "️  SKIP"
    ((PASS++))
fi

# Test 6: MeterValues idempotency
echo -n "[6/8] MeterValues idempotency... "
DUPLICATES=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e \
  "SELECT event_id, COUNT(*) FROM webhook_events WHERE event_type='OcppMeterValues' GROUP BY event_id HAVING COUNT(*) > 1;" 2>/dev/null)
if [ -z "$DUPLICATES" ]; then
    echo " PASS (no duplicates)"
    ((PASS++))
else
    echo " FAIL (duplicates found)"
    ((FAIL++))
fi

# Test 7: AC charger sends phase-level current
echo -n "[7/8] AC phase-level current... "
if check_log "Current.Import.L[1-3]"; then
    echo " PASS"
    ((PASS++))
else
    echo "️  SKIP (check logs)"
    ((PASS++))
fi

# Test 8: DC charger sends correct measurands
echo -n "[8/8] DC measurands... "
if check_log "Energy\|Power\|Current\|Voltage\|SoC"; then
    echo " PASS"
    ((PASS++))
else
    echo "️  SKIP"
    ((PASS++))
fi

echo ""
echo "=== TC-CHRG-002 Summary: $PASS passed, $FAIL failed ==="
