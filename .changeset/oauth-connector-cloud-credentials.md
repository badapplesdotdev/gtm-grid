---
"@gtmgrid/server": minor
"@gtmgrid/engine": minor
"@gtmgrid/desktop": patch
---

Cloud connector credentials now resolve everywhere the UI claims they do, and a
connector method can name the single value its cell should display.

**Option pickers on a cloud project resolved no credential.** `/api/options`
dispatched through the sidecar's own engine, whose credentials port reads local
SQLite — but a cloud workspace's connector credential lives in Postgres. Every
live dropdown therefore reported the connector "not connected" while the Tools
panel, reading cloud state, said Connected. Invisible for connectors that also
accept a pasted key; total for an OAuth-only one like Slack, where the channel
picker stayed permanently empty on a connection that worked. The route is now
cloud-aware, mirroring the existing cloud preview path.

**A connector method can declare `result`**, a dot-path naming the one value to
store (`"ts"`, `"user.id"`). A cell renders a scalar, so a method returning a
whole response object — `chat.postMessage` returns `{ok, channel, ts, message}` —
wrote a `done` cell that displayed as EMPTY: the message really was posted and
the user saw nothing, indistinguishable from "it never ran". Optional and
fail-soft: an unresolvable path returns the raw response, so the 854 existing
REST methods are unchanged.

**Connecting an OAuth account refreshes the credential list.** An OAuth connect
is written server-side by the callback, so nothing in the renderer knew the list
had changed; the connect card flipped to Connected (it polls a different query)
while the Tools panel kept the method list locked behind "Connect your API key"
and the column editor warned "runs will fail" — until an app restart.

Also: the Tools panel no longer offers an api-key form for an OAuth connector.
Saving one wrote `{apiKey}` over the same credential row the OAuth grant lives
in, destroying the access token, the single-use refresh token and the team
metadata — unrecoverable under rotation except by reconnecting.
