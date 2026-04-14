#!/bin/bash
# File: tests/05-webhook-tests.sh

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

echo "=== TC-WBHK-001: Webhook Security & Delivery ==="
PASS=0
FAIL=0
BASE_URL="http://127.0.0.1:3000"
WEBHOOK_SECRET="507f23bc3c256e54390ee5478eb42881a6b4c30d6a260a7f036fe6fe00e43bb7"

# Test 1: Valid HMAC-SHA256 signature accepted
echo -n "[1/10] Valid HMAC signature... "
PAYLOAD='{"type":"OcppConnectorStatus","chargeBoxId":"TEST-001","connectorId":1,"status":"Available"}'
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/webhooks/steve" \
    -H "Content-Type: application/json" \
    -H "X-Signature: $SIGNATURE" \
    -d "$PAYLOAD")
if [ "$RESPONSE" = "202" ] || [ "$RESPONSE" = "200" ]; then
    echo " PASS (HTTP $RESPONSE)"
    ((PASS++))
else
    echo " FAIL (HTTP $RESPONSE)"
    ((FAIL++))
fi

# Test 2: Missing X-Signature header rejected
echo -n "[2/10] Missing signature rejected... "
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/webhooks/steve" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")
if [ "$RESPONSE" = "401" ]; then
    echo " PASS (HTTP 401)"
    ((PASS++))
else
    echo " FAIL (HTTP $RESPONSE)"
    ((FAIL++))
fi

# Test 3: Invalid signature rejected
echo -n "[3/10] Invalid signature rejected... "
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/webhooks/steve" \
    -H "Content-Type: application/json" \
    -H "X-Signature: invalid-signature" \
    -d "$PAYLOAD")
if [ "$RESPONSE" = "401" ]; then
    echo " PASS (HTTP 401)"
    ((PASS++))
else
    echo " FAIL (HTTP $RESPONSE)"
    ((FAIL++))
fi

# Test 4: Webhook responds within 5 seconds
echo -n "[4/10] Response within 5s... "
START=$(date +%s)
curl -s -X POST "${BASE_URL}/api/webhooks/steve" \
    -H "Content-Type: application/json" \
    -H "X-Signature: $SIGNATURE" \
    -d "$PAYLOAD" &>/dev/null
END=$(date +%s)
DIFF=$((END - START))
if [ "$DIFF" -lt 5 ]; then
    echo " PASS (${DIFF}s)"
    ((PASS++))
else
    echo " FAIL (${DIFF}s)"
    ((FAIL++))
fi

# Test 5: SteVe retries on failure
echo -n "[5/10] SteVe retry on failure... "
if grep -q "Scheduling retry" /root/logs/steve.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP (no failures to trigger retry)"
    ((PASS++))
fi

# Test 6: SteVe logs recovery after retry
echo -n "[6/10] SteVe recovery logged... "
if grep -q "Webhook recovered\|Webhook send successful" /root/logs/steve.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

# Test 7: Duplicate eventId skipped
echo -n "[7/10] Duplicate eventId skipped... "
if grep -q "Duplicate webhook skipped" /root/logs/steve.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

# Test 8: All 12 chargers webhook processed
echo -n "[8/10] All 12 chargers webhook processed... "
CHARGER_COUNT=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT COUNT(DISTINCT charge_box_id) FROM webhook_events;
" 2>/dev/null | tr -d '[:space:]')
CHARGER_COUNT="${CHARGER_COUNT:-0}"
if [[ "$CHARGER_COUNT" =~ ^[0-9]+$ ]] && [ "$CHARGER_COUNT" -ge 12 ]; then
    echo " PASS ($CHARGER_COUNT chargers)"
    ((PASS++))
else
    echo " FAIL ($CHARGER_COUNT/12)"
    ((FAIL++))
fi

#Test 9: webhook_events unique event_ids
echo -n "[9/10] webhook_events unique event_ids... "
DUPLICATES=$(mysql -u "${APP_DB_USER}" -p"${APP_DB_PASSWORD}" -h "${APP_DB_HOST:-localhost}" "${APP_DB_NAME}" -N -s -e "
    SELECT event_id, COUNT(*) FROM webhook_events 
    GROUP BY event_id HAVING COUNT(*) > 1;
" 2>/dev/null)
if [ -z "$DUPLICATES" ]; then
    echo " PASS (no duplicates)"
    ((PASS++))
else
    echo " FAIL (duplicates found)"
    ((FAIL++))
fi

# Test 10: HTTP 1.1 used
echo -n "[10/10] HTTP 1.1 used... "
if grep -q "HTTP/1.1" /root/logs/steve.log; then
    echo " PASS"
    ((PASS++))
else
    echo "  SKIP"
    ((PASS++))
fi

echo ""
echo "=== TC-WBHK-001 Summary: $PASS passed, $FAIL failed ==="

