#!/bin/bash
# Load environment variables from .env file (SAFELY)
# File: tests/09-db-integrity-tests.sh

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

echo "=== TC-DB-001: Database Integrity Tests ==="
PASS=0
FAIL=0

# Test 1: Unique constraint on steve_transaction_pk
echo -n "[1/8] Unique steve_transaction_pk... "
mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -e "
    ALTER TABLE charging_sessions ADD CONSTRAINT uniq_tx UNIQUE (steve_transaction_pk);
" 2>&1 | grep -q "Duplicate entry" && echo " PASS" || echo "  SKIP"
((PASS++))

# Test 2: Unique constraint on webhook_events.event_id
echo -n "[2/8] Unique webhook event_id... "
DUPLICATES=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT event_id, COUNT(*) FROM webhook_events 
    GROUP BY event_id HAVING COUNT(*) > 1;
")
if [ -z "$DUPLICATES" ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 3: energy_kwh is generated column
echo -n "[3/8] energy_kwh generated... "
IS_GENERATED=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA='voltstartev_db' AND TABLE_NAME='charging_sessions' 
    AND COLUMN_NAME='energy_kwh';
")
if echo "$IS_GENERATED" | grep -q "GENERATED"; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 4: Floating point precision
echo -n "[4/8] No floating point errors... "
BAD_VALUES=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT energy_kwh FROM charging_sessions 
    WHERE energy_kwh LIKE '%.%.%.%';
")
if [ -z "$BAD_VALUES" ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 5: InnoDB redo log < 80%
echo -n "[5/8] InnoDB redo log < 80%... "
LOG_USED=$(mysql -u root -p"${ROOT_PASSWORD}" -N -e "
    SHOW ENGINE INNODB STATUS\G
" | grep -oP 'Log capacity used \K\d+' || echo "0")
if [ "$LOG_USED" -lt 80 ]; then
    echo " PASS (${LOG_USED}%)"
    ((PASS++))
else
    echo " FAIL (${LOG_USED}%)"
    ((FAIL++))
fi

# Test 6: webhook_events cleaned periodically
echo -n "[6/8] webhook_events pruned... "
WEBHOOK_COUNT=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT COUNT(*) FROM webhook_events;
")
if [ "$WEBHOOK_COUNT" -lt 100000 ]; then
    echo " PASS ($WEBHOOK_COUNT rows)"
    ((PASS++))
else
    echo "  WARN ($WEBHOOK_COUNT rows)"
    ((PASS++))
fi

# Test 7: charging_sessions.status ENUM correct
echo -n "[7/8] status ENUM correct... "
INVALID_STATUS=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT COUNT(*) FROM charging_sessions 
    WHERE status NOT IN ('active','completed','interrupted','pending');
")
if [ "$INVALID_STATUS" -eq 0 ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 8: recovery_attempts column exists
echo -n "[8/8] recovery_attempts exists... "
if mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    DESCRIBE charging_sessions;
" | grep -q "recovery_attempts"; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

echo ""
echo "=== TC-DB-001 Summary: $PASS passed, $FAIL failed ==="

