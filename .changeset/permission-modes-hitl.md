---
"@gtmgrid/mcp": patch
"@gtmgrid/server": patch
"@gtmgrid/desktop": patch
---

Make the 4 agent permission modes real and add enforced human-in-the-loop (HITL)
approval, uniformly across all three providers (claude/codex/hermes).

- **Modes are enforced at the MCP tool gate** (the one layer all providers share),
  driven by a per-tool risk class: `bypass` runs everything; `auto` asks for
  destructive ops and large/expensive runs; `acceptEdits` asks for every delete
  and every credit spend; `plan` blocks all mutations (reads still run). The
  composer mode is threaded to the MCP via env (`GTMGRID_PERMISSION_MODE`).
- **Enforced approval (no model self-confirm):** a gated tool returns
  `confirmationRequired` and does NOT execute; it can only be unlocked by a HUMAN
  approval delivered through the MCP env (`GTMGRID_APPROVED_TOOL`/`_ARGS_HASH`) — a
  channel the model can't reach. The approval is hash-bound to the exact action
  the user saw and single-use, so the model setting `confirm:true` itself never
  bypasses a gate.
- **HITL chat UX:** a new `permission_request` SSE event (emitted by all three
  bridges) drives an Approve/Deny card showing the action, affected count, credit
  estimate, and mode; Approve resends the turn carrying the approval. Plan mode is
  now actually enforced, not just suggested.
- Default mode is now **Auto** (was bypass) so destructive ops and spends ask for a
  one-click approval out of the box. Claude's invalid `auto` flag is mapped to
  `default`.
