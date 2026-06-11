---
"@gtmgrid/desktop": patch
---

Add "Use my local key" — one-click copy of a connector/AI provider's local API
key up to the shared Cloud (workspace) key. Shown in each connector's Cloud tab
when a local key exists. Security-first: the sidecar decrypts the local key
in-process and forwards the plaintext to the cloud over TLS authenticated as the
signed-in member; the plaintext never enters the renderer, is never logged, and is
never returned in the response. The cloud save encrypts at rest and is
member-gated (only a workspace member can write the shared key).
