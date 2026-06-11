---
"@gtmgrid/desktop": patch
---

Fix cloud Trigify signal tables staying empty, end to end:

- The prod Inngest app sync was rejected ("A concurrency key must be specified
  for Account scoped limits"), leaving every background function — including the
  hourly signal poll — unregistered. Account-scoped concurrency caps now carry
  the required key, so the cron actually runs.
- A fresh Trigify search takes ~10–30s to return results, but the create-time
  pull stamped the binding as synced, deferring the next pull by the full
  schedule (a daily binding sat empty for 24h). A new durable warm-up retries
  the pull until first data lands (~15–60s, like local), and still-empty
  bindings stay due for the hourly cron as a safety net.
- The cloud grid now shows a signal status strip (waiting / rows pulled / last
  synced / errors) with a "Sync now" button — previously an empty signal table
  gave no visibility or recourse.
