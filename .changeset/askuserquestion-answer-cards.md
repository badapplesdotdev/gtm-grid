---
"@gtmgrid/desktop": patch
"@gtmgrid/server": patch
"@gtmgrid/mcp": patch
---

Add AskUserQuestion answer cards to the Agent panel for all providers.

When an agent needs the user to choose between options (which AI model, cohort
size, ambiguous intent), it can now pose a structured multiple-choice question
and the bottom of the chat replaces the composer with selectable answer cards —
pick with a click or hotkeys `1,2,3,4`, or choose "Other" to type a custom
answer. Works across all three CLI providers (Claude / Codex / Hermes), reusing
the existing permission-gate pattern.

- **mcp**: new `ask_user_question` tool returning a non-blocking questions payload.
- **server**: `questionEventFromToolResult` converts the payload into an `ask_user`
  SSE event, wired into the Claude, Codex, and Hermes bridges. Claude's *native*
  `AskUserQuestion` tool_use is intercepted directly (headless `-p` stubs the result
  and ends the turn), and HITL payloads are detected against the untruncated Hermes
  tool-result text so a larger question payload can't be clipped.
- **desktop**: an `AskCards` component (step-through, hotkeys, multiSelect, "Other"
  free-text) replaces the composer while a question is pending; the answer resumes
  the session.
