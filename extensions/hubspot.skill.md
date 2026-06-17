# HubSpot — Agent Skill
> Read, search, create, update and associate records in a HubSpot CRM — contacts, companies, deals, tickets, line items, products, quotes and custom objects — plus properties, owners, pipelines, engagements (notes/tasks/calls/emails/meetings) and lists. The right tool when a grid column needs to look up, enrich-into, or sync rows with the customer's CRM of record.

## When to use
- Look up or enrich a row against the CRM: find a contact/company/deal by email/domain/name (`searchContacts`, `searchCompanies`, `searchDeals`), then pull or write specific fields.
- Push grid rows INTO HubSpot: create/update contacts, companies, deals or tickets (single or batch), then wire them together with associations.
- Read pipeline/owner/property metadata to resolve the ids you need before writing (stage ids, owner ids, valid property names).
- Log activity or manage segments: create notes/tasks/calls/emails/meetings on a record, or add/remove records from a list.
- Do NOT use for: finding/verifying emails that aren't already in the CRM (that's LeadMagic), sourcing prospects from social activity (Trigify), or meeting transcripts (Fireflies). HubSpot only knows what's already in this portal.

## Auth & cost
- **Base URL:** `https://api.hubapi.com`. Auth is a **private app access token** sent as `Authorization: Bearer <token>` (the manifest injects it from the `apiKey` secret — the connector prepends `Bearer `). Create the token in HubSpot → Settings → Integrations → Private Apps.
- **Scopes matter.** A 403 almost always means the private app is missing a scope, not a bad token. Typical scopes: `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.objects.deals.read/write`, `tickets`, `crm.schemas.*.read`, `crm.lists.read/write`, `crm.objects.owners.read`.
- **Rate limits:** documented burst is **100 req / 10s** (Free/Starter) or **190 req / 10s** (Pro/Enterprise) per private app, plus a daily cap (250k Free/Starter, 625k Pro, 1M Enterprise). The **CRM Search API is capped at 4 req/sec** across all `search*` endpoints. The manifest enforces a connector-level `rateLimit` of `{ rpm: 600, concurrency: 3 }` (≈10 rps — safe for the stricter Free/Starter tier) and a per-method `{ rps: 4 }` override on every search endpoint (`searchContacts/Companies/Deals/Tickets/Objects/Lists`). A `429` is rate-limiting — back off and retry.
- **Credits:** reads/searches are free (0). Writes and batch ops cost 1 credit. Prefer one batch call over 100 single writes — it's both cheaper and far kinder to the rate limit.

## Endpoints by job

**Read & search records**
- Per-object lists: `hubspot.listContacts`, `listCompanies`, `listDeals`, `listTickets`, `listLineItems`, `listProducts`, `listQuotes` — paginate with `after`; pass `properties` to choose returned fields.
- Get one by id: `hubspot.getContact`, `getCompany`, `getDeal`, `getTicket`, `getLineItem`, `getProduct`, `getQuote` (most accept `idProperty` to look up by a unique field like `email`/`domain`).
- Search (the primary lookup tool): `hubspot.searchContacts`, `searchCompanies`, `searchDeals`, `searchTickets` — POST `filterGroups`/`sorts`/`properties`/`query`/`limit`/`after`.
- Any object (incl. custom): `hubspot.listObjects`, `searchObjects`, `createObject` — pass `objectType` (name or objectTypeId).

**Create & update**
- Single create: `hubspot.createContact`, `createCompany`, `createDeal`, `createTicket`, `createLineItem`, `createProduct`, `createQuote`.
- Single update: `hubspot.updateContact`, `updateCompany`, `updateDeal`, `updateTicket` (PATCH — only the properties you send change).
- Archive (soft-delete): `hubspot.archiveContact`, `archiveCompany`, `archiveDeal`, `archiveTicket`.

**Batch ops (up to 100 records per call)**
- Read: `hubspot.batchReadContacts`, `batchReadCompanies`, `batchReadDeals`, `batchReadTickets` (read by `id`, or by `idProperty` like `email`).
- Create: `hubspot.batchCreateContacts`, `batchCreateCompanies`, `batchCreateDeals`, `batchCreateTickets`.
- Update: `hubspot.batchUpdateContacts`, `batchUpdateCompanies`, `batchUpdateDeals`, `batchUpdateTickets`.

**Associations (v4)**
- `hubspot.listAssociations` — what's associated to a record (e.g. a contact's companies).
- `hubspot.createDefaultAssociation` — PUT an unlabeled link between two records (HubSpot picks the standard type).
- `hubspot.createLabeledAssociation` — PUT a labeled link (body = array of `{ associationCategory, associationTypeId }`).
- `hubspot.listAssociationLabels` — valid label/type ids between two object types (feed into `createLabeledAssociation`).
- `hubspot.deleteAssociation` — remove the link(s) between two records.

**Properties & metadata**
- `hubspot.listProperties` / `getProperty` — discover valid property names, types and enum options for an object (do this BEFORE building a search filter or write).
- `hubspot.createProperty` — define a custom property.

**Owners & pipelines**
- `hubspot.listOwners` / `getOwner` — owner ids for `hubspot_owner_id` (filter `listOwners` by `email`).
- `hubspot.listPipelines` / `getPipeline` / `listPipelineStages` — resolve `dealstage`/`hs_pipeline_stage` ids before creating/moving deals or tickets.

**Engagements (timeline activity)**
- Notes: `hubspot.listNotes` / `createNote`. Tasks: `listTasks` / `createTask`. Calls: `listCalls` / `createCall`. Emails: `listEmails` / `createEmail`. Meetings: `listMeetings` / `createMeeting`.
- Associate an engagement to a record on create so it appears on that record's timeline.

**Lists (segments)**
- `hubspot.createList`, `getList`, `searchLists`, `getListMemberships`.
- `hubspot.addListMemberships` / `removeListMemberships` — membership changes work only on MANUAL/SNAPSHOT lists; the body is a JSON array of record id strings.

## Picker fields (live options)
Several inputs are populated from a live list so the user picks by name and the engine stores the id:
- **`ownerId`** (`getOwner`) → `listOwners`. Owners have no name field, so the dropdown labels by **email** and stores the owner `id`.
- **`pipelineId`** (`getPipeline`, `listPipelineStages`) → `listPipelines`. Labels by pipeline `label`, stores `id`. Backed with a static `objectType: "deals"` arg — for **ticket** pipelines the picker won't list them; pass the ticket `pipelineId` manually (or set `objectType: "tickets"`).
- **`listId`** (`getList`, `getListMemberships`, `addListMemberships`, `removeListMemberships`) → `searchLists`. Response envelope is `lists` (not `results`); labels by `name`, sublabel `processingType`, stores `listId`.
- **`objectType`** (`listObjects`, `searchObjects`, `createObject`) → `listSchemas` (added GET `/crm/v3/schemas`, `includeStandard: true`). Stores `fullyQualifiedName`; sublabel is the `objectTypeId`. The per-object methods (contacts/companies/etc.) keep their fixed paths and are unaffected.

Note: `listSchemas` is a new gap-fill list endpoint added purely to back the object-type picker.

## Recipes
1. **Match a row to a contact by email, then return CRM fields**
   1. `hubspot.searchContacts` with `{ "filterGroups": [{ "filters": [{ "propertyName": "email", "operator": "EQ", "value": "{{Email}}" }] }], "properties": ["email","firstname","lastname","company","lifecyclestage","hubspot_owner_id"], "limit": 1 }`.
   2. Read the single match from `results[0].properties` into the grid (e.g. `{{Lifecycle Stage}}`, `{{Owner}}`).

2. **Find companies by email domain, then enrich the grid**
   1. `hubspot.searchCompanies` with `{ "filterGroups": [{ "filters": [{ "propertyName": "domain", "operator": "EQ", "value": "{{Domain}}" }] }], "properties": ["name","domain","industry","numberofemployees","annualrevenue"], "limit": 1 }`.
   2. Write `results[0].properties.industry` etc. back into the row. If no match, fall back to `hubspot.createCompany`.

3. **Create a contact and link it to its company**
   1. `hubspot.createContact` with `{ "properties": { "email": "{{Email}}", "firstname": "{{First Name}}", "lastname": "{{Last Name}}" } }` → capture the new contact `id`.
   2. Resolve the company: `hubspot.searchCompanies` by `{{Domain}}` (or `hubspot.createCompany`) → company `id`.
   3. `hubspot.createDefaultAssociation` with `{ "fromObjectType": "contacts", "fromObjectId": "<contactId>", "toObjectType": "companies", "toObjectId": "<companyId>" }`.

4. **Create a deal in the right stage, owned by the right rep**
   1. `hubspot.listPipelines` with `{ "objectType": "deals" }` → pick the pipeline id and the target stage id.
   2. `hubspot.listOwners` with `{ "email": "{{Rep Email}}" }` → owner `id`.
   3. `hubspot.createDeal` with `{ "properties": { "dealname": "{{Deal Name}}", "amount": "{{Amount}}", "pipeline": "<pipelineId>", "dealstage": "<stageId>", "hubspot_owner_id": "<ownerId>" }, "associations": [{ "to": { "id": "<companyId>" }, "types": [{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 5 }] }] }`.

## Gotchas
- **`properties` is opt-in.** List/get/search return only a default minimal set unless you pass the `properties` array of the exact fields you want back — always list them, or you'll get empty columns.
- **Search pagination uses `after`, not page numbers.** Read `paging.next.after` from the response and pass it as `after` on the next call; stop when `paging.next` is absent. Search caps at `limit` 100 and ~10,000 total results — narrow filters for large sets.
- **filterGroups logic:** filters within one group are AND'd; separate groups are OR'd. Max 5 groups × 6 filters. Use real operators (`EQ`, `NEQ`, `GT`, `GTE`, `LT`, `LTE`, `CONTAINS_TOKEN`, `HAS_PROPERTY`, `NOT_HAS_PROPERTY`, `IN`, `BETWEEN`). Use `listProperties` to confirm property names first.
- **Newly written records lag the search index** by a few seconds — a record you just created may not appear in `search*` immediately; read it by id instead.
- **Batch limits = 100 inputs per call.** Chunk larger sets and watch the per-second rate limit; a partial-success batch returns `status: "COMPLETE"` with individual errors in `errors[]` — check it, don't assume all rows landed.
- **Associations are v4, not v3.** Use the `crm/v4` methods here. v4 `deleteAssociation` removes ALL association types between the two records (you can't delete a single label). For labeled links, get the `associationTypeId` from `listAssociationLabels` first (common HUBSPOT_DEFINED ids: contact→company = 1, company→contact = 2, deal→contact = 3, deal→company = 5).
- **Pipeline/stage and owner values are IDs, not labels.** `dealstage`, `hs_pipeline_stage` and `hubspot_owner_id` must be the internal ids from `listPipelines`/`listOwners`, never the human-readable name.
- **List membership only on MANUAL/SNAPSHOT lists** — DYNAMIC lists manage themselves from filters and will reject `addListMemberships`/`removeListMemberships`. The body for add/remove is a bare JSON array of record id strings.
- **Bearer token + scopes.** A 401 = bad/missing token; a 403 = the private app lacks the scope for that object/action. Reads and writes are separate scopes.
- Docs: https://developers.hubspot.com/docs/api/crm/understanding-the-crm
