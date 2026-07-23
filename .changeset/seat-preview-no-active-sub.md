---
"@gtmgrid/services": patch
"@gtmgrid/cloud": patch
---

Fix the seat-price preview crashing when a workspace has no active subscription.

`BillingService.previewSeatChange` priced against the workspace's cached
`currentPlanId` (defaulting to Team) and asked Autumn `previewUpdate` for the
new bill. That call requires an already-active subscription for the plan, so a
workspace whose cached plan no longer matches a live subscription (expired
trial, cancelled plan, or a stale cache) hit a `cus_product_not_found` 404 that
surfaced as an unhandled error and blocked the add-a-seat / invite-member flow.

The preview now reconciles against the customer's real active Autumn
subscription before pricing: it previews the seat-quantity change on the live
subscription when one exists, and otherwise falls back to a fresh-attach
estimate on the Team plan (which needs no existing subscription) instead of
letting the Autumn 404 escape.
