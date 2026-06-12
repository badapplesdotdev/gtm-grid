---
"@gtmgrid/engine": patch
"@gtmgrid/desktop": patch
---

Async-job connectors (e.g. Firecrawl extract) now block-poll until the job
completes — with a wall-clock timeout and typed fail states — instead of
returning a job id the grid can't use. Cells whose value carries an `error`
field render an honest red error pill (with the real status code when one
exists) instead of a fabricated "Status Code: 200".
