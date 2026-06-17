# Granola — Agent Skill
> Pull your own Granola AI meeting notes, summaries, transcripts, and folders into the grid — reach for it when a column needs the content of a meeting you recorded.

## When to use
- Use to enrich rows that reference a meeting/call you took in Granola: pull the AI summary, full transcript, attendees, or calendar event.
- Use to list recent meetings (by date or folder) and feed their ids into downstream columns.
- Do NOT use to find external people/companies or verify emails — this is your own meeting data only (see leadmagic for enrichment).
- Do NOT expect notes that are still processing or were never summarized — the API only returns notes that have a generated AI summary.

## Auth & cost
- Auth: `Authorization: Bearer grn_...` (header `Authorization`, secret `apiKey`). Requires a Business-plan / personal API key created in Granola Settings → API.
- Base URL: `https://public-api.granola.ai/v1`.
- Credits: all calls are 0 credits (read-only against your own workspace).
- Rate limits: ~5 req/sec sustained (300/min), burst 25 req per 5s window. Over-limit returns HTTP 429 — back off and retry. The manifest sets a connector-level `rateLimit` of `{ rpm: 300, rps: 5, concurrency: 3 }` to keep column fan-out under the documented ceiling.

## Picker fields (manifest options)
- `listNotes.folder_id` is a live picker backed by `listFolders` (`itemsPath: "folders"`, label `name`, value `id`) — choose a folder by name and the grid stores the `fol_...` id. This is the only selectable resource on the connector; everything else is a free-text note id (`not_...`) or ISO date.

## Endpoints by job

### List / find meetings
- `granola.listNotes` — lists notes that have an AI summary, with pagination. Inputs (all optional): `created_after`, `created_before`, `updated_after` (ISO 8601), `folder_id` (scopes to a folder + its children), `page_size` (1-30, default 10), `cursor`. Returns `{ notes: [{ id, object, title, owner, created_at, updated_at }], hasMore, cursor }`. Note ids look like `not_...`.

### Read one meeting's content
- `granola.getNote` — full detail for one note. Required input `note_id` (`not_...`); optional `include='transcript'` to attach the transcript. Returns `{ id, title, owner, created_at, updated_at, web_url, calendar_event, attendees, folder_membership, summary_text, summary_markdown, transcript }`. Summary fields come back without `include`; the transcript only comes back when you pass `include=transcript`.

### Organize by folder
- `granola.listFolders` — lists accessible folders alphabetically, with pagination. Inputs (optional): `page_size` (1-30, default 10), `cursor`. Returns `{ folders: [{ id, object, name, parent_folder_id }], hasMore, cursor }`. Folder ids look like `fol_...`; feed one into `granola.listNotes` `folder_id`.

## Recipes
1. **Get a meeting's summary text for a row that already has the note id**
   1. call `granola.getNote` with `{ "note_id": "{{Note ID}}" }`; read `summary_markdown` (or `summary_text`).
2. **Get the full transcript of a meeting**
   1. call `granola.getNote` with `{ "note_id": "{{Note ID}}", "include": "transcript" }`; read `transcript`.
3. **Find the most recent meeting and pull its summary**
   1. call `granola.listNotes` with `{ "created_after": "{{Since Date}}", "page_size": 30 }`; take `notes[0].id`.
   2. feed that id into `granola.getNote` with `{ "note_id": <id from step 1> }`; read `summary_markdown` and `attendees`.
4. **Pull only meetings from one team folder**
   1. call `granola.listFolders` and find the folder whose `name` matches `{{Folder Name}}`; take its `id`.
   2. call `granola.listNotes` with `{ "folder_id": <id from step 1>, "page_size": 30 }` to list that folder's notes.

## Gotchas
- Pagination: responses return `hasMore` + `cursor`. To get everything, loop calling the same endpoint with the previous `cursor` until `hasMore` is false. `page_size` maxes at 30.
- `getNote` requires the param name `note_id` (not `id`), and the path is `/notes/{note_id}`.
- Transcript is opt-in: without `include=transcript` you get summary fields but no `transcript`. Don't assume it's there.
- Summary-only data: notes still processing or never summarized never appear in `listNotes` and can't be fetched — a missing note usually means "no summary yet," not an error.
- Id formats are prefixed strings, not UUIDs: notes `not_...`, folders `fol_...`. Pass them through verbatim.
- Date filters expect ISO 8601 (e.g. `2026-06-01` or `2026-06-01T00:00:00Z`).
- 429 on burst: the limit is low (~5/s). When fanning a column across many rows, expect throttling and rely on retry/backoff.
