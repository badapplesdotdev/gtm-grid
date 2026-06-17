# Attio — Agent Skill
> Read and write your Attio CRM — query, create, assert (upsert) and update people / company / deal / custom-object records, manage lists & list entries, attributes, notes, tasks, comments and webhooks via the Attio v2 REST API. The right tool when a grid needs to push enriched data into the CRM or pull existing CRM context back into a column.

## When to use
- Use to **look up** CRM records (companies by domain, people by email, deals by stage) and pull their attribute values into a grid column.
- Use to **write back** the results of enrichment/research — assert a company by domain, add a person to a list, drop a note or task on a record, set a deal stage.
- Use to read or configure CRM **structure**: list objects, discover attribute slugs, manage select options / statuses, create lists, manage webhooks.
- Do NOT use it to *find* emails, enrich profiles, or fetch social/meeting data — that's LeadMagic / Trigify / Fireflies. Attio only knows what's already in your workspace. Attio is the destination/source of record, not an enrichment provider.

## Auth & cost
- **Base URL:** `https://api.attio.com`. All endpoints are under `/v2/...`.
- **Auth:** `Authorization: Bearer <apiKey>` — the manifest sends the `apiKey` secret in the `Authorization` header (the `Bearer ` scheme is part of the header value). Generate an API key (or OAuth token) at Workspace Settings → Developers → API keys.
- **Scopes:** access tokens carry granular scopes — typically `record_permission:read/read-write`, `object_configuration:read/read-write`, `list_entry:read-write`, `list_configuration:read-write`, `note:read-write`, `task:read-write`, `comment:read-write`, `webhook:read-write`, `user_management:read`. A `403` usually means the token is missing a scope, not a bad key. Call `attio.identifySelf` to see the token's `scope` string and workspace.
- **Cost convention (grid credits, not Attio billing):** reads = 0, writes = 1. Attio's own API has no per-call charge; it is **rate limited** (100 req/s reads, 25 req/s writes; the query endpoints add a score-based sliding-window limit) — batch and back off on `429` (honour `Retry-After`). See "Picker fields & rate limit" above for how the manifest enforces this.

## Picker fields & rate limit (manifest annotations)
- **Rate limit.** Attio documents **100 req/s for reads and 25 req/s for writes** (no concurrency cap). The connector-level default is set to the binding **`rps: 25`** so bulk write runs (assert/create/update) can't 429. The two score-based query endpoints — `queryRecords` and `queryListEntries` — carry a stricter per-method `rps: 5` override because their complexity-score sliding window 429s much sooner under load. On `429`, honour the `Retry-After` header.
- **Object pickers** (the `object` field on every record endpoint): backed by `listObjects`, label = `plural_noun`, value = `api_slug`. The slug (`people`, `companies`, `deals`, custom) is the stable identifier and every path accepts it.
- **List pickers** (the `list` field on every list-entry endpoint): backed by `listLists`, label = `name`, value = `api_slug`.
- **Owner / assignee pickers** (`getWorkspaceMember.workspace_member_id`, `listTasks.assignee`): backed by `listWorkspaceMembers`, labelled by `email_address`. Note: task assignees in *write* bodies still need the member UUID (`id.workspace_member_id`) wrapped as `{ referenced_actor_type: "workspace-member", referenced_actor_id }` — the picker resolves *who*, you supply the typed actor object.
- Not wired (deep child resources keyed by parent — no standalone list endpoint to enumerate them): `record_id`, `entry_id`, `note_id`, `task_id`, `webhook_id`, `comment_id`, `thread_id`, `attribute`, `option`, `status`. Discover these via their parent query/list call (e.g. `queryRecords` → `record_id`, `listAttributes` → `attribute`).

## Endpoints by job

**Query & read records**
- `attio.listObjects` — discover available objects + their `api_slug` (people, companies, deals, users, workspaces, custom).
- `attio.queryRecords` — `POST /v2/objects/{object}/records/query` with `filter` / `sorts` / `limit` / `offset`. The workhorse read.
- `attio.searchRecords` — fuzzy full-text search across one or more objects (`query`, `objects[]`).
- `attio.getRecord` — one record by `record_id` with all `values`.
- `attio.listRecordAttributeValues` — value history for one attribute on a record.
- `attio.listRecordEntries` — which lists a record belongs to.

**Create / assert / update records**
- `attio.assertRecord` — **upsert** by `matching_attribute` (PUT). Preferred for write-back: create-or-update in one call.
- `attio.createRecord` — strict create (throws on unique conflicts).
- `attio.updateRecordAppend` (PATCH) / `attio.updateRecordOverwrite` (PUT) — update by id; PATCH appends multiselect values, PUT overwrites them.
- `attio.deleteRecord` — destructive.

**Attributes & metadata**
- `attio.listAttributes` / `attio.getAttribute` — discover the real attribute slugs/types on an object or list (`target` = `objects` or `lists`).
- `attio.createAttribute` / `attio.updateAttribute` — manage custom fields.
- `attio.listSelectOptions` / `attio.createSelectOption` / `attio.updateSelectOption` — manage select-attribute options.
- `attio.listStatuses` / `attio.createStatus` / `attio.updateStatus` — manage status-attribute values (e.g. deal stages).

**Lists & entries**
- `attio.listLists` / `attio.getList` / `attio.createList` / `attio.updateList` — manage lists.
- `attio.queryListEntries` — filter/sort entries in a list.
- `attio.createListEntry` — add a record to a list; `attio.assertListEntryByParent` — upsert an entry keyed by its parent record (won't duplicate).
- `attio.getListEntry`, `attio.updateListEntryAppend` (PATCH) / `attio.updateListEntryOverwrite` (PUT), `attio.deleteListEntry` (removes from list, keeps record), `attio.listListEntryAttributeValues`.

**Notes / Tasks / Comments**
- `attio.listNotes` / `attio.getNote` / `attio.createNote` / `attio.deleteNote` — notes on records (`format`: `plaintext` | `markdown`).
- `attio.listTasks` / `attio.getTask` / `attio.createTask` / `attio.updateTask` / `attio.deleteTask` — tasks with deadlines, assignees, linked records.
- `attio.listThreads` / `attio.getThread`, `attio.createComment` / `attio.getComment` / `attio.deleteComment` — comment threads on records/entries.

**Webhooks**
- `attio.listWebhooks` / `attio.getWebhook` / `attio.createWebhook` / `attio.updateWebhook` / `attio.deleteWebhook` — subscribe to `record.created`, `record.updated`, `list-entry.created`, `note.created`, `task.created`, `comment.created`, etc.

**Workspace / meta**
- `attio.identifySelf` — confirm token, scopes, workspace.
- `attio.listWorkspaceMembers` / `attio.getWorkspaceMember` — resolve member ids for task assignees and comment authors.

## Recipes

1. **Assert (upsert) a company by domain, then add it to a list**
   1. `attio.assertRecord` with `object: "companies"`, `matching_attribute: "domains"`, `data: { "values": { "domains": ["{{Domain}}"], "name": "{{Company Name}}" } }` → returns `data.id.record_id`.
   2. `attio.assertListEntryByParent` with `list: "my-target-accounts"`, `data: { "parent_object": "companies", "parent_record_id": "<record_id from step 1>", "entry_values": { "stage": "New" } }`. Using *assert* in both steps means re-running the grid won't create duplicates.

2. **Upsert a person by email and link them to their company**
   1. `attio.assertRecord` `object: "people"`, `matching_attribute: "email_addresses"`, `data: { "values": { "email_addresses": ["{{Email}}"], "name": "{{Full Name}}", "job_title": "{{Title}}" } }`.
   2. To attach the company, set a record-reference attribute: `data: { "values": { "company": [{ "target_object": "companies", "target_record_id": "{{Company Record ID}}" }] } }` in the same assert (record references take an array of `{ target_object, target_record_id }`).

3. **Pull a CRM field into a grid column (read-only lookup by domain)**
   1. `attio.queryRecords` `object: "companies"`, `filter: { "domains": "{{Domain}}" }`, `limit: 1`.
   2. Read `data[0].values.<attribute_slug>` for the field you want (e.g. `data[0].values.categories`). Run `attio.listAttributes` once with `target: "objects"`, `identifier: "companies"` to learn the exact slugs first.

4. **Log research as a note + a follow-up task on a record**
   1. `attio.createNote` `data: { "parent_object": "companies", "parent_record_id": "{{Company Record ID}}", "title": "Research summary", "format": "markdown", "content": "{{Summary}}" }`.
   2. `attio.createTask` `data: { "content": "Reach out to {{Company Name}}", "format": "plaintext", "deadline_at": "2026-07-01T09:00:00Z", "linked_records": [{ "target_object": "companies", "target_record_id": "{{Company Record ID}}" }], "assignees": [{ "referenced_actor_type": "workspace-member", "referenced_actor_id": "{{Member ID}}" }] }` (get the member id from `attio.listWorkspaceMembers`).

## Gotchas
- **Assert vs create.** `assertRecord`/`assertListEntryByParent` (PUT) are idempotent upserts — always prefer them for grid write-back so re-runs don't duplicate. `createRecord` (POST) **throws** on a unique-attribute conflict. Assert requires `matching_attribute` to be set to a *unique* attribute (e.g. `domains` on companies, `email_addresses` on people); matching on a non-unique attribute errors.
- **The `data: { values: {...} }` envelope.** Almost every write wraps the body in `data`. Record writes use `data.values`; list-entry writes use `data.entry_values`; notes/tasks/comments/webhooks use flat fields inside `data`. Don't post attributes at the top level — they'll be ignored/rejected.
- **Values are arrays of value-objects, even for "single" fields.** Most attribute values come back (and are written) as arrays — `values.name` is `[{ value: "Acme" }]`, `values.domains` is `[{ domain: "acme.com" }]`. When writing you can usually pass the simplified form (`"name": "Acme"`, `"domains": ["acme.com"]`) and Attio coerces it, but reads are always arrays — index `[0]` and pull `.value` / the typed sub-field.
- **Record references and actor references are typed.** A record-reference value is `[{ target_object, target_record_id }]`; an assignee/comment author is `{ referenced_actor_type: "workspace-member", referenced_actor_id }`. You can't pass a bare id.
- **Attribute slugs vs ids.** Paths and filters accept either the human `api_slug` (`name`, `domains`, `stage`) or the UUID. Slugs are stable and readable — discover them with `attio.listAttributes` (don't guess; custom workspaces rename/add fields).
- **Filter shape.** `queryRecords` / `queryListEntries` use `filter` as `{ attribute_slug: value }` for equality, or operator objects like `{ "name": { "$contains": "Stripe" } }`, and combine with `{ "$and": [...] }` / `{ "$or": [...] }`. It is NOT a SQL string.
- **Pagination is limit/offset.** Both query endpoints take `limit` (default/max 500) and `offset`. There is no cursor — page by incrementing `offset`. List endpoints (notes, tasks, webhooks) take `limit`/`offset` too.
- **Attributes endpoint targets two things.** `listAttributes` etc. use `target` = `objects` *or* `lists` with `identifier` = the object/list slug — lists have their own entry-level attributes separate from the parent object's attributes.
- **Scopes are per-token.** A `403 insufficient_scope` is a scope problem, not a wrong key — re-issue the key with the needed read-write scopes. Reads need `:read`, writes need `:read-write`.
- **Deletes are permanent and not billed back.** `deleteRecord` removes the record everywhere; `deleteListEntry` only removes it from that list (the record survives). Only run deletes when explicitly asked.
- Docs: https://docs.attio.com/rest-api · full OpenAPI at https://api.attio.com/openapi/api.
