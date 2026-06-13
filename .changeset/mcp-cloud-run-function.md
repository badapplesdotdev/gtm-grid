---
"@gtmgrid/mcp": patch
---

Enable `run_function` for agents on cloud projects. It previously errored with
"not available on a cloud project" because there was no worker dispatch route;
now the cloud source resolves the workspace's shared connector credentials
through the existing worker `getCredential` path (the same machinery cloud
`run_column` already uses) and dispatches the connector in-process — so cloud
agents can source data (searches, enrichment) exactly as local agents do, with
no new backend route. `upload_extension` remains the only cloud-unsupported
tool. (`get_table`/`describe_column` were already fixed by the #96 full-column
projection; if still seen stripped in prod, redeploy the `apps/web` worker.)
