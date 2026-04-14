#!/bin/bash
# Load environment variables from .env file (SAFELY)
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

# File: tests/08-load-tests.sh

echo "=== TC-LOAD-001: Simultaneous Multi-Charger Sessions ==="
PASS=0
FAIL=0
BASE_URL="http://127.0.0.1:3000"

JWT_TOKEN=$(curl -s -X POST "${BASE_URL}/api/users/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"qatest001","password":"QATest123!"}' | grep -oP '"token"\s*:\s*"\K[^"]+')

# Test 1: 3 simultaneous sessions
echo -n "[1/6] 3 simultaneous sessions... "
for i in 1 2 3; do
    curl -s -X POST "${BASE_URL}/api/charging/start" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $JWT_TOKEN" \
        -d "{\"chargeBoxId\":\"CS-AC7K-0000$i\",\"connectorId\":1,\"idTag\":\"QATEST00$i\"}" &
done
wait
sleep 5

ACTIVE=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT COUNT(*) FROM charging_sessions WHERE status='active';
")
if [ "$ACTIVE" -ge 3 ]; then
    echo " PASS ($ACTIVE sessions)"
    ((PASS++))
else
    echo " FAIL ($ACTIVE sessions)"
    ((FAIL++))
fi

# Test 2: Dual-port charger 2 simultaneous sessions
echo -n "[2/6] Dual-port 2 sessions... "
curl -s -X POST "${BASE_URL}/api/charging/start" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC22K-00001","connectorId":1,"idTag":"QATEST10"}' &
curl -s -X POST "${BASE_URL}/api/charging/start" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC22K-00001","connectorId":2,"idTag":"QATEST11"}' &
wait
sleep 5

DUAL_ACTIVE=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT COUNT(*) FROM charging_sessions 
    WHERE charge_box_id='CS-AC22K-00001' AND status='active';
")
if [ "$DUAL_ACTIVE" -ge 2 ]; then
    echo " PASS ($DUAL_ACTIVE sessions)"
    ((PASS++))
else
    echo " FAIL ($DUAL_ACTIVE sessions)"
    ((FAIL++))
fi

# Test 3: HPC 350kW 4 simultaneous sessions
echo -n "[3/6] HPC 350kW 4 sessions... "
for i in 1 2 3 4; do
    curl -s -X POST "${BASE_URL}/api/charging/start" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $JWT_TOKEN" \
        -d "{\"chargeBoxId\":\"CS-HPC350K-00001\",\"connectorId\":$i,\"idTag\":\"QATEST2$i\"}" &
done
wait
sleep 5

HPC_ACTIVE=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT COUNT(*) FROM charging_sessions 
    WHERE charge_box_id='CS-HPC350K-00001' AND status='active';
")
if [ "$HPC_ACTIVE" -ge 4 ]; then
    echo " PASS ($HPC_ACTIVE sessions)"
    ((PASS++))
else
    echo " FAIL ($HPC_ACTIVE sessions)"
    ((FAIL++))
fi

# Test 4: 12 MeterValues webhooks per 30s handled
echo -n "[4/6] 12 MeterValues/30s handled... "
sleep 35
METER_COUNT=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT COUNT(*) FROM webhook_events 
    WHERE event_type='OcppMeterValues' 
    AND processed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE);
")
if [ "$METER_COUNT" -ge 12 ]; then
    echo " PASS ($METER_COUNT events)"
    ((PASS++))
else
    echo " FAIL ($METER_COUNT events)"
    ((FAIL++))
fi

# Test 5: No session cross-contamination
echo -n "[5/6] No cross-contamination... "
CROSS=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT steve_transaction_pk, COUNT(*) FROM charging_sessions 
    GROUP BY steve_transaction_pk HAVING COUNT(*) > 1;
")
if [ -z "$CROSS" ]; then
    echo " PASS"
    ((PASS++))
else
    echo " FAIL"
    ((FAIL++))
fi

# Test 6: Webhook idempotency under load
echo -n "[6/6] Idempotency under load... "
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

# Cleanup: Stop all sessions
mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -e "
    SELECT session_id FROM charging_sessions WHERE status='active';
" | while read SESSION_ID; do
    curl -s -X POST "${BASE_URL}/api/charging/stop" \
        -H "Authorization: Bearer $JWT_TOKEN" \
        -d '{"sessionId": '$SESSION_ID'}' &>/dev/null
done

echo ""
echo "=== TC-LOAD-001 Summary: $PASS passed, $FAIL failed ==="

