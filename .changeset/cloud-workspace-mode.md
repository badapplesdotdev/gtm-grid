---
"@gtmgrid/desktop": patch
---

A signed-in cloud workspace now always operates in cloud mode — it never falls
back to the local engine (which silently saved tables to disk instead of the
cloud). When the active cloud workspace has no cloud project yet, the app
auto-creates a default cloud project so `inCloud` is true: the local-tables
section + local "New table" stay hidden and all tables go to the cloud. Skipped
when the workspace's cloud access is locked (lapsed trial).
