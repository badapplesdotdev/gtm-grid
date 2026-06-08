# Reoon — Agent Skill
> Email verification: confirm an address is real and deliverable before you send or hand it to a sequencer. Reoon's "power" mode does true SMTP/inbox checks, making it the most accurate single-purpose validator in the grid.

## When to use
- Validating a single email's deliverability per row (e.g. a column that verifies `{{Email}}` before outreach).
- Verifying large lists (hundreds to 50,000) — use the async bulk task, not one call per row.
- Filtering out disposable, role-based (`info@`, `sales@`), catch-all, or spamtrap addresses.
- NOT for *finding* an email from a name/company — Reoon only verifies an address you already have. Use LeadMagic `emailFinder` for discovery, then verify the result here.

## Auth & cost
- Auth: API key passed as the `key` query param on every request (the grid injects it from the `apiKey` secret). No header.
- Base URL: `https://emailverifier.reoon.com/api/v1`
- Cost: 1 credit per single `verify`. Bulk consumes credits per email processed (power-mode rate). `getBulkResult` and `accountBalance` are free.
- Two credit pools: `remaining_daily_credits` (reset daily) and `remaining_instant_credits` (purchased, no reset). Check `accountBalance` before large bulk jobs.

## Endpoints by job

### Verify one email
- `reoon.verify` — verify a single address. Inputs: `email` (required), `mode` (`quick` | `power`, default `quick`). `quick` = ~0.5s syntax/MX/disposable. `power` = deep SMTP + inbox + catch-all (slower, accurate). Returns `status` (`valid`/`invalid`/`disabled`/`unknown`/`catch_all`/`spamtrap`), `is_safe_to_send`, `is_deliverable`, `overall_score`, `is_disposable`, `is_role_account`, `is_free_email`, `is_catch_all`, `mx_accepts_mail`, `can_connect_smtp`.

### Verify a list (async)
- `reoon.createBulkTask` — submit up to 50,000 emails for batch verification. Inputs: `emails` (required array), `name` (optional, ≤25 chars). Duplicates removed automatically. Returns `task_id` (save it), plus `count_submitted`, `count_duplicates_removed`, `count_rejected_emails`, `count_processing`. Runs in power mode.
- `reoon.getBulkResult` — poll a bulk task. Input: `task_id` (required). Returns `status` (`running` → `completed`), `progress_percentage`, `count_checked`/`count_total`, and `results` (object keyed by email with per-address verification fields). Free to call.

### Account
- `reoon.accountBalance` — remaining credits. No inputs. Returns `remaining_daily_credits`, `remaining_instant_credits`, `api_status`, `status`. Free.

## Recipes

1. **Verify a single email column (accurate)**
   1. `reoon.verify` with `{ "email": "{{Email}}", "mode": "power" }`
   2. Keep the row if `is_safe_to_send` is true (or `status` == `valid`); drop/flag `invalid`, `disabled`, `spamtrap`.

2. **Fast pre-filter then deep-verify**
   1. `reoon.verify` with `{ "email": "{{Email}}", "mode": "quick" }` to cheaply drop syntax/disposable junk.
   2. Re-run `reoon.verify` with `mode: "power"` only on rows that passed, to confirm true deliverability.

3. **Find then verify (cross-tool)**
   1. LeadMagic `emailFinder` with the person's name + company to get an email.
   2. `reoon.verify` with `{ "email": "{{Found Email}}", "mode": "power" }` to confirm it lands before sequencing.

4. **Bulk-verify a whole list**
   1. `reoon.createBulkTask` with `{ "emails": [ ...up to 50k... ], "name": "list-q2" }`; store the returned `task_id`.
   2. `reoon.getBulkResult` with `{ "task_id": "{{Task Id}}" }`; repeat until `status` == `completed`, then read per-email `results`.

## Gotchas
- `verify` is GET with everything in the query string — `email` and `mode` are query params, not a JSON body.
- Trailing slashes matter: bulk/balance paths end in `/` (`/create-bulk-verification-task/`, `/get-result-bulk-verification-task/`, `/check-account-balance/`). `verify` has no trailing slash.
- Bulk is asynchronous: `createBulkTask` returns immediately with a `task_id`; you must poll `getBulkResult` — it is NOT done on creation. Check `progress_percentage`/`status` before reading `results`.
- `is_catch_all` / `status: catch_all` means the domain accepts all mail — deliverability is unconfirmable; treat as risky, not valid.
- `quick` mode does NOT do SMTP/inbox checks, so it can't tell `valid` from `catch_all` or confirm a mailbox exists — use `power` when you actually need deliverability.
- Bulk runs at the power-mode credit rate per email; a 50k list is a large credit spend — call `accountBalance` first.
- `task_id` is returned by `createBulkTask`; don't invent it. A bad/expired `task_id` returns an error inside a 200-style JSON body, so check `status`/error fields rather than assuming HTTP success means data.

## Source
Official API docs: https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/
