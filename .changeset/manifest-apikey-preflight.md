---
"@gtmgrid/engine": patch
---

apiKey connectors now fail fast with a clear message when the key is missing or invalid.

Previously, running a connector with no credential resolved no Authorization header,
so the request went out unauthenticated and the upstream's cryptic body (e.g.
FindyMail's `HTTP 401: Unauthenticated`) was re-thrown verbatim with no hint at the
real fix. `httpCall` now pre-flights apiKey auth: a missing secret throws
"<Connector> API key not configured — connect a <Connector> credential…" before any
request fires, and a 401 from a configured-but-invalid key is mapped to
"<Connector> API key invalid or expired (HTTP 401) — check the credential…". Applies
to every apiKey-based connector, not just FindyMail.
