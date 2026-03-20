#!/bin/bash
# File: tests/polling/test-telemetry.sh

TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token')

echo " Starting charging session for telemetry test..."
START_RESP=$(curl -s -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"chargeBoxId":"CS-SIMU-00001","connectorId":1,"idTag":"QATEST001"}')

echo " Waiting for transaction to be active..."
for i in {1..10}; do
  SESSION=$(curl -s "http://localhost:3000/api/charging/session/active?idTag=QATEST001" \
    -H "Authorization: Bearer $TOKEN")
  STATUS=$(echo "$SESSION" | jq -r '.data.status')
  [ "$STATUS" = "active" ] && break
  sleep 1
done

echo " Polling telemetry endpoint (5 iterations, 10s apart)..."
for i in {1..5}; do
  START=$(date +%s%N)
  RESP=$(curl -s "http://localhost:3000/api/charging/session/active?idTag=QATEST001" \
    -H "Authorization: Bearer $TOKEN")
  END=$(date +%s%N)
  DURATION=$(( (END - START) / 1000000 ))
  
  TELEMETRY=$(echo "$RESP" | jq '.data.telemetry')
  
  echo "  Iteration $i: ${DURATION}ms"
  echo "$TELEMETRY" | jq '{
    timestamp: .timestamp,
    energyKwh: .energyKwh,
    powerW: .powerW,
    currentA: .currentA,
    voltageV: .voltageV,
    socPercent: .socPercent
  }'
  
  # Verify telemetry fields are populated
  echo "$TELEMETRY" | jq -e '.energyKwh != null and .energyKwh > 0' > /dev/null && \
    echo "   energyKwh valid" || echo "   energyKwh missing/invalid"
  
  sleep 10  # Wait for next MeterValues from charger
done

# Stop transaction
echo -e "\n Stopping transaction..."
TX_ID=$(curl -s "http://localhost:3000/api/charging/session/active?idTag=QATEST001" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.transactionId')

curl -s -X POST http://localhost:3000/api/charging/stop \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"chargeBoxId\":\"CS-SIMU-00001\",\"transactionId\":$TX_ID}" > /dev/null

echo "✅ POLL-TEL-001: Telemetry polling test complete"

