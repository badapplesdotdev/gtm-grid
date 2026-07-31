# Google Sheets

Two capabilities, one Google connection:

1. **The `googlesheets` connector** — read and write sheets from a column (`sdk.googlesheets.*`).
2. **Sheet import** — bind a spreadsheet tab to a table and pull its rows in on a schedule.

They share one OAuth grant. Connecting once from either enables both.

---

## The one thing to understand: `drive.file`

GTM Grid requests the **`drive.file`** scope and nothing broader. Under that scope:

- The app **cannot browse the user's Drive**.
- The app **cannot open a spreadsheet just because it knows the id**.
- Access is granted **per file**, at the moment the user selects it in the **Google Picker**.

This is a deliberate trade, and it is the reason the product works the way it does.

| | `drive.file` (chosen) | `spreadsheets` + `drive.readonly` |
|---|---|---|
| Google verification review | **Not required** | Required, multi-week |
| Annual CASA security assessment (>100 users) | **Not required** | Required, paid |
| Can list a user's spreadsheets | No — Picker only | Yes |
| Ships today | **Yes** | No |

`openid` and `email` are also requested, purely so the UI can name *which* Google account is connected. Both are non-sensitive and neither triggers a review. Users routinely have a personal and a work account signed in at once; a card reading "Connected to Google" with no address gives them no way to notice they authorised the wrong one.

**Consequence you will hit in support:** a `spreadsheetId` that was never picked returns **404**, which is indistinguishable from a deleted file. If a user insists the sheet exists, it was almost certainly never selected. Check the spreadsheet count on the connection card before debugging anything else.

---

## Operator setup

In [console.cloud.google.com](https://console.cloud.google.com):

1. **Create a project** (or reuse one).
2. **Enable two APIs** — *Google Sheets API* **and** *Google Picker API*. Missing the Picker API is the most common misconfiguration: connecting works, then the picker fails with an opaque error from inside Google's own JS.
3. **APIs & Services → Credentials → Create OAuth client ID**, type **Web application**:
   - Authorised redirect URI: `<SITE_URL>/api/oauth/google/callback`
   - Authorised JavaScript origin: `<SITE_URL>` (the Picker checks this)
   - `http://localhost:3000` is accepted, so local testing needs no tunnel — unlike Slack.
4. **Create an API key** for the Picker, restricted to the Picker API.
5. **OAuth consent screen** → add scopes `drive.file`, `openid`, `email`. All three are non-sensitive, so the app stays in the "needs no review" tier.

Then set:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_SECRET=      # optional, falls back to BETTER_AUTH_SECRET
GOOGLE_PICKER_API_KEY=
GOOGLE_PICKER_APP_ID=     # the project NUMBER, not the project id
```

Leaving `GOOGLE_CLIENT_ID` unset is a **supported** state: the Tools panel shows a disabled Connect button and says Google isn't set up, rather than opening a broken consent screen.

---

## How the connection works

```
Desktop                  apps/web                     Google
   │                        │                            │
   │ google.authorizeUrl ──►│  requireMember, mint state │
   │◄────────── url ────────│                            │
   │ openExternal ─────────────────────────────────────► │ consent
   │                        │◄──── /callback?code&state ─│
   │                        │  verify state (no session!)│
   │                        │  exchange code, fetch email│
   │                        │  save at slot "google"     │
   │◄──── gtmgrid://open ───│                            │
   │ poll connectionStatus  │                            │
```

**No browser session is required at the callback.** The desktop opens consent with `openExternal`, so the system browser carries no `gtmgrid.dev` cookie. The **signed state is the entire trust boundary** — it is minted only after `requireMember`, is HMAC-signed, carries the provider id, and expires in 15 minutes.

Picking files is a **separate, repeatable** step (`/google/picker`, opened the same way, authenticated by the same signed-state mechanism). Keeping it apart from consent is what lets a user add spreadsheets months later without re-running the OAuth flow.

### Token refresh

Google access tokens live one hour. Refresh happens in exactly one place — `/api/worker/getCredential` — via the `OAUTH_SLOTS` registry, server-side, before any plaintext leaves the box. The engine never holds a client secret.

Google refresh tokens are **reusable**, so the policy is `Proactive` and needs no advisory lock (unlike Slack, whose single-use rotating tokens require serialised refresh).

**The refresh merge preserves the picked-file list.** Dropping it would leave a valid token attached to a connection that can reach nothing — silently, every hour.

---

## Sheet import

A binding maps a spreadsheet tab to a table and syncs on a schedule (`manual` / `hourly` / `daily` / `weekly`).

**Why this isn't a connector:** connector methods run once per row and can only write into the row they were called for. Nothing in that model can *create* rows. So import is modelled on CRM sync instead — a binding, an identity map, a schedule, a pause reason.

### Row identity — choose a key column

| Mode | Identity | Behaviour |
|---|---|---|
| **Key column set** (recommended) | That column's value | Stable across sorts, deletions and insertions |
| No key column | The sheet **row number** | Correct only for append-only sheets |

Without a key, deleting a row upstream shifts every row below it, and the next sync rewrites the wrong grid rows. That is inherent to "no identity", not a bug we can fix — which is why the UI pushes toward choosing a key.

### Guarantees

- **Rows are never deleted.** A row removed from the spreadsheet keeps its grid row and any enrichment on it.
- **Unchanged rows cost nothing.** A values hash short-circuits the cell writes, so a daily sync of a static 1000-row sheet is one read and zero writes.
- **Imports never write back.** The binding is pull-only. Use the `googlesheets` connector if a column should write to a sheet.
- **Bounded at `MAX_ROWS_PER_SYNC` (5000).** Exceeding it is logged and surfaced on the binding — never silent.

### Pause reasons

A binding pauses when it needs a human, and the cron then skips it (excluded in SQL, so it isn't re-attempted hourly forever):

| Reason | Cause | Fix |
|---|---|---|
| `auth_revoked` | Grant revoked or expired beyond refresh | Reconnect Google |
| `file_gone` | 404 — deleted, **or never picked** | Re-select the file in the Picker |
| `sheet_gone` | The tab no longer exists | Re-import against a different tab |

Transient failures (429, 5xx, network) do **not** pause — they retry.

---

## Local development

```bash
docker compose up -d
pnpm -F @gtmgrid/db db:migrate      # creates sheet_bindings + sheet_synced_rows
pnpm -F @gtmgrid/web dev            # :3000
pnpm desktop                        # :5173
```

Set `SITE_URL=http://localhost:3000` and register that origin + `http://localhost:3000/api/oauth/google/callback` on the OAuth client.

---

## Gotchas

- **`values` is a list of ROWS.** One row is `[["a","b"]]`, one cell is `[["x"]]`. The most common cause of a confusing write.
- **Trailing empty cells are omitted on read.** Rows come back shorter than the range requested; index defensively.
- **`USER_ENTERED` reformats data.** Leading zeros and long numeric ids lose fidelity; use `RAW` when that matters.
- **Appends are not idempotent.** Re-running an append column appends again. Gate it with a condition.
- **Per-row reads burn quota.** 60 requests/user/minute. Read a mapping sheet once into a single cell rather than once per row.
- **Disconnecting Google affects every Google connector**, because they share one grant.
