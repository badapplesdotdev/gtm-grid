---
"@gtmgrid/server": patch
"@gtmgrid/mcp": patch
---

Large agent-triggered column runs (>50 pending rows, after the user
confirms) now start in the background on the persistent sidecar instead of
running inside the agent turn — a run of hundreds of rows previously hit
the 5-minute turn limit and was killed mid-way. The agent gets
{started:true} immediately and polls progress; limit-scoped runs forward
their row scope so a "run the next N" stays bounded.
