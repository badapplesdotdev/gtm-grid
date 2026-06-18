---
"@gtmgrid/services": patch
"@gtmgrid/web": patch
---

Fix webhook-triggered enrichment hard-failing on any extension connector. The Inngest worker's `runEnrichColumn` built the engine with a bare `defaultRegistry()`, which only registers the built-ins (ai/formatting/formula/github/http-request) and never loads the workspace's uploaded connector manifests. So a function column wired to `leadmagic.emailFinder` (or any non-built-in connector — Trigify, etc.) found no `sdk.<provider>` in the sandbox prelude and dereferenced `undefined`, surfacing as `cannot read property 'emailFinder' of undefined`. The worker now fetches the workspace's manifests through a new secret-gated `/api/worker/listExtensions` endpoint (`WebhookService.listExtensionManifests`, same member/headless trust model as `getCredential`) and builds an extension-aware registry, mirroring the local `openProject` / MCP `registryWithExtensions` loader. Malformed manifests are skipped best-effort so one bad connector can't break a run.
