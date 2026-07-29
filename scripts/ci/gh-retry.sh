#!/usr/bin/env bash
#
# Retry a `gh` invocation through GitHub's transient 5xx storms.
#
#   scripts/ci/gh-retry.sh gh release upload "$TAG" foo.dmg --clobber
#
# Why this exists: a release build costs ~25 minutes, and a single 502/503 from
# uploads.github.com used to throw all of it away. The v0.9.42–v0.9.44 tags all
# shipped partial or empty asset sets for exactly this reason — the binaries
# were fine, the upload was not.
#
# Every call site is idempotent (`--clobber` overwrites, `release create` is
# guarded by `|| true`), so a retry can never do half-damage.
#
# ponytail: retries on ANY non-zero exit, not just 5xx — gh does not give us a
# machine-readable status, and parsing its stderr for "HTTP 5" is a worse bet
# than burning ~5min on a genuinely broken argument. Narrow it only if a real
# permanent failure starts costing meaningful CI time.
set -uo pipefail

attempts=${GH_RETRY_ATTEMPTS:-5}
base=${GH_RETRY_BASE_SECONDS:-10}

n=0
until "$@"; do
  n=$((n + 1))
  if [ "$n" -ge "$attempts" ]; then
    echo "gh-retry: '$*' still failing after ${attempts} attempts — giving up" >&2
    exit 1
  fi
  # Quadratic backoff: 10s, 40s, 90s, 160s → ~5min of cover, which is roughly
  # how long the outages that sank v0.9.42–44 actually lasted.
  delay=$((n * n * base))
  echo "gh-retry: attempt ${n}/${attempts} failed, sleeping ${delay}s" >&2
  sleep "$delay"
done
