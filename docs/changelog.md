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
