#!/bin/bash
# File: tests/polling/test-txn-start.sh

# 1. Get auth token
TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token')

echo " Starting charging session at $(date +%T)..."
START_TIME=$(date +%s%3N)

# 2. Trigger RemoteStart via API
RESPONSE=$(curl -s -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"chargeBoxId":"CS-SIMU-00001","connectorId":1,"idTag":"QATEST001"}')

echo " API Response: $(echo "$RESPONSE" | jq -r '.message')"

# 3. Poll for active session (max 15 seconds)
echo " Polling for transaction detection..."
for i in {1..15}; do
  POLL_RESP=$(curl -s "http://localhost:3000/api/charging/session/active?idTag=QATEST001" \
    -H "Authorization: Bearer $TOKEN")
  
  STATUS=$(echo "$POLL_RESP" | jq -r '.data.status')
  
  if [ "$STATUS" = "active" ]; then
    END_TIME=$(date +%s%3N)
    DETECTION_TIME=$(( (END_TIME - START_TIME) / 1000 ))
    
    echo " Transaction detected after ${DETECTION_TIME} seconds"
    
    # Validate response structure
    echo "$POLL_RESP" | jq '{
      has_transactionId: (.data.transactionId != null),
      has_chargeBoxId: (.data.chargeBoxId != null),
      has_startTime: (.data.startTime != null),
      has_telemetry: (.data.telemetry != null)
    }'
    
    # Assert detection time < 10 seconds (target)
    if [ $DETECTION_TIME -lt 10 ]; then
      echo " Detection time within target (< 10s)"
      exit 0
    else
      echo " Detection time exceeded target: ${DETECTION_TIME}s"
      exit 1
    fi
  fi
  
  echo "  Attempt $i/15: status=$STATUS"
  sleep 1
done

echo " Transaction not detected within 15 seconds"
exit 1
