---
description: Verify a merged change in the running dev build and report what was actually observed.
---

# verify-live

Confirm the change named in `$ARGUMENTS` is live and correct in the dev build.

1. `npm run tauri:dev` if it is not already running. Remember: the dev build is
   `com.karluiz.covenant.dev` with its own config — unseeded by design.
2. Exercise the exact surface the change touched. Screenshot UI changes.
3. Report **observed behavior only**. "Should work" is not verification. If it
   could not be reached, say which step blocked it.

Do not fix anything you find. Report, then wait.
