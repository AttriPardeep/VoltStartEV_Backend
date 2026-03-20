#!/bin/bash
# File: tests/polling/test-cache-behavior.sh

TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"username":"qatest001","password":"QATest123!"}' | jq -r '.data.token')

CHARGER="CS-SIMU-00001"
CONNECTOR=1

echo " Test 1: Cache Miss (first request)"
START1=$(date +%s%N)
RESP1=$(curl -s "http://localhost:3000/api/chargers/$CHARGER/connectors/$CONNECTOR/status" \
  -H "Authorization: Bearer $TOKEN")
END1=$(date +%s%N)
TIME1=$(( (END1 - START1) / 1000000 ))  # Convert to ms
FROM_CACHE1=$(echo "$RESP1" | jq -r '.data.fromCache // false')
STATUS1=$(echo "$RESP1" | jq -r '.data.status')

echo "   Response time: ${TIME1}ms, fromCache: $FROM_CACHE1, status: $STATUS1"

echo -e "\n Test 2: Cache Hit (within TTL)"
sleep 2  # Wait but stay within 30s TTL
START2=$(date +%s%N)
RESP2=$(curl -s "http://localhost:3000/api/chargers/$CHARGER/connectors/$CONNECTOR/status" \
  -H "Authorization: Bearer $TOKEN")
END2=$(date +%s%N)
TIME2=$(( (END2 - START2) / 1000000 ))
FROM_CACHE2=$(echo "$RESP2" | jq -r '.data.fromCache // false')
STATUS2=$(echo "$RESP2" | jq -r '.data.status')

echo "   Response time: ${TIME2}ms, fromCache: $FROM_CACHE2, status: $STATUS2"

echo -e "\n Test 3: After TTL Expiry (cache miss)"
sleep 35  # TTL = 30s + buffer
START3=$(date +%s%N)
RESP3=$(curl -s "http://localhost:3000/api/chargers/$CHARGER/connectors/$CONNECTOR/status" \
  -H "Authorization: Bearer $TOKEN")
END3=$(date +%s%N)
TIME3=$(( (END3 - START3) / 1000000 ))
FROM_CACHE3=$(echo "$RESP3" | jq -r '.data.fromCache // false')
STATUS3=$(echo "$RESP3" | jq -r '.data.status')

echo "   Response time: ${TIME3}ms, fromCache: $FROM_CACHE3, status: $STATUS3"

# Assertions
echo -e "\n🔍 Assertions:"
[ "$FROM_CACHE1" = "false" ] && echo " Test 1: Cache miss as expected" || echo " Test 1: Expected cache miss"
[ "$FROM_CACHE2" = "true" ] && echo " Test 2: Cache hit as expected" || echo " Test 2: Expected cache hit"
[ "$FROM_CACHE3" = "false" ] && echo " Test 3: Cache miss after TTL" || echo " Test 3: Expected cache miss after TTL"
[ $TIME2 -lt $TIME1 ] && echo "✅ Cache hit faster than miss (${TIME2}ms < ${TIME1}ms)" || echo "⚠️ Cache not significantly faster"
[ "$STATUS1" = "$STATUS2" ] && [ "$STATUS2" = "$STATUS3" ] && echo " Status consistent across requests" || echo "⚠️ Status changed unexpectedly"

# Exit with appropriate code
if [ "$FROM_CACHE1" = "false" ] && [ "$FROM_CACHE2" = "true" ] && [ "$FROM_CACHE3" = "false" ]; then
  echo -e "\n POLL-STATUS-001: Cache behavior test PASSED"
  exit 0
else
  echo -e "\n POLL-STATUS-001: Cache behavior test FAILED"
  exit 1
fi

