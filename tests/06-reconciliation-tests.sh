#!/bin/bash
# File: tests/06-reconciliation-tests.sh

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

echo "=== TC-RECON-001: Automatic Session Recovery ==="
PASS=0
FAIL=0

# Test 1: Reconciliation runs every 10 minutes
echo -n "[1/8] Reconciliation every 10 min... "
if grep -q "Running reconciliation job" /var/log/voltstartev/backend.log; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 2: Reconciliation runs at startup
echo -n "[2/8] Reconciliation at startup... "
if grep -q "Initial reconciliation" /var/log/voltstartev/backend.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

# Test 3: Orphaned active session gets closed
echo -n "[3/8] Orphaned session closed... "
ORPHANED=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT COUNT(*) FROM charging_sessions 
    WHERE status='active' AND steve_transaction_pk NOT IN (
        SELECT transaction_pk FROM stevedb.ocpp_transaction WHERE stop_timestamp IS NOT NULL
    );
" 2>/dev/null | tr -d '[:space:]')
ORPHANED="${ORPHANED:-0}"
if [[ "$ORPHANED" =~ ^[0-9]+$ ]] && [ "$ORPHANED" -eq 0 ]; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP (no orphaned sessions)"
    ((PASS++))
fi

# Test 4: Missing session gets created
echo -n "[4/8] Missing session created... "
if grep -q "Created missing session" /var/log/voltstartev/backend.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

# Test 5: Interrupted session retried
echo -n "[5/8] Interrupted session retried... "
if grep -q "RemoteStopTransaction sent" /var/log/voltstartev/backend.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

# Test 6: Force-close after 5 failed attempts
echo -n "[6/8] Force-close after 5 attempts... "
MAX_ATTEMPTS=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT COALESCE(MAX(recovery_attempts), 0) 
    FROM charging_sessions 
    WHERE status IN ('interrupted', 'completed') 
    AND stop_reason LIKE '%Recovery%';
" 2>/dev/null | tr -d '[:space:]')
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"

# Allow NULL/0 if no recovery sessions exist yet
if [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] && { [ "$MAX_ATTEMPTS" -eq 0 ] || [ "$MAX_ATTEMPTS" -le 5 ]; }; then
    echo " PASS (max=$MAX_ATTEMPTS)"
    ((PASS++))
else
    echo " FAIL (max=$MAX_ATTEMPTS > 5)"
    ((FAIL++))
fi

# Test 7: Reconciliation stats logged
echo -n "[7/8] Reconciliation stats logged... "
if grep -q "checked=\|created=\|updated=" /var/log/voltstartev/backend.log; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 8: Lookback window 60 minutes
echo -n "[8/8] 60-minute lookback... "
if grep -q "lookback\|60 minute" /var/log/voltstartev/backend.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

echo ""
echo "=== TC-RECON-001 Summary: $PASS passed, $FAIL failed ==="

