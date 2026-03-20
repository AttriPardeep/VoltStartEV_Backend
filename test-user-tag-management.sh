#!/bin/bash
# test-user-tag-management.sh - User & Tag Management Test Suite

BASE_URL="http://localhost:3000/api"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "⚡ VoltStartEV User & Tag Management Tests"
echo "=========================================="
echo ""

# Helper function to check result
check_result() {
  local test_name="$1"
  local response="$2"
  local expected_field="$3"
  
  if echo "$response" | jq -e ".$expected_field" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ PASS${NC}: $test_name"
    ((PASS++))
  else
    echo -e "${RED}❌ FAIL${NC}: $test_name"
    echo "   Response: $response"
    ((FAIL++))
  fi
}

# Test 1: Register new user
echo -e "${YELLOW}1. Registering new user...${NC}"
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/users" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser'"$(date +%s)"'",
    "email": "test'"$(date +%s)"'@example.com",
    "password": "TestPass123!",
    "firstName": "Test",
    "lastName": "User"
  }')

echo "   Response: $(echo "$REGISTER_RESPONSE" | jq -c '.success, .data.userId')"
check_result "User Registration" "$REGISTER_RESPONSE" "success"
USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.data.userId // empty')
echo "   Created User ID: ${USER_ID:-N/A}"
echo ""

# Test 2: Login
echo -e "${YELLOW}2. Testing login...${NC}"
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/users/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "'$(echo "$REGISTER_RESPONSE" | jq -r '.data.username')'",
    "password": "TestPass123!"
  }')

echo "   Response: $(echo "$LOGIN_RESPONSE" | jq -c '.success, .data.user.username')"
check_result "User Login" "$LOGIN_RESPONSE" "success"
echo ""

# Test 3: Assign tag to user (skip if no user created)
if [ -n "$USER_ID" ]; then
  echo -e "${YELLOW}3. Assigning tag USER_TEST to user $USER_ID...${NC}"
  ASSIGN_RESPONSE=$(curl -s -X POST "$BASE_URL/users/$USER_ID/tags" \
    -H "Content-Type: application/json" \
    -d '{
      "idTag": "USER_TEST_'"$(date +%s)"'",
      "nickname": "Test Card"
    }')
  
  echo "   Response: $(echo "$ASSIGN_RESPONSE" | jq -c '.success, .message')"
  check_result "Tag Assignment" "$ASSIGN_RESPONSE" "success"
  TAG_ID=$(echo "$ASSIGN_RESPONSE" | jq -r '.data.idTag // empty')
  echo "   Assigned Tag: ${TAG_ID:-N/A}"
  echo ""
  
  # Test 4: Get user's tags
  echo -e "${YELLOW}4. Getting tags for user $USER_ID...${NC}"
  TAGS_RESPONSE=$(curl -s "$BASE_URL/users/$USER_ID/tags")
  echo "   Response: $(echo "$TAGS_RESPONSE" | jq -c '.success, (.data.tags | length)')"
  check_result "Get User Tags" "$TAGS_RESPONSE" "success"
  echo ""
  
  # Test 5: Get tag assignment
  if [ -n "$TAG_ID" ]; then
    echo -e "${YELLOW}5. Checking assignment for tag $TAG_ID...${NC}"
    ASSIGNMENT_RESPONSE=$(curl -s "$BASE_URL/tags/$TAG_ID/assignment")
    echo "   Response: $(echo "$ASSIGNMENT_RESPONSE" | jq -c '.success, .data.app_user_id')"
    check_result "Get Tag Assignment" "$ASSIGNMENT_RESPONSE" "success"
    echo ""
  fi
fi

# Test 6: List all tags
echo -e "${YELLOW}6. Listing all tags...${NC}"
ALL_TAGS_RESPONSE=$(curl -s "$BASE_URL/tags")
echo "   Response: $(echo "$ALL_TAGS_RESPONSE" | jq -c '.success, (.data.tags | length)')"
check_result "List All Tags" "$ALL_TAGS_RESPONSE" "success"
echo ""

# Test 7: Remove tag from user (if tag was assigned)
if [ -n "$USER_ID" ] && [ -n "$TAG_ID" ]; then
  echo -e "${YELLOW}7. Removing tag $TAG_ID from user $USER_ID...${NC}"
  REMOVE_RESPONSE=$(curl -s -X DELETE "$BASE_URL/users/$USER_ID/tags/$TAG_ID")
  echo "   Response: $(echo "$REMOVE_RESPONSE" | jq -c '.success, .message')"
  check_result "Remove Tag" "$REMOVE_RESPONSE" "success"
  echo ""
  
  # Test 8: Verify tag is unassigned
  echo -e "${YELLOW}8. Verifying tag is unassigned...${NC}"
  VERIFY_RESPONSE=$(curl -s "$BASE_URL/tags/$TAG_ID/assignment")
  echo "   Response: $(echo "$VERIFY_RESPONSE" | jq -c '.error // .data')"
  if echo "$VERIFY_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${GREEN}✅ PASS${NC}: Tag correctly shows as unassigned"
    ((PASS++))
  else
    echo -e "${RED}❌ FAIL${NC}: Tag should show as unassigned"
    ((FAIL++))
  fi
  echo ""
fi

# Summary
echo "=========================================="
echo -e "${GREEN}PASSED: $PASS${NC} | ${RED}FAILED: $FAIL${NC}"
echo "=========================================="

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✅ All tests completed successfully!${NC}"
  exit 0
else
  echo -e "${RED}❌ Some tests failed. Check output above.${NC}"
  exit 1
fi
