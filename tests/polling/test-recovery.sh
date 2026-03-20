#!/bin/bash
echo "Testing DB recovery..."

LOG=/tmp/recovery-test.log

# 1. Start fresh backend
pkill -f "tsx.*server\|node.*dist/server" 2>/dev/null
sleep 2
npm run dev > $LOG 2>&1 &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID"
sleep 5

# 2. Verify it started
curl -s http://localhost:3000/health | jq -e '.status == "healthy"' > /dev/null && \
  echo " Backend started" || { echo " Backend failed to start"; kill $BACKEND_PID; exit 1; }

# 3. Stop MySQL
echo "Stopping MySQL..."
sudo systemctl stop mysql
sleep 3

# 4. Verify backend detects the error
curl -s http://localhost:3000/health | jq -r '.services.database' 
# Expected: disconnected

# 5. Restart MySQL
echo "Restarting MySQL..."
sudo systemctl start mysql
sleep 5

# 6. Verify recovery — health should return healthy again
for i in {1..10}; do
  STATUS=$(curl -s http://localhost:3000/health | jq -r '.status' 2>/dev/null)
  if [ "$STATUS" = "healthy" ]; then
    echo " Backend recovered after ${i}s"
    # Check no duplicate billing records
    DUPS=$(mysql -u voltstartev -pStevePass2026! voltstartev_db -N -e "
      SELECT COUNT(*) FROM (
        SELECT steve_transaction_pk, COUNT(*) as cnt
        FROM charging_sessions
        GROUP BY steve_transaction_pk HAVING cnt > 1
      ) dups;
    " 2>/dev/null)
    [ "$DUPS" = "0" ] && echo " No duplicate billing records" || echo " $DUPS duplicate transactions found"
    kill $BACKEND_PID 2>/dev/null
    exit 0
  fi
  echo "  Check $i/10: status=$STATUS"
  sleep 1
done

echo " Backend did not recover within 10 seconds"
kill $BACKEND_PID 2>/dev/null
exit 1
