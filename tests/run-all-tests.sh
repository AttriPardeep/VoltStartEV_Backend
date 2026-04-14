#!/bin/bash
# File: tests/run-all-tests.sh

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     VoltStartEV Backend - Complete Test Suite            ║"
echo "║     Version: v1.0 | March 2026                           ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=124

# Run all test suites
echo " Running Pre-Test Verification..."
bash tests/00-pre-test-health.sh
echo ""

echo " Running Authentication Tests..."
bash tests/01-auth-tests.sh
echo ""

echo " Running Start Charging Tests..."
bash tests/02-start-charging-tests.sh
echo ""

echo " Running Meter Values Tests..."
bash tests/03-meter-values-tests.sh
echo ""

echo " Running Stop Charging Tests..."
bash tests/04-stop-charging-tests.sh
echo ""

echo " Running Webhook Tests..."
bash tests/05-webhook-tests.sh
echo ""

echo " Running Reconciliation Tests..."
bash tests/06-reconciliation-tests.sh
echo ""

echo " Running Resilience Tests..."
bash tests/07-resilience-tests.sh
echo ""

echo " Running Load Tests..."
bash tests/08-load-tests.sh
echo ""

echo "️  Running Database Integrity Tests..."
bash tests/09-db-integrity-tests.sh
echo ""

echo " Running Billing Tests..."
bash tests/10-billing-tests.sh
echo ""

echo " Running Security Tests..."
bash tests/11-security-tests.sh
echo ""

echo " Running End-to-End Tests..."
bash tests/12-e2e-tests.sh
echo ""

# Generate Summary Report
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                  TEST EXECUTION SUMMARY                  ║"
echo "╠══════════════════════════════════════════════════════════╣"

# Count results from log files
for log in /tmp/test-*.log; do
    if [ -f "$log" ]; then
        PASS=$(grep -c " PASS" "$log" 2>/dev/null || echo 0)
        FAIL=$(grep -c " FAIL" "$log" 2>/dev/null || echo 0)
        TOTAL_PASS=$((TOTAL_PASS + PASS))
        TOTAL_FAIL=$((TOTAL_FAIL + FAIL))
    fi
done

PASS_PERCENT=$((TOTAL_PASS * 100 / (TOTAL_PASS + TOTAL_FAIL)))

printf "║  %-30s %10d ║\n" "Total Tests:" "$TOTAL_TESTS"
printf "║  %-30s %10d ║\n" "Passed:" "$TOTAL_PASS"
printf "║  %-30s %10d ║\n" "Failed:" "$TOTAL_FAIL"
printf "║  %-30s %9d%% ║\n" "Pass Rate:" "$PASS_PERCENT"
echo "╠══════════════════════════════════════════════════════════╣"

if [ "$PASS_PERCENT" -ge 95 ]; then
    echo "║   ALL TESTS PASSED - READY FOR PRODUCTION            ║"
elif [ "$PASS_PERCENT" -ge 90 ]; then
    echo "║    MINOR ISSUES - REVIEW FAILURES BEFORE DEPLOY      ║"
else
    echo "║   CRITICAL ISSUES - FIX FAILURES BEFORE DEPLOY       ║"
fi
echo "╚══════════════════════════════════════════════════════════╝"

# Save report
cat > /tmp/test-report-$(date +%Y%m%d-%H%M%S).txt << EOF
VoltStartEV Test Report
=======================
Date: $(date)
Total Tests: $TOTAL_TESTS
Passed: $TOTAL_PASS
Failed: $TOTAL_FAIL
Pass Rate: ${PASS_PERCENT}%
EOF

echo ""
echo " Report saved to: /tmp/test-report-$(date +%Y%m%d-%H%M%S).txt"

