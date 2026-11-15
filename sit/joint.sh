#!/usr/bin/env bash
# Joint SIT: air-tools-gateway on air-net with air-infra's Redis, checked from every side.
#
#   make sit-joint            # needs air-infra up (air-net, redis); rebuilds this service
#
#   1. Build and start the compose service on air-net; wait for /v1/ready (store included).
#   2. From inside air-net: the name the orchestrator uses (http://air-tools-gateway:8080).
#   3. This repo's smoke walkthrough (sit/smoke.sh).
#   4. The orchestrator's live SIT against this build (its `make sit-tools`), when the
#      orchestrator checkout and its virtualenv are present. Read-only: it runs their tests,
#      it changes nothing in that repo.
#   5. The load test (scripts/load.ts): contention invariants and lookup latency.
#   6. A restart keeps idempotency records: the smoke's execute replays unchanged.
#
# The fixture store resets on every restart, so the service is restarted between steps.
# Exit code 0 only when every step passed; skipped steps are reported, not failed.
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8084}"
BASE_URL="http://localhost:${PORT}"
ORCH_DIR="${ORCH_DIR:-../air-orchestrator-service}"
COMPOSE="${COMPOSE:-docker compose}"
SERVICE=air-tools-gateway

results=()
failed=0
record() { # record STEP STATUS
  results+=("$(printf '%-44s %s' "$1" "$2")")
  [[ "$2" == FAIL* ]] && failed=$((failed + 1))
}

wait_ready() {
  for _ in $(seq 1 60); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/v1/ready")" == "200" ]] && return 0
    sleep 1
  done
  curl -s "$BASE_URL/v1/ready"; echo
  return 1
}

restart() {
  $COMPOSE restart "$SERVICE" >/dev/null && wait_ready
}

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

if ! docker network inspect air-net >/dev/null 2>&1; then
  echo "air-net does not exist: start air-infra first (cd ../air-infrastructure-service && make up)."
  exit 1
fi

step "1. build and start on air-net"
if $COMPOSE up -d --build "$SERVICE" && wait_ready; then
  curl -s "$BASE_URL/v1/ready"; echo
  if curl -s "$BASE_URL/v1/ready" | grep -q '"name":"store","ok":true'; then
    record "1. up on air-net, store ready" ok
  else
    record "1. up on air-net, store ready" "FAIL (no store check: not on Redis?)"
  fi
else
  record "1. up on air-net, store ready" FAIL
  printf '%s\n' "${results[@]}"
  exit 1
fi

step "2. reachable as the orchestrator addresses it"
if docker run --rm --network air-net air-tools-gateway:local node -e \
  "fetch('http://air-tools-gateway:8080/v1/ready').then(async r=>{console.log(r.status, await r.text()); process.exit(r.ok?0:1)},e=>{console.error(e.message); process.exit(1)})"; then
  record "2. http://air-tools-gateway:8080 on air-net" ok
else
  record "2. http://air-tools-gateway:8080 on air-net" FAIL
fi

step "3. smoke walkthrough"
smoke_log="$(mktemp)"
trap 'rm -f "$smoke_log"' EXIT
if restart && BASE_URL="$BASE_URL" bash sit/smoke.sh | tee "$smoke_log"; then
  record "3. sit/smoke.sh" ok
else
  record "3. sit/smoke.sh" FAIL
fi

step "4. the orchestrator's live SIT against this build"
if [[ -x "$ORCH_DIR/.venv/bin/pytest" ]] && grep -q '^sit-tools:' "$ORCH_DIR/Makefile" 2>/dev/null; then
  if restart && make -C "$ORCH_DIR" --no-print-directory sit-tools URL="$BASE_URL"; then
    record "4. orchestrator make sit-tools" ok
  else
    record "4. orchestrator make sit-tools" FAIL
  fi
else
  echo "skipped: no $ORCH_DIR/.venv/bin/pytest or no sit-tools target (run its make install)."
  record "4. orchestrator make sit-tools" "skipped"
fi

step "5. load test"
if restart && BASE_URL="$BASE_URL" npx --no-install tsx scripts/load.ts; then
  record "5. scripts/load.ts" ok
else
  record "5. scripts/load.ts" FAIL
fi

step "6. idempotency records survive a restart"
# Propose and execute once, restart (the fixture resets, Redis does not), replay the key.
key="joint-restart-$(date +%s)-$$"
R=(-H "X-API-Key: airtg_read_local_dev" -H "Content-Type: application/json")
E=(-H "X-API-Key: airtg_exec_local_dev" -H "Content-Type: application/json" -H "Idempotency-Key: $key")
if restart; then
  pid="$(curl -s "$BASE_URL/v1/actions/orders.cancel/propose" "${R[@]}" \
    -d '{"arguments":{"order_id":"55120"},"subject":"cust_1001"}' | grep -o 'gp_[0-9a-f]*')"
  body="{\"proposal_id\":\"$pid\",\"subject\":\"cust_1001\"}"
  first="$(curl -s "$BASE_URL/v1/actions/orders.cancel/execute" "${E[@]}" -d "$body")"
  restart
  again="$(curl -s "$BASE_URL/v1/actions/orders.cancel/execute" "${E[@]}" -d "$body")"
  if [[ -n "$pid" && "$first" == *'"status":"done"'* && "$first" == "$again" ]]; then
    record "6. replay after restart, byte-identical" ok
  else
    echo "first: $first"; echo "again: $again"
    record "6. replay after restart, byte-identical" FAIL
  fi
else
  record "6. replay after restart, byte-identical" FAIL
fi

# Leave a fresh fixture behind for whoever uses it next.
restart >/dev/null 2>&1 || true

printf '\n\033[1m== joint SIT summary\033[0m\n'
printf '%s\n' "${results[@]}"
if [[ $failed -eq 0 ]]; then
  printf '\033[32mall steps passed\033[0m\n'
else
  printf '\033[31m%d step(s) failed\033[0m\n' "$failed"
  exit 1
fi
