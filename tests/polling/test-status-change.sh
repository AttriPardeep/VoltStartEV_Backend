#!/bin/bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token')

CHARGER="CS-SIMU-00001"
CONNECTOR=1

echo "Initial status check..."
INITIAL=$(curl -s "http://localhost:3000/api/chargers/$CHARGER/connectors/$CONNECTOR/status" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.status')
echo "  Initial status: $INITIAL"

# Insert a status change directly into SteVe DB
NEW_STATUS="Preparing"
[ "$INITIAL" = "Preparing" ] && NEW_STATUS="Available"

echo "Injecting status change: $INITIAL → $NEW_STATUS"
CONNECTOR_PK=$(mysql -u root -proot stevedb -N -e "
  SELECT connector_pk FROM connector 
  WHERE charge_box_id='$CHARGER' AND connector_id=$CONNECTOR LIMIT 1;
" 2>/dev/null)

mysql -u root -proot stevedb -e "
  INSERT INTO connector_status (connector_pk, status, status_timestamp)
  VALUES ($CONNECTOR_PK, '$NEW_STATUS', NOW(6));
" 2>/dev/null

echo "Waiting for cache TTL expiry + polling cycle (max 35 seconds)..."
for i in {1..35}; do
  CURRENT=$(curl -s "http://localhost:3000/api/chargers/$CHARGER/connectors/$CONNECTOR/status" \
    -H "Authorization: Bearer $TOKEN" | jq -r '.data.status')

  if [ "$CURRENT" = "$NEW_STATUS" ]; then
    echo " Status change detected after ${i}s: $INITIAL → $CURRENT"
    exit 0
  fi
  echo "  Check $i/35: still $CURRENT"
  sleep 1
done

echo "❌ Status change not detected within 35 seconds"
exit 1
