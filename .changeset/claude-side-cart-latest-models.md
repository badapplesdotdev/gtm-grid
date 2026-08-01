---
"@gtmgrid/desktop": patch
---

Side-cart Claude model picker now stays current automatically. It offers the CLI's family aliases (`opus`, `sonnet`, `haiku`, `fable`), which resolve to the latest model in each family at run time, instead of a hardcoded version list that went stale on every release. A new `/api/agent/models/claude` endpoint serves the catalog and labels the configured default from `~/.claude/settings.json`, mirroring the existing Codex discovery flow.
