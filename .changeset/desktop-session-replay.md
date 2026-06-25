---
"@gtmgrid/desktop": patch
---

Enable PostHog Session Replay in the desktop app. `posthog-js` now initializes
with `session_recording` (inputs masked, displayed grid text captured), so
sessions record once the project's "Record user sessions" toggle is on. The
Tauri webview already permits the recorder (no CSP, absolute `api_host`); add the
`ph-no-capture` class to hide a specific element from replays.
