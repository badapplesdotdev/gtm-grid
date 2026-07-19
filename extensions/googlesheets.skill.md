# Google Sheets — Agent Skill
> Read and write Google Sheets from a column — reach for it when a row needs to be PUSHED into a spreadsheet a human works in, or when a sheet holds reference data the grid should look up.

## When to use
- Use to export enriched rows into a spreadsheet a colleague already lives in — `googlesheets.appendRow`, usually as the last column in a table.
- Use to read reference data a human maintains in a sheet (territory owners, ICP tiers, pricing) — `googlesheets.getValues`, then match in a formula column.
- Use to write a status back into a specific cell of a sheet that drives someone else's workflow — `googlesheets.updateValues`.
- Do NOT use to IMPORT a sheet as a table of rows. A connector runs per-row and cannot create rows. Use the **Import from Google Sheets** flow on the table instead (it binds the sheet and re-syncs).
- Do NOT expect it to find a spreadsheet by name. It can only open files the user explicitly selected — see Auth.

## Auth & cost
- Auth: **OAuth**, not an API key (`auth.type: "oauth"`, `provider: "google"`). There is no key to paste — if a run errors with "not connected" or "authorization expired or was revoked", the fix is to **(re)connect the Google account**, never to edit a key.
- **The credential is SHARED across every Google connector** (`credentialSlot: "google"`). Connecting once from Sheets also connects Docs/Gmail when those ship, and disconnecting from any of them drops all of them.
- **Scope is `drive.file` only.** This is the single most important thing to understand about this connector: GTM Grid **cannot browse the user's Drive** and cannot open a spreadsheet just because it knows its id. Google grants access **per file**, when the user selects it in the Google Picker ("Select spreadsheets" on the connection card). A `spreadsheetId` that was never picked returns **404**, which looks exactly like a deleted file — if a user swears the sheet exists, the answer is almost always "it was never selected".
- Base URL: `https://sheets.googleapis.com/v4`.
- Credits: all calls are 0 credits. The only quota that applies is the user's own Google quota (300 read + 300 write requests per minute per project, 60 per user per minute).
- Rate limits: connector-level `{ rpm: 60, concurrency: 2 }`, chosen to sit under Google's per-user-per-minute ceiling. Over-limit returns HTTP 429; the engine backs off and retries automatically.

## Picker fields (manifest options)
- `appendRow.range` is a live picker backed by `listSheets` (`itemsPath: "sheets"`, label and value both `properties.title`) — choose a **tab** by name. `spreadsheetId` is free text (paste the long id from the sheet's URL), and must be a file the user picked.

## The `values` shape — read this before writing anything
`values` is a **list of ROWS**, not a list of cells. This trips up every first attempt:
- One row of three cells → `[["Acme", "acme.com", "UK"]]`
- One single cell → `[["done"]]`
- Two rows → `[["a"], ["b"]]`

`[ "Acme", "acme.com" ]` is **wrong** and Google will reject it or write it in a shape you did not intend.

## Endpoints by job

### Push a row into a sheet
- `googlesheets.appendRow` — `POST /spreadsheets/{spreadsheetId}/values/{range}:append`. Required `spreadsheetId`, `range`, `values`. `range` only needs the tab name (`Sheet1`) — Google finds the first empty row itself; you do not compute a row number. Optional `valueInputOption` (`USER_ENTERED` default — Google parses numbers, dates and formulas; `RAW` stores verbatim) and `insertDataOption` (`INSERT_ROWS` default). Returns the updated range, e.g. `Sheet1!A5:C5`.
  - Use `RAW` when a value must survive intact — a leading-zero postcode or an ID like `007` becomes `7` under `USER_ENTERED`.

### Read reference data
- `googlesheets.getValues` — `GET /spreadsheets/{spreadsheetId}/values/{range}`. Required `spreadsheetId`, `range` (A1 notation, e.g. `Sheet1!A1:D50`, or `Sheet1!A2:A` for a whole column from row 2 down). Optional `majorDimension` (`ROWS` default, `COLUMNS` to get column-wise), `valueRenderOption` (`FORMATTED_VALUE` default, `UNFORMATTED_VALUE` for raw numbers, `FORMULA` for the formula text). Returns the values array.
  - **Trailing empty cells are omitted.** A row of `["Acme", "", ""]` comes back as `["Acme"]`, so index into rows defensively — `row[2] ?? ""`, never `row[2].trim()`.

### Write to a specific cell or block
- `googlesheets.updateValues` — `PUT /spreadsheets/{spreadsheetId}/values/{range}`. Required `spreadsheetId`, `range`, `values`. **Overwrites** — the range must match the shape of the data. Optional `valueInputOption`.

### Discover tabs
- `googlesheets.listSheets` — `GET /spreadsheets/{spreadsheetId}`. Required `spreadsheetId`. Mostly powers the tab picker; call it directly when you need tab names. Returns `{ sheets: [{ properties: { title, sheetId, … } }] }`.

## Recipes
1. **Export qualified leads to a shared sheet**
   1. Ask the user to connect Google and pick the destination spreadsheet.
   2. Add a `googlesheets.appendRow` column with `{ "spreadsheetId": "<id>", "range": "<picked tab>", "values": [["{{Company}}", "{{Domain}}", "{{Email}}"]] }`.
   3. Gate it with an "only run if" condition so it fires only on qualified rows — appends are not idempotent (see Gotchas).

2. **Look up an owner from a mapping sheet**
   1. `googlesheets.getValues` on `Owners!A2:B` once (a single-cell column, not per row) to pull the whole mapping.
   2. Match `{{Territory}}` against it in a formula column.
   3. Prefer this over one `getValues` per row — 1000 rows would be 1000 API calls against a 60/min budget.

## Gotchas
- **404 on a valid id almost always means "never picked".** Under `drive.file` the file must have been selected in the Picker. Check the connection card's spreadsheet count before debugging anything else.
- **Appends are NOT idempotent.** Re-running a column appends the row again — there is no upsert. Gate append columns with a condition, or accept duplicates.
- **`values` is a list of rows.** See above. The most common cause of a confusing write.
- **Trailing empties are dropped on read.** Rows come back shorter than the range you asked for.
- **`USER_ENTERED` reformats data.** Leading zeros, long numeric ids and anything starting with `=` change meaning. Use `RAW` when fidelity matters.
- **Per-row reads burn quota fast.** 60 requests per user per minute; a full-column `getValues` over a large table will hit 429s and crawl. Read once into a single cell and match locally.
- **Disconnecting Google affects every Google connector**, because they share one grant.
