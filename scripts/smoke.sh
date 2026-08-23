#!/usr/bin/env bash
#
# Post-deploy smoke suite. Asserts that the controls in front of the agent are
# actually live in production, against the real CloudFront URL.
#
# This exists because every cheaper signal has already lied at least once in
# this project: `terraform apply` returned 0 while ECS rolled the release back,
# `docker build` succeeded on an image that could not boot, and an HTTP 200
# meant the site was up rather than that the deploy had landed. These
# assertions are the ones that would have caught each of those.
#
#   usage: scripts/smoke.sh <base-url> <dynamodb-table>
set -uo pipefail

BASE="${1:?usage: smoke.sh <base-url> <table>}"
TABLE="${2:?usage: smoke.sh <base-url> <table>}"
FLAG_KEY='{"pk":{"S":"flag#agent_enabled"}}'

fails=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    expected: %s\n    actual:   %s\n' "$1" "$2" "$3"; fails=$((fails + 1)); }

check() { # name expected actual
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"
}

# The kill-switch assertions disable the agent in production, so the original
# state has to be captured and put back - not assumed. An operator may have
# deliberately disabled the agent before this ran, and a smoke test that
# re-enables it would silently undo an incident response.
#
# The AWS CLI renders a DynamoDB BOOL as Python does: "True"/"False", and
# "None" when the item is absent. Normalise to JSON before writing it back.
ORIGINAL_FLAG=""   # "" = absent, otherwise "true" / "false"

capture_flag() {
  local raw
  raw="$(aws dynamodb get-item --table-name "$TABLE" --key "$FLAG_KEY" \
    --query 'Item.value.BOOL' --output text 2>/dev/null | tr -d '\r')"
  case "$raw" in
    True)  ORIGINAL_FLAG="true" ;;
    False) ORIGINAL_FLAG="false" ;;
    *)     ORIGINAL_FLAG="" ;;
  esac
}

# Restore on any exit, not just the happy path: dying between the flip and the
# restore would leave the agent down.
restore_flag() {
  if [ -z "$ORIGINAL_FLAG" ]; then
    aws dynamodb delete-item --table-name "$TABLE" --key "$FLAG_KEY" >/dev/null 2>&1 || true
  else
    aws dynamodb put-item --table-name "$TABLE" \
      --item "{\"pk\":{\"S\":\"flag#agent_enabled\"},\"value\":{\"BOOL\":$ORIGINAL_FLAG}}" \
      >/dev/null 2>&1 || true
  fi
}
trap restore_flag EXIT
capture_flag

code() { curl -s -m 45 -o /tmp/smoke.body -w '%{http_code}' "$@"; }
# tr -d '\r' is not redundant: headers arrive CRLF-terminated, and the cut
# below only happens to drop the CR because the cookie always carries
# attributes after it. Remove Path or SameSite and the CR would ride along
# into a request header, failing in a way that looks like anything but this.
new_session() {
  curl -s -m 45 -D - -o /dev/null "$BASE/api/agent/session" \
    | grep -i '^set-cookie' | tr -d '\r' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1
}
# The turn is real now: this spends Anthropic tokens on every deploy. The
# message is deliberately one no tool can help with, so the model answers in a
# sentence and the turn stays a fraction of a cent. There is no test-bypass
# header and no mock hook - a smoke test that skips the real path proves
# nothing about the real path.
chat() { # cookie
  code -X POST -H 'content-type: application/json' -H "Cookie: $1" \
    -H "Origin: $BASE" -d '{"message":"Reply with just the word: ready"}' "$BASE/api/agent/chat"
}

# Burn a session's quota cheaply.
#
# The one-word prompt keeps each turn to a handful of output tokens, so these
# usually finish well inside the two-second cap (measured ~1.4s). The cap is a
# ceiling, not the mechanism: if a turn does run long, the route aborts it when
# the client hangs up, and the allowance is still consumed either way because
# the limiter counts a turn BEFORE the model is called. That is what makes the
# next assertion meaningful without paying for six full answers.
burn() { # cookie
  curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' -H "Cookie: $1" \
    -H "Origin: $BASE" -d '{"message":"Reply with just the word: ready"}' \
    "$BASE/api/agent/chat" >/dev/null 2>&1 || true
}

echo "smoke: $BASE"

# --- the app still works -----------------------------------------------------
check "GET / serves the app"            200 "$(code "$BASE/")"
check "GET /api/ctgov proxies upstream" 200 "$(code "$BASE/api/ctgov/v2/studies?pageSize=1")"
check "SPA route is served"             200 "$(code "$BASE/trials")"

# --- CloudFront does not disguise API errors ---------------------------------
# The SPA fallback used to rewrite 403/404 to 200 /index.html for the whole
# distribution, which silently turned every agent denial into a success.
check "origin 404 survives the edge"    404 "$(code "$BASE/api/definitely-not-a-route")"
grep -q '<!doctype html' /tmp/smoke.body 2>/dev/null \
  && fail "origin 404 returns JSON not the app shell" "json" "html" \
  || pass "origin 404 returns JSON not the app shell"

# Write methods reach the origin at all: the read-only proxy's own 405 is the
# proof, and needs no endpoint that does not exist yet.
check "POST reaches the origin"         405 "$(code -X POST "$BASE/api/ctgov/v2/studies")"

# An operator may have disabled the agent on purpose. Assertions that need it
# running cannot pass, and failing the deploy over a deliberate action would be
# wrong - so say so loudly and skip them. The app-level checks above still ran.
if [ "$ORIGINAL_FLAG" = "false" ]; then
  echo
  echo "  NOTE  agent is disabled by the kill switch - skipping agent assertions"
  echo "        (the flag was already false before this run; it will be left that way)"
  echo
  [ "$fails" -gt 0 ] && { echo "::error::smoke suite failed ($fails assertion(s))"; exit 1; }
  echo "smoke suite passed (agent assertions skipped)"
  exit 0
fi

# --- session gate ------------------------------------------------------------
COOKIE="$(new_session)"
case "$COOKIE" in
  pr_sid=*) pass "session cookie is issued" ;;
  *)        fail "session cookie is issued" "pr_sid=..." "${COOKIE:-<none>}" ;;
esac

check "chat without a cookie is refused" 403 \
  "$(code -X POST -H 'content-type: application/json' -d '{"message":"x"}' "$BASE/api/agent/chat")"
check "forged cookie is refused"         403 \
  "$(code -X POST -H 'content-type: application/json' \
      -H 'Cookie: pr_sid=deadbeefdeadbeefdeadbeefdeadbeef.forged' \
      -d '{"message":"x"}' "$BASE/api/agent/chat")"
check "oversized message is refused"     400 \
  "$(code -X POST -H 'content-type: application/json' -H "Cookie: $COOKIE" \
      -d "{\"message\":\"$(head -c 4100 /dev/zero | tr '\0' 'a')\"}" "$BASE/api/agent/chat")"

# --- the happy path streams a real answer ------------------------------------
check "chat streams for a valid session" 200 "$(chat "$COOKIE")"
grep -q '^event: done' /tmp/smoke.body \
  && pass "stream reaches the done event" \
  || fail "stream reaches the done event" "event: done" "$(head -c 60 /tmp/smoke.body)"

# The model actually produced text. Without this the suite would pass just as
# happily against an endpoint that opens a stream and closes it again - which
# is exactly what a missing or rejected API key looks like from outside.
grep -q '^event: delta' /tmp/smoke.body \
  && pass "the model produced output" \
  || fail "the model produced output" "event: delta" "$(head -c 120 /tmp/smoke.body)"

# A turn that ended any other way is a truncation, a refusal or a timeout, and
# the deploy should say so rather than counting it as a working assistant.
grep -q '"stop":"end_turn"' /tmp/smoke.body \
  && pass "the turn finished cleanly" \
  || fail "the turn finished cleanly" '"stop":"end_turn"' "$(grep -o '"stop":"[a-z_]*"' /tmp/smoke.body | head -1)"

# --- rate limits are enforced ------------------------------------------------
# Session cap is 5/min. Burn it on a throwaway session so the assertion does
# not depend on how many turns the checks above happened to use.
BURST="$(new_session)"
for _ in $(seq 1 6); do burn "$BURST"; done
# This one runs to completion: a 429 is refused before the model, so it costs
# nothing and returns immediately.
check "session rate limit engages"       429 "$(chat "$BURST")"

RETRY="$(curl -s -m 45 -o /dev/null -D - -X POST -H 'content-type: application/json' \
  -H "Cookie: $BURST" -H "Origin: $BASE" -d '{"message":"x"}' "$BASE/api/agent/chat" \
  | grep -i '^retry-after' | tr -d '\r' | awk '{print $2}')"
# Derived from the remainder of the current UTC minute, so any 1..60 is right
# and a fixed 60 every time would be the bug this replaced.
if [ -n "$RETRY" ] && [ "$RETRY" -ge 1 ] && [ "$RETRY" -le 60 ]; then
  pass "Retry-After is within the current window ($RETRY s)"
else
  fail "Retry-After is within the current window" "1..60" "${RETRY:-<none>}"
fi

# --- kill switch -------------------------------------------------------------
aws dynamodb put-item --table-name "$TABLE" \
  --item '{"pk":{"S":"flag#agent_enabled"},"value":{"BOOL":false}}' >/dev/null
sleep 12 # the flag is cached for 10s per task

KILLED="$(chat "$(new_session)")"
check "kill switch stops the agent"      503 "$KILLED"
check "kill switch spares the app"       200 "$(code "$BASE/")"
check "kill switch spares the proxy"     200 "$(code "$BASE/api/ctgov/v2/studies?pageSize=1")"

restore_flag
sleep 12
check "agent recovers when re-enabled"   200 "$(chat "$(new_session)")"

echo
if [ "$fails" -gt 0 ]; then
  echo "::error::smoke suite failed ($fails assertion(s))"
  exit 1
fi
echo "smoke suite passed"
