---
"@gtmgrid/engine": minor
---

fix(webhook): make bundled connectors available to cloud auto-enrichment

When a row arrived via webhook, auto-running its function columns in the cloud
(Inngest) worker failed for any column using a bundled connector (Trigify,
LeadMagic, Apollo, etc.) with a sandbox error — so enrichment only worked if the
user triggered the run manually from the desktop.

Root cause: the cloud worker built its connector registry from the built-ins plus
the workspace's installed extensions only, and nothing seeds the app's bundled
connectors cloud-side. The desktop sidecar registers them from disk at startup,
but the serverless worker has no `extensions/` directory — so `sdk[provider]` was
undefined in the sandbox and the run threw "cannot read property <method>".

The engine now exposes `bundledConnectors()`, built from the shipped
`extensions/*.json` manifests (inlined via a generated module so they are
available with no disk access). The webhook worker layers these into its
per-workspace registry, so bundled connectors run in cloud auto-enrichment
exactly as they do on the desktop — even when the extensions endpoint returns
nothing or fails.
