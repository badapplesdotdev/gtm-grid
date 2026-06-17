---
"@gtmgrid/engine": minor
"@gtmgrid/services": minor
---

Respect third-party API rate limits across all connectors. Every outbound connector call is now paced by a per-connector throttle (requests/second + max in-flight) at the engine's dispatch choke point, with researched limits baked into all bundled extensions and a conservative safety default (2 req/s, 2 concurrent) for any connector that declares none — so a large run can no longer fire an unbounded burst at a provider. Pure-local connectors (formatting/formula) are exempt.

Transient failures (429/503/5xx and network blips) now retry with capped exponential backoff + jitter, honouring `Retry-After`: the manifest connector routes through the shared `fetchWithRetry`, the AI connector uses the vendor SDKs' own retry (maxRetries + timeout), and the cloud Trigify signal sync retries transient failures via an Effect schedule.
