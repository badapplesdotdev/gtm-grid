---
"@gtmgrid/cloud": patch
"@gtmgrid/services": patch
---

Fix the plan upgrade/checkout from a trial. Autumn `attach` now forces hosted
Stripe Checkout (`redirectMode: "always"`) so upgrading a customer with no card on
file (e.g. on a no-card trial) opens checkout to collect payment instead of
failing with a Stripe "no payment source" 400. And selecting the plan you're
already trialing (e.g. Team → Team) now uses `setupPayment` (add a card, convert
the trial to paid) instead of re-attaching the same plan, which Autumn rejects
with a 409 `plan_already_attached`.
