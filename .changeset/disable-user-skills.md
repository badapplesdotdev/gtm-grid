---
"@gtmgrid/desktop": patch
---

Fully disable the user's personal Claude skills in the agent (follow-up to the
isolation fix). `--setting-sources project` alone only thinned the user's skills, so
a third-party skill (e.g. `deepline-gtm`) was still invokable and kept running
instead of gtmgrid's tools. Add `--disable-slash-commands`, which disables all of the
user's skills; gtmgrid's own playbooks (injected via the system prompt) and tools
(via MCP) are unaffected, and the user's login is preserved.
