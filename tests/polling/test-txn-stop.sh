#!/bin/bash
# File: tests/polling/test-txn-stop.sh

TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token')

# 1. Start a session first
echo " Starting session..."
START_RESP=$(curl -s -X POST http://localhost:3000/api/charging/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"chargeBoxId":"CS-SIMU-00001","connectorId":1,"idTag":"QATEST001"}')

TX_ID=$(echo "$START_RESP" | jq -r '.data.transactionId // empty')
if [ -z "$TX_ID" ] || [ "$TX_ID" = "0" ]; then
  echo "⏳ Waiting for real transaction ID via polling..."
  for i in {1..10}; do
    POLL=$(curl -s "http://localhost:3000/api/charging/session/active?idTag=QATEST001" \
      -H "Authorization: Bearer $TOKEN")
    TX_ID=$(echo "$POLL" | jq -r '.data.transactionId // empty')
    [ -n "$TX_ID" ] && [ "$TX_ID" != "0" ] && break
    sleep 1
  done
fi

echo " Transaction ID: $TX_ID"

# 2. Let session run briefly to accumulate meter values
echo "⏳ Letting session run for 20 seconds..."
sleep 20

# 3. Stop the session
echo " Stopping transaction at $(date +%T)..."
STOP_TIME=$(date +%s%3N)

curl -s -X POST http://localhost:3000/api/charging/stop \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"chargeBoxId\":\"CS-SIMU-00001\",\"transactionId\":$TX_ID}" > /dev/null

# 4. Wait for reconciliation to create billing record (max 11 minutes for cron)
echo " Waiting for billing record creation (reconciliation runs every 10 min)..."
RECON_START=$(date +%s)

for i in {1..66}; do  # 11 minutes max
  BILLING=$(mysql -u voltstartev -pStevePass2026! voltstartev_db -N -e "
    SELECT COUNT(*) FROM charging_sessions 
    WHERE steve_transaction_pk = $TX_ID AND status = 'completed';
  " 2>/dev/null)
  
  if [ "$BILLING" = "1" ]; then
    RECON_TIME=$(( ( $(date +%s) - RECON_START ) / 60 ))
    echo "✅ Billing record created after ~${RECON_TIME} minutes"
    
    # Verify generated columns
    mysql -u voltstartev -pStevePass2026! voltstartev_db -e "
      SELECT 
        start_meter_value,
        end_meter_value,
        (end_meter_value - start_meter_value) / 1000 AS manual_kwh,
        energy_kwh AS generated_kwh,
        ROUND((energy_kwh * 0.25) + 0.50, 2) AS manual_cost,
        total_cost AS generated_cost,
        status,
        payment_status
      FROM charging_sessions
      WHERE steve_transaction_pk = $TX_ID;
    "
    
    # Verify calculations match
    mysql -u voltstartev -pStevePass2026! voltstartev_db -e "
      SELECT 
        ABS((end_meter_value - start_meter_value) / 1000 - energy_kwh) < 0.001 AS kwh_match,
        ABS(ROUND((energy_kwh * 0.25) + 0.50, 2) - total_cost) < 0.01 AS cost_match
      FROM charging_sessions
      WHERE steve_transaction_pk = $TX_ID;
    " | grep -q "1.*1" && echo "✅ Generated columns calculated correctly"
    
    exit 0
  fi
  
  echo "  Check $i/66: No billing record yet..."
  sleep 10
done

echo " Billing record not created within 11 minutes"
exit 1

