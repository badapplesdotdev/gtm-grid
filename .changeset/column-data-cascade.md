---
"@gtmgrid/desktop": minor
---

feat(grid): column data cascade — running a column or cell now automatically runs every column that depends on it (via `{{Column}}` references), in dependency order, for the affected rows. A chain like *Get API data → map a field in a sibling → compute a value in the next sibling* populates end-to-end from a single run, and independent siblings run in parallel. `Run all` / `Run selected rows` now execute in dependency order instead of authored order. Server-side enrichment matches: webhook-delivered and Signal-pulled rows are enriched in dependency order (Signal rows were previously not enriched at all).

fix(engine): server-side enrichment could throw "cannot read property …" for any column that calls a connector (e.g. an email finder). A connector column runs `sdk[provider][method](...)` in the sandbox, but the cloud worker built its engine with only the built-in connectors. It now loads the workspace's installed connector manifests, so connector columns enrich correctly in webhook/Signal runs.
