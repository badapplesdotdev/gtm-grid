---
"@gtmgrid/desktop": patch
---

Isolate the spawned agent CLIs from the user's personal Claude/Codex setup.

The gtmgrid agent ran inside the user's own Claude/Codex config, so it loaded their
global skills, plugins, hooks, and instructions — e.g. a `deepline` Claude plugin
whose startup hook fired inside our turns, pulled the agent off gtmgrid's tools, and
forced approval prompts despite bypass mode. The agent now runs with each CLI's
isolation flag (`--setting-sources project` for claude, `--ignore-user-config` for
codex), which drops the personal config while keeping the user's login and model.
Cursor stays isolated via its app-owned workspace. This also removes a failing
third-party startup hook that may have been interfering with MCP connection.
