---
"@gtmgrid/engine": patch
---

fix(engine): don't charge host `sdk` wait time against a column's compute budget

The sandbox deadline now advances across every host dispatch, so only a column's own
CPU time counts toward the limit. Any enrichment slower than 30s no longer fails with
"sandbox: interrupted", and the timeout message now names the column and the limit.
