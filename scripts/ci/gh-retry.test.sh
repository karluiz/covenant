#!/usr/bin/env bash
# Self-check for gh-retry.sh. Run directly: scripts/ci/gh-retry.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RETRY="$HERE/gh-retry.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Keep the suite fast — real backoff is 10s+.
export GH_RETRY_BASE_SECONDS=0

fail() { echo "FAIL: $1" >&2; exit 1; }

# A command that fails until a counter file reaches N, then succeeds.
cat >"$TMP/flaky" <<'EOF'
#!/usr/bin/env bash
count=$(( $(cat "$COUNTER") + 1 ))
echo "$count" > "$COUNTER"
[ "$count" -ge "$SUCCEED_ON" ]
EOF
chmod +x "$TMP/flaky"
export COUNTER="$TMP/n"

# 1. Succeeds first try → runs exactly once, exit 0.
echo 0 >"$COUNTER"; SUCCEED_ON=1 "$RETRY" "$TMP/flaky" || fail "should succeed on first attempt"
[ "$(cat "$COUNTER")" = "1" ] || fail "expected 1 invocation, got $(cat "$COUNTER")"

# 2. Fails twice then succeeds → retried, exit 0. This is the outage case.
echo 0 >"$COUNTER"; SUCCEED_ON=3 "$RETRY" "$TMP/flaky" || fail "should recover after transient failures"
[ "$(cat "$COUNTER")" = "3" ] || fail "expected 3 invocations, got $(cat "$COUNTER")"

# 3. Always fails → gives up after GH_RETRY_ATTEMPTS and exits non-zero.
#    A retry wrapper that swallows a real failure is worse than none at all.
echo 0 >"$COUNTER"
if SUCCEED_ON=99 GH_RETRY_ATTEMPTS=4 "$RETRY" "$TMP/flaky" 2>/dev/null; then
  fail "should propagate failure once attempts are exhausted"
fi
[ "$(cat "$COUNTER")" = "4" ] || fail "expected 4 invocations, got $(cat "$COUNTER")"

# 4. Arguments survive the wrapper intact (paths with spaces, flags).
out=$("$RETRY" printf '%s|%s' "a b" "--clobber") || fail "argv passthrough failed"
[ "$out" = "a b|--clobber" ] || fail "argv mangled: got '$out'"

echo "ok — gh-retry self-check passed"
