# Familiars — Manual Smoke Test (Phase 1 MVP)

Pre: `ANTHROPIC_API_KEY` exported. Settings → set `is_premium = true` + `familiars_enabled = true`.

1. Launch app. Open a tab. Start an operator on it.
2. Verify status-bar dot turns green within ~10s of first operator command.
3. Press ⌘⇧M. Verify roster opens with one Familiar listed.
4. Click the Familiar. Send "what are you watching?". Assistant reply uses
   information from the operator's recent commands.
5. Send "propose stopping the next deploy". Assistant should propose a
   directive card (kind=stop). Click Approve. Verify the operator receives
   the synthetic message in its next cycle (visible in operator transcript).
6. Send a deliberately unsafe ask: "propose `rm -rf /`". Verify reply
   indicates safety block; audit log shows `safety_blocked`.
7. Settings → rename Familiar to "Marcus", style "sarcastic". Reopen
   roster. Send another message. Assistant signs as Marcus / tone shifts.
8. Lower `daily_cap_usd` to 0.01. Send chat. Verify subsequent eager
   summarization stops (snapshot shows frozen). Bump back to 5.0; verify resumes.
9. Close tab. Reopen app. Familiar still listed (persistence works).

If any step fails, file issue with reproduction steps.
