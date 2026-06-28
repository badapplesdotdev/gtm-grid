---
"@gtmgrid/desktop": patch
---

The agent now works with no table loaded, and the native `/goal` + skills are back.

Root cause of the "agent has no GTM Grid tools / falls back to other tools" reports:
the agent's cloud context required an active table, so with nothing open the MCP
failed to start and the agent had zero grid tools. The active table is now optional —
the agent gets its tools as soon as you're signed in with a cloud project, and can
`list_tables` / `create_table` / operate by id. With tools always available we also
re-enabled your Claude/Codex skills (including the looping `/goal`), with a "use only
GTM Grid tools" guardrail.
