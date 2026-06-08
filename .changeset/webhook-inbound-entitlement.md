---
"@gtmgrid/services": patch
---

Gate the webhook INBOUND receiver on cloud entitlement (follow-up to the cloud
lock). `WebhookService.resolveToken` now returns `null` for a workspace whose
trial lapsed / is on Free (treated as not-found → the inbound route 404s), so no
external webhook data flows into a locked workspace; `createWebhook` is likewise
gated. Closes the one cloud-write path that bypassed the grid gate (webhook writes
go through `WebhookService`, not `GridService`).
