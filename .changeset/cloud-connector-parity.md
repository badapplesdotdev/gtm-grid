---
"@gtmgrid/desktop": patch
---

Fix two cloud credential/connector issues so cloud behaves like local:

- The cloud agent (spawned MCP) only loaded the built-in connectors
  (ai/formatting/formula/github/http), so it reported extension connectors like
  Trigify and Apollo as "not available" — diverging from a local project. The
  cloud agent now loads the SAME JSON-manifest extensions from the global db that
  `openProject` loads locally, so every connector is available to
  `list_functions` / `run_column` in cloud mode (credentials resolve via the
  shared workspace key).
- After saving a shared Cloud connector key, the Cloud tab kept showing "No X
  credentials yet" until app restart because the save path didn't refresh the
  credential listing. It now refreshes immediately, flipping the panel to
  "connected".
