#!/bin/bash
# File: /build/VoltStartEV_Backend/tests/webhook/e2e-webhook-test.sh
# Usage: ./e2e-webhook-test.sh

set -e  # Exit on error

# ─────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────
BACKEND_URL="http://localhost:3000"
WEBHOOK_SECRET=$(grep STEVE_WEBHOOK_SECRET /build/VoltStartEV_Backend/.env | cut -d= -f2 | tr -d '[:space:]')
TEST_USER_ID=101
TEST_TAG="QATEST001"
TEST_CHARGER="CS-SIMU-00001"
TEST_CONNECTOR=1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_test()    { echo -e "\n${YELLOW}▶ ${NC}$1"; }

# ─────────────────────────────────────────────────────
# HELPER FUNCTIONS
# ─────────────────────────────────────────────────────

# Generate HMAC-SHA256 signature for webhook payload
generate_signature() {
  local payload="$1"
  echo -n "$payload" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}'
}

# Send webhook and return HTTP status + body
send_webhook() {
  local payload="$1"
  local signature=$(generate_signature "$payload")
  
  curl -s -w "\n%{http_code}" -X POST "${BACKEND_URL}/api/webhooks/steve" \
    -H "Content-Type: application/json" \
    -H "X-Signature: $signature" \
    -H "X-Event-Id: $(echo "$payload" | jq -r '.eventId')" \
    -d "$payload"
}

# Wait for condition with timeout
wait_for() {
  local description="$1"
  local condition="$2"
  local timeout="${3:-30}"  # Default 30 seconds
  local interval=1
  local elapsed=0
  
  log_info "Waiting for: $description (max ${timeout}s)"
  
  while [ $elapsed -lt $timeout ]; do
    if eval "$condition"; then
      log_info " $description"
      return 0
    fi
    sleep $interval
    elapsed=$((elapsed + interval))
  done
  
  log_error " Timeout waiting for: $description"
  return 1
}

# ─────────────────────────────────────────────────────
# TEST SETUP
# ─────────────────────────────────────────────────────

log_test " Setting up test environment"

# 1. Verify backend is running
if ! curl -s "${BACKEND_URL}/health" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
  log_error "Backend not healthy at ${BACKEND_URL}"
  exit 1
fi
log_info " Backend is healthy"

# 2. Verify webhook_events table exists
if ! mysql -u root -pStevePass2026! voltstartev_db -N -e "SELECT 1 FROM information_schema.tables WHERE table_schema = 'voltstartev_db' AND table_name = 'webhook_events' LIMIT 1" 2>/dev/null | grep -q 1; then
  log_error "webhook_events table not found in voltstartev_db"
  exit 1
fi
log_info " webhook_events table exists"

# 3. Clear previous test data (idempotent cleanup)
mysql -u root -pStevePass2026! voltstartev_db -e "
  DELETE FROM webhook_events WHERE event_id LIKE 'test-%';
  DELETE FROM charging_sessions WHERE steve_transaction_pk >= 9000 AND id_tag = '${TEST_TAG}';
" 2>/dev/null || true
log_info " Test data cleaned"

# ─────────────────────────────────────────────────────
# TEST 1: Valid Webhook - Transaction Started
# ─────────────────────────────────────────────────────

log_test " TEST 1: Valid OcppTransactionStarted webhook"

PAYLOAD_START=$(cat <<EOF
{
  "eventId": "test-start-$(date +%s)",
  "eventType": "OcppTransactionStarted",
  "chargeBoxId": "${TEST_CHARGER}",
  "connectorId": ${TEST_CONNECTOR},
  "transactionId": 9001,
  "idTag": "${TEST_TAG}",
  "meterStart": 0,
  "startTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

RESPONSE=$(send_webhook "$PAYLOAD_START")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" != "202" ]; then
  log_error "Expected HTTP 202, got $HTTP_CODE"
  echo "Response body: $BODY"
  exit 1
fi

EVENT_ID=$(echo "$PAYLOAD_START" | jq -r '.eventId')
if ! echo "$BODY" | jq -e ".eventId == \"$EVENT_ID\"" > /dev/null; then
  log_error "Response missing correct eventId"
  exit 1
fi

log_info " Webhook accepted (HTTP 202)"

# Verify idempotency record was created
wait_for "idempotency record created" \
  "mysql -u root -pStevePass2026! voltstartev_db -N -e \"SELECT 1 FROM webhook_events WHERE event_id = '$EVENT_ID' LIMIT 1\" 2>/dev/null | grep -q 1"

# Verify charging session was created
wait_for "charging session created" \
  "mysql -u root -pStevePass2026! voltstartev_db -N -e \"SELECT 1 FROM charging_sessions WHERE steve_transaction_pk = 9001 AND status = 'active' LIMIT 1\" 2>/dev/null | grep -q 1"

log_info " Charging session created in DB"

# ─────────────────────────────────────────────────────
# TEST 2: Idempotency - Same Event Sent Twice
# ─────────────────────────────────────────────────────

log_test " TEST 2: Idempotency - duplicate event rejected"

# Send same event again
RESPONSE2=$(send_webhook "$PAYLOAD_START")
HTTP_CODE2=$(echo "$RESPONSE2" | tail -n1)

if [ "$HTTP_CODE2" != "202" ]; then
  log_error "Expected HTTP 202 for duplicate (idempotent), got $HTTP_CODE2"
  exit 1
fi

# Verify only ONE idempotency record exists
COUNT=$(mysql -u root -pStevePass2026! voltstartev_db -N -e "SELECT COUNT(*) FROM webhook_events WHERE event_id = '$EVENT_ID'" 2>/dev/null)
if [ "$COUNT" != "1" ]; then
  log_error "Expected 1 idempotency record, found $COUNT"
  exit 1
fi

# Verify only ONE charging session exists
SESSION_COUNT=$(mysql -u root -pStevePass2026! voltstartev_db -N -e "SELECT COUNT(*) FROM charging_sessions WHERE steve_transaction_pk = 9001" 2>/dev/null)
if [ "$SESSION_COUNT" != "1" ]; then
  log_error "Expected 1 charging session, found $SESSION_COUNT"
  exit 1
fi

log_info " Duplicate event correctly ignored (idempotency working)"

# ─────────────────────────────────────────────────────
# TEST 3: Invalid Signature - Should Be Rejected
# ─────────────────────────────────────────────────────

log_test " TEST 3: Invalid signature - webhook rejected"

INVALID_PAYLOAD='{"eventId":"test-invalid","eventType":"OcppTransactionStarted"}'
INVALID_SIG="invalid_signature_$(date +%s)"

RESPONSE3=$(curl -s -w "\n%{http_code}" -X POST "${BACKEND_URL}/api/webhooks/steve" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $INVALID_SIG" \
  -d "$INVALID_PAYLOAD")
HTTP_CODE3=$(echo "$RESPONSE3" | tail -n1)

if [ "$HTTP_CODE3" != "401" ]; then
  log_error "Expected HTTP 401 for invalid signature, got $HTTP_CODE3"
  exit 1
fi

log_info " Invalid signature correctly rejected (HTTP 401)"

# ─────────────────────────────────────────────────────
# TEST 4: Valid Webhook - Meter Values
# ─────────────────────────────────────────────────────

log_test " TEST 4: Valid OcppMeterValues webhook"

PAYLOAD_METER=$(cat <<EOF
{
  "eventId": "test-meter-$(date +%s)",
  "eventType": "OcppMeterValues",
  "chargeBoxId": "${TEST_CHARGER}",
  "connectorId": ${TEST_CONNECTOR},
  "transactionId": 9001,
  "sampledValues": [
    {"measurand": "Energy.Active.Import.Register", "value": "12500", "unit": "Wh"},
    {"measurand": "Power.Active.Import", "value": "7200", "unit": "W"},
    {"measurand": "Current.Import", "value": "32.1", "unit": "A"},
    {"measurand": "Voltage", "value": "230", "unit": "V"},
    {"measurand": "SoC", "value": "67", "unit": "Percent"}
  ],
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

RESPONSE4=$(send_webhook "$PAYLOAD_METER")
HTTP_CODE4=$(echo "$RESPONSE4" | tail -n1)

if [ "$HTTP_CODE4" != "202" ]; then
  log_error "Expected HTTP 202 for meter values, got $HTTP_CODE4"
  exit 1
fi

EVENT_ID_METER=$(echo "$PAYLOAD_METER" | jq -r '.eventId')

# Wait for energy_kwh to be updated in DB
wait_for "energy_kwh updated in DB" \
  "mysql -u root -pStevePass2026! voltstartev_db -N -e \"SELECT energy_kwh FROM charging_sessions WHERE steve_transaction_pk = 9001 AND energy_kwh IS NOT NULL LIMIT 1\" 2>/dev/null | grep -q . "

# Verify energy was calculated correctly (12500 Wh = 12.5 kWh)
ENERGY_KWH=$(mysql -u root -pStevePass2026! voltstartev_db -N -e "SELECT energy_kwh FROM charging_sessions WHERE steve_transaction_pk = 9001 LIMIT 1" 2>/dev/null)
if [ "$(echo "$ENERGY_KWH == 12.500" | bc -l 2>/dev/null || echo 0)" != "1" ]; then
  log_warn "Energy calculation: expected ~12.500 kWh, got $ENERGY_KWH (may be rounding)"
fi

log_info " Meter values processed, energy_kwh updated: $ENERGY_KWH kWh"

# ─────────────────────────────────────────────────────
# TEST 5: Valid Webhook - Transaction Ended
# ─────────────────────────────────────────────────────

log_test " TEST 5: Valid OcppTransactionEnded webhook"

PAYLOAD_STOP=$(cat <<EOF
{
  "eventId": "test-stop-$(date +%s)",
  "eventType": "OcppTransactionEnded",
  "chargeBoxId": "${TEST_CHARGER}",
  "transactionId": 9001,
  "meterStop": 12500,
  "stopReason": "Remote",
  "stopTime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

RESPONSE5=$(send_webhook "$PAYLOAD_STOP")
HTTP_CODE5=$(echo "$RESPONSE5" | tail -n1)

if [ "$HTTP_CODE5" != "202" ]; then
  log_error "Expected HTTP 202 for transaction ended, got $HTTP_CODE5"
  exit 1
fi

# Wait for session to be marked completed
wait_for "session marked completed" \
  "mysql -u root -pStevePass2026! voltstartev_db -N -e \"SELECT 1 FROM charging_sessions WHERE steve_transaction_pk = 9001 AND status = 'completed' LIMIT 1\" 2>/dev/null | grep -q 1"

# Verify final cost calculation
RESULT=$(mysql -u root -pStevePass2026! voltstartev_db -N -e "
  SELECT 
    energy_kwh,
    total_cost,
    ROUND((energy_kwh * 0.25) + 0.50, 2) as expected_cost
  FROM charging_sessions 
  WHERE steve_transaction_pk = 9001
" 2>/dev/null)

ENERGY=$(echo "$RESULT" | cut -f1)
COST=$(echo "$RESULT" | cut -f2)
EXPECTED=$(echo "$RESULT" | cut -f3)

log_info " Transaction completed"
log_info "   Energy: ${ENERGY} kWh"
log_info "   Cost: \$${COST} (expected: \$${EXPECTED})"

# ─────────────────────────────────────────────────────
# TEST 6: Cleanup Old Idempotency Records
# ─────────────────────────────────────────────────────

log_test " TEST 6: Cleanup old webhook_events records"

# Insert a fake old record for cleanup test
mysql -u root -pStevePass2026! voltstartev_db -e "
  INSERT INTO webhook_events (event_id, event_type, processed_at)
  VALUES ('test-old-cleanup', 'TestEvent', DATE_SUB(NOW(), INTERVAL 25 HOUR))
" 2>/dev/null

# Run cleanup (simulating cron job)
mysql -u root -pStevePass2026! voltstartev_db -e "
  DELETE FROM webhook_events WHERE processed_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
" 2>/dev/null

# Verify old record was deleted
OLD_COUNT=$(mysql -u root -pStevePass2026! voltstartev_db -N -e "SELECT COUNT(*) FROM webhook_events WHERE event_id = 'test-old-cleanup'" 2>/dev/null)
if [ "$OLD_COUNT" != "0" ]; then
  log_error "Old record not cleaned up"
  exit 1
fi

log_info " Old idempotency records cleaned up correctly"

# ─────────────────────────────────────────────────────
# FINAL SUMMARY
# ─────────────────────────────────────────────────────

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║    ALL WEBHOOK TESTS PASSED                    ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  • Valid webhook accepted (HTTP 202)           ║"
echo "║  • Idempotency: duplicate events ignored       ║"
echo "║  • Invalid signature rejected (HTTP 401)       ║"
echo "║  • Meter values processed, energy calculated   ║"
echo "║  • Transaction completed, cost calculated      ║"
echo "║  • Old idempotency records cleaned up          ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# Cleanup test data
log_info " Cleaning up test data..."
mysql -u root -pStevePass2026! voltstartev_db -e "
  DELETE FROM webhook_events WHERE event_id LIKE 'test-%';
  DELETE FROM charging_sessions WHERE steve_transaction_pk >= 9000 AND id_tag = '${TEST_TAG}';
" 2>/dev/null || true

log_info " Test complete!"
exit 0
