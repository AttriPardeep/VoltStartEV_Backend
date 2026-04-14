#!/bin/bash
# File: tests/12-e2e-tests.sh

echo "=== TC-E2E-001: Complete Happy Path (7kW AC) ==="
PASS=0
FAIL=0
BASE_URL="http://127.0.0.1:3000"

# Step 1: Login
echo "[1/7] Login as qatest001..."
JWT_TOKEN=$(curl -s -X POST "${BASE_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"qatest001","password":"TestPass123!"}' | grep -oP '"token"\s*:\s*"\K[^"]+')
if [ ! -z "$JWT_TOKEN" ]; then
    echo "    Token obtained"
    ((PASS++))
else
    echo "    Login failed"
    ((FAIL++))
    exit 1
fi

# Step 2: Start session
echo "[2/7] Start session on CS-AC7K-00001:1..."
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/charging/start" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"chargeBoxId":"CS-AC7K-00001","connectorId":1,"idTag":"QATEST001"}')
SESSION_ID=$(echo "$RESPONSE" | grep -oP '"sessionId"\s*:\s*\K\d+')
if [ ! -z "$SESSION_ID" ]; then
    echo "    Session started (ID: $SESSION_ID)"
    ((PASS++))
else
    echo "    Start failed"
    ((FAIL++))
fi

# Step 3: Wait for meter values
echo "[3/7] Wait 90 seconds for meter values..."
sleep 90
METER_COUNT=$(mysql -u voltstartev -p"${DB_PASSWORD}" voltstartev_db -N -e "
    SELECT COUNT(*) FROM webhook_events 
    WHERE event_type='OcppMeterValues' AND session_id=$SESSION_ID;
")
if [ "$METER_COUNT" -ge 3 ]; then
    echo "    $METER_COUNT meter value events"
    ((PASS++))
else
    echo "    Only $METER_COUNT events"
    ((FAIL++))
fi

# Step 4: Stop session
echo "[4/7] Stop session..."
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/charging/stop" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT_TOKEN" \
    -d '{"sessionId": '$SESSION_ID'}')
if echo "$RESPONSE" | grep -q '"success":true'; then
    echo "    Session stopped"
    ((PASS++))
else
    echo "    Stop failed"
    ((FAIL++))
fi

# Step 5: Verify DB
echo "[5/7] Verify DB: status=completed..."
sleep 5
STATUS=$(mysql -u voltstartev -p"${DB_PASSWORD}" voltstartev_db -N -e "
    SELECT status FROM charging_sessions WHERE session_id=$SESSION_ID;
")
if [ "$STATUS" = "completed" ]; then
    echo "    Status: completed"
    ((PASS++))
else
    echo "    Status: $STATUS"
    ((FAIL++))
fi

# Step 6: Verify webhook events
echo "[6/7] Verify webhook events..."
EVENT_TYPES=$(mysql -u voltstartev -p"${DB_PASSWORD}" voltstartev_db -N -e "
    SELECT COUNT(DISTINCT event_type) FROM webhook_events WHERE session_id=$SESSION_ID;
")
if [ "$EVENT_TYPES" -ge 3 ]; then
    echo "    $EVENT_TYPES event types"
    ((PASS++))
else
    echo "    Only $EVENT_TYPES types"
    ((FAIL++))
fi

# Step 7: Verify no duplicates
echo "[7/7] Verify no duplicate events..."
DUPLICATES=$(mysql -u voltstartev -p"${DB_PASSWORD}" voltstartev_db -N -e "
    SELECT event_id, COUNT(*) FROM webhook_events 
    WHERE session_id=$SESSION_ID 
    GROUP BY event_id HAVING COUNT(*) > 1;
")
if [ -z "$DUPLICATES" ]; then
    echo "    No duplicates"
    ((PASS++))
else
    echo "    Duplicates found"
    ((FAIL++))
fi

# Show final billing
echo ""
echo "=== Final Session Billing ==="
mysql -u voltstartev -p"${DB_PASSWORD}" voltstartev_db -e "
    SELECT session_id, status, energy_kwh, total_cost, payment_status
    FROM charging_sessions WHERE session_id=$SESSION_ID;
"

echo ""
echo "=== TC-E2E-001 Summary: $PASS passed, $FAIL failed ==="

