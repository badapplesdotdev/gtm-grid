---
"@gtmgrid/server": patch
---

Fix the agent's "Auto" permission mode erroring on Claude. The composer's `auto`
label was passed straight through as `claude --permission-mode auto`, which is not
a valid Claude CLI value (`default | acceptEdits | bypassPermissions | plan`) — so
selecting Auto could make the Claude turn fail. `auto` now maps to the valid
`default`. (gtmgrid grid tools stay pre-approved via `--allowedTools` regardless,
so this only governs Claude's own non-grid tools.)
