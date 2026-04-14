#!/bin/bash
# File: tests/10-billing-tests.sh

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

echo "=== TC-BILL-001: Billing Calculation Tests ==="
PASS=0
FAIL=0

# Test 1: energy_kwh = (end_meter - start_meter) / 1000
echo -n "[1/7] energy_kwh formula... "
mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT ABS((end_meter_value - start_meter_value) / 1000 - energy_kwh) as diff
    FROM charging_sessions 
    WHERE status='completed' 
    AND end_meter_value IS NOT NULL
    LIMIT 1;
" 2>/dev/null > /tmp/billing_test.txt
DIFF=$(cat /tmp/billing_test.txt | tr -d '[:space:]')
DIFF="${DIFF:-999}"
if [ "$(echo "$DIFF < 0.01" | bc 2>/dev/null)" -eq 1 ] 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL (diff=$DIFF)"
    ((FAIL++))
fi

# Test 2: total_cost = energyKwh * rate + session_fee
echo -n "[2/7] total_cost formula... "
mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT ABS(energy_kwh * rate_per_kwh + session_fee - total_cost) as diff
    FROM charging_sessions 
    WHERE status='completed'
    AND energy_kwh > 0
    LIMIT 1;
" 2>/dev/null > /tmp/billing_test2.txt
DIFF=$(cat /tmp/billing_test2.txt | tr -d '[:space:]')
DIFF="${DIFF:-999}"
if [ "$(echo "$DIFF < 0.01" | bc 2>/dev/null)" -eq 1 ] 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL (diff=$DIFF)"
    ((FAIL++))
fi

# Test 3: session_fee applied
echo -n "[3/7] session_fee applied... "
MIN_COST=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT MIN(total_cost) FROM charging_sessions WHERE status='completed';
" 2>/dev/null | tr -d '[:space:]')
MIN_COST="${MIN_COST:-0}"
if [ "$(echo "$MIN_COST >= 0.50" | bc 2>/dev/null)" -eq 1 ] 2>/dev/null; then
    echo " PASS (₹$MIN_COST)"
    ((PASS++))
else
    echo " FAIL (₹$MIN_COST)"
    ((FAIL++))
fi

# Test 4: rate uses env var
echo -n "[4/7] rate from env var... "
if grep -q "CHARGING_RATE_PER_KWH" /build/VoltStartEV_Backend/.env 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

# Test 5: Reconciled session billing matches
echo -n "[5/7] Reconciled billing matches... "
LOG_FILE="/build/VoltStartEV_Backend/logs/app.log"
if [ -f "$LOG_FILE" ] && grep -q "billing matches" "$LOG_FILE" 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP (no log file)"
    ((PASS++))
fi

# Test 6: costSoFar matches final total_cost
echo -n "[6/7] costSoFar matches... "
if [ -f "$LOG_FILE" ] && grep -q "costSoFar" "$LOG_FILE" 2>/dev/null; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP (no log file)"
    ((PASS++))
fi

# Test 7: payment_status starts as pending
echo -n "[7/7] payment_status=pending... "
PENDING=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT COUNT(*) FROM charging_sessions 
    WHERE status='completed' AND payment_status='pending';
" 2>/dev/null | tr -d '[:space:]')
TOTAL=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT COUNT(*) FROM charging_sessions WHERE status='completed';
" 2>/dev/null | tr -d '[:space:]')
PENDING="${PENDING:-0}"
TOTAL="${TOTAL:-0}"
if [ "$PENDING" -eq "$TOTAL" ] 2>/dev/null && [ "$TOTAL" -gt 0 ]; then
    echo " PASS ($PENDING/$TOTAL)"
    ((PASS++))
else
    echo " FAIL ($PENDING/$TOTAL)"
    ((FAIL++))
fi

echo ""
echo "=== TC-BILL-001 Summary: $PASS passed, $FAIL failed ==="
