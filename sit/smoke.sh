#!/usr/bin/env bash
# Smoke walkthrough of air-tools-gateway (handoff §11) against a running instance.
#
#   make smoke                                  # BASE_URL defaults to http://localhost:8084
#   BASE_URL=http://localhost:18084 sit/smoke.sh
#
# Needs bash and curl only. It cancels Brightcart order 55120, so a second run needs the
# fixture reset first: restart the service (`docker compose restart air-tools-gateway`, or
# stop and start `make run-sit`).
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8084}"
READ_KEY="${READ_KEY:-airtg_read_local_dev}"
EXEC_KEY="${EXEC_KEY:-airtg_exec_local_dev}"
RUN_ID="smoke-$(date +%s)-$$"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

pass=0
fail=0
STATUS=""
BODY=""

# request METHOD PATH [KEY] [BODY] [extra curl args...] → sets STATUS and BODY
request() {
  local method="$1" path="$2" key="${3:-}" body="${4:-}"
  shift 4 2>/dev/null || shift $#
  local args=(-s -o "$OUT" -w '%{http_code}' -X "$method" -H "X-Request-ID: $RUN_ID")
  [[ -n "$key" ]] && args+=(-H "X-API-Key: $key")
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" --data "$body")
  STATUS="$(curl "${args[@]}" "$@" "$BASE_URL$path")" || STATUS="000"
  BODY="$(cat "$OUT" 2>/dev/null)"
  : >"$OUT"
}

# expect LABEL STATUS [PATTERN...]: every fixed-string PATTERN must appear in the body
expect() {
  local label="$1" want="$2"
  shift 2
  local ok=1
  [[ "$STATUS" == "$want" ]] || ok=0
  for pattern in "$@"; do
    [[ "$BODY" == *"$pattern"* ]] || ok=0
  done
  if [[ $ok -eq 1 ]]; then
    printf '  \033[32mok\033[0m   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m %s\n       expected %s %s\n       got      %s %s\n' \
      "$label" "$want" "$*" "$STATUS" "${BODY:0:300}"
    fail=$((fail + 1))
  fi
}

echo "air-tools-gateway smoke against $BASE_URL (request id $RUN_ID)"

request GET /v1/health "" ""
expect "health" 200 '"status":"ok"'
if [[ "$STATUS" == "000" ]]; then
  echo "  Nothing answers at $BASE_URL. Start it: make up (or make run-sit)."
  exit 1
fi

request GET /v1/ready "" ""
expect "ready, orders backend ok" 200 '"status":"ready"' '"name":"orders_backend","ok":true'

request GET /v1/capabilities "$READ_KEY" ""
expect "capabilities lists the three" 200 '"orders.list_recent"' '"orders.get"' '"orders.cancel"'

request POST /v1/tools/orders.list_recent "$READ_KEY" '{"arguments":{"limit":5},"subject":"cust_1001"}'
expect "list recent orders for cust_1001" 200 '"order_id":"55120"' '"order_id":"48213"'
[[ "$BODY" == *'"70011"'* ]] && { echo "  FAIL another customer's order leaked"; fail=$((fail + 1)); }

request POST /v1/tools/orders.get "$READ_KEY" '{"arguments":{"order_id":"55120"},"subject":"cust_1001"}'
expect "get 55120" 200 '"order_id":"55120"' '"Cotton bath towel set"'
if [[ "$BODY" == *'"status":"cancelled"'* ]]; then
  echo "  55120 is already cancelled: a previous smoke run changed the fixture."
  echo "  Reset it by restarting the service, then run this again."
  exit 1
fi

request POST /v1/actions/orders.cancel/propose "$READ_KEY" \
  '{"arguments":{"order_id":"55120","reason":"changed_mind"},"subject":"cust_1001"}'
expect "propose cancel (changes nothing)" 200 '"proposal_id":"gp_' '"risk":"low"' '₹1,240.00'
proposal_id="$(printf '%s' "$BODY" | grep -o '"proposal_id":"gp_[0-9a-f]*"' | cut -d'"' -f4)"

request POST /v1/tools/orders.get "$READ_KEY" '{"arguments":{"order_id":"55120"},"subject":"cust_1001"}'
expect "still confirmed after propose" 200 '"status":"confirmed"'

execute_body="{\"proposal_id\":\"${proposal_id}\",\"subject\":\"cust_1001\"}"
request POST /v1/actions/orders.cancel/execute "$EXEC_KEY" "$execute_body" -H "Idempotency-Key: $RUN_ID-exec"
expect "execute with the execute key" 200 '"status":"done"' '"eta_business_days":3'
first="$BODY"

request POST /v1/actions/orders.cancel/execute "$EXEC_KEY" "$execute_body" -H "Idempotency-Key: $RUN_ID-exec"
expect "replay returns the same response" 200 '"status":"done"'
if [[ "$BODY" != "$first" ]]; then
  echo "  FAIL replay body differs from the first"
  fail=$((fail + 1))
fi

request POST /v1/actions/orders.cancel/execute "$EXEC_KEY" "$execute_body" -H "Idempotency-Key: $RUN_ID-other"
expect "a new key on an executed proposal is refused" 409 '"code":"already_executed"'

request POST /v1/actions/orders.cancel/execute "$READ_KEY" "$execute_body" -H "Idempotency-Key: $RUN_ID-read"
expect "a read key on execute is refused" 403 '"code":"forbidden"'

request POST /v1/tools/orders.get "$READ_KEY" '{"arguments":{"order_id":"55120"},"subject":"cust_1002"}'
expect "cust_1002 cannot see 55120" 404 '"code":"not_found"'

request POST /v1/tools/orders.get "$READ_KEY" '{"arguments":{"order_id":"55120"},"subject":"cust_1001"}'
expect "55120 is now cancelled" 200 '"status":"cancelled"'

echo
if [[ $fail -eq 0 ]]; then
  printf '\033[32m%d passed\033[0m\n' "$pass"
else
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass"
  exit 1
fi
