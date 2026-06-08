---
"@gtmgrid/desktop": patch
---

Agent panel now shows past conversations again — read from each CLI's own native
transcript store (Claude Code project sessions, Codex rollouts for the current
project) instead of a local copy. Opening one loads its messages and resumes the
CLI's native session for full context. Replaces the previous localStorage history.
