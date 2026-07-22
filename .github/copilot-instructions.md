<!-- canon:start -->
# Canon context (auto-generated — do not edit inside this block)

## Memory

- The dev build is a different macOS app than the installed one — separate identifier, separate config, starts unconfigured.
- A 403 from the `gh` CLI on this repo is almost always the wrong active account, not a missing permission.
- A component input that looks right in dark and white-on-white in light is losing to `body.theme-light input`, which is more specific than the component rule.
- CI must cache the cargo registry but never target/ — a Cargo.lock-keyed target cache always misses and hangs the release ~25 minutes on upload.
- In a linked worktree, `git add -A` stages the node_modules symlink and clobbers main's dependencies.
- Two release steps are continue-on-error — a missing HOMEBREW_TAP_TOKEN skips the cask update, and missing SSLCOM_* secrets ship Windows unsigned. Both leave a green build.
- `npm run tauri:dev` failing with exit code 101 usually means target/debug/incremental has grown past 100GB and filled the disk.
<!-- canon:end -->
