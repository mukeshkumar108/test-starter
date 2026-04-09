# Changelog

## 2026-04-09

- Raised the default active session window from 5 minutes to 30 minutes.
- Aligned the stale-session sweeper default inactivity threshold with the active session window.
- Added a dedicated `CURRENT_SESSION_TRUTHS` prompt block for:
  - current scene state
  - recent user corrections
  - "today vs yesterday" distinctions
- Wired stored correction/session-truth state into prompt assembly so it actually reaches the model.
- Updated current human and agent docs to reflect the new continuity model and the recommended QStash sweeper URL:
  - `/api/admin/run-session-sweeper?inactivityMinutes=30&limit=100`
- Replaced free-text session truths with a structured `CURRENT_SESSION_STATE` block.
- Added slot overwrite rules for current-scene and meal facts so newer literal user updates replace older values.
- Moved `CURRENT_SESSION_STATE` late in the prompt stack so it outranks bridge/handover more reliably.
- Tightened literal-mode generation instructions to prefer concrete low-inference wording.
- Added a lightweight literal-mode reply checker/repair layer that:
  - anchors the first sentence to the latest literal user update
  - blocks scene advancement beyond user evidence
  - blocks resurfacing overwritten facts like stale meal details
- Added targeted replay-style tests for:
  - `I'm finally outside.`
  - `I'm home now.`
