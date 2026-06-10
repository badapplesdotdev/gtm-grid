---
"@gtmgrid/desktop": patch
"@gtmgrid/engine": patch
---

Simplify integration credential scopes to **Local** and **Cloud**. The connector
and AI-provider panels previously showed up to four confusing tabs (Workspace,
Personal, Team, Local) where three of them all saved to the same machine. They now
show just two:

- **Local** — the key is stored on this machine only.
- **Cloud** — the key is encrypted server-side and **shared with the whole team**
  (everyone in the workspace uses it). Shown only when signed into a cloud workspace.

Pushing a local table to the cloud no longer fails when an integration is connected
only locally: credentials are never synced, so a cloud run resolves the team's
shared Cloud key (or surfaces a connect-integration error at run time if none is
set). This also fixes the case where having both a local and a Cloud key wrongly
blocked the push.
