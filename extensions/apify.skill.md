# Apify — Agent Skill
> Run any scraper/automation from Apify's Actor Store (web crawlers, social/maps/e-commerce scrapers) and get structured rows back per grid row — the universal escape hatch when no dedicated connector exists.

## When to use
- You need data from a source with NO dedicated GTM Grid connector (Instagram, Google Maps, Amazon, a website's content, a SERP, etc.) — find an actor in the Store and run it.
- A column input is a URL/handle/search term and you want scraped structured output back (e.g. crawl {{Website}} → page text, contacts).
- NOT for simple B2B enrichment that LeadMagic/Trigify already cover (email/phone/profile) — those are cheaper and faster per row.
- NOT for runs that take longer than ~5 min per row — sync calls time out; use the async start + poll + fetch pattern instead.

## Auth & cost
- Auth: `Authorization` header carrying the Apify API token (stored as `apiKey`). Token also works as `?token=` but the connector sends the header.
- Base URL: `https://api.apify.com/v2`.
- Grid credits: 1 per actor/task run, 0 for fetch/status/store/account calls. **Real Apify billing is separate** — each actor charges your Apify account by its own pricing (per-result, per-event, or compute units). Bulk/expensive actors can burn real money fast.
- Limits: sync run endpoints hard-cap at **300s** (408 on timeout). Key-value CRUD ~200 req/s per resource. `searchStore` returns max 1000 items/page.
- **Rate limit (connector):** Apify's documented default is **60 req/s per resource**; run-Actor endpoints sit in a higher 400 req/s bucket. The manifest sets a connector default of `rps: 60` (concurrency 5) and a stricter per-method `rps: 3` override on `runActorSync`/`runActor` because each run bills your real Apify account — bulk grid runs should drip, not flood.

## Picker (options) fields
- `actorId` (on `runActorSync` / `runActor`) → backed by **`listActors`** (`my=1`, `itemsPath: data.items`, label `title`, value `id`, sublabel `username`). Only enumerates Actors you own/created; public Store actors are discovered via `searchStore`, then passed as free text in the `username~name` form (the field stays typeable).
- `datasetId` (on `getDatasetItems`) → backed by **`listDatasets`** (`itemsPath: data.items`, label `name`, value `id`, sublabel `itemCount`). Pick a named dataset, or paste a run's `defaultDatasetId`.

## Endpoints by job

### Discover which actor to run
- `apify.searchStore` — search the public Actor Store. Inputs: `search` (e.g. "google maps scraper"), optional `category`, `sortBy`, `pricingModel`, `username`, `limit`/`offset`. Returns actor metadata incl. `username` + `name`; build the `actorId` as `username~name`.

### Run an actor and get rows (the common case)
- `apify.runActorSync` — POST `/acts/{actorId}/run-sync-get-dataset-items`. Runs actor, waits, returns the **dataset items array** directly. `actorId` = `username~actorname`; every other field becomes the actor's input JSON. Best default for one-call scraping.
- `apify.runActorSyncOutput` — same but returns the actor's single **OUTPUT** record (key-value) instead of dataset rows. Use for actors that emit one structured object, not a table.

### Run a saved Task (pre-configured actor + input)
- `apify.runTaskSync` — POST `/actor-tasks/{taskId}/run-sync-get-dataset-items`. Runs a saved Task, returns dataset items. `taskId` = id or `username~taskname`; extra fields override the saved input.
- `apify.runTask` — async start of a saved Task. Returns `{ data: { id, defaultDatasetId, status } }`.

### Long runs: async start → poll → fetch
- `apify.runActor` — POST `/acts/{actorId}/runs`. Starts async, returns `{ data: { id, defaultDatasetId, defaultKeyValueStoreId, status } }`. No 300s cap.
- `apify.getRun` — GET `/actor-runs/{runId}`. Poll for `status` (READY→RUNNING→SUCCEEDED/FAILED/ABORTED/TIMED-OUT) and grab `defaultDatasetId`.
- `apify.abortRun` — POST `/actor-runs/{runId}/abort`. Stop a run; `gracefully:true` lets it finish current work.

### Read results / metadata
- `apify.getDatasetItems` — GET `/datasets/{datasetId}/items`. Returns the rows array. Params: `limit`, `offset` (paginate), `clean`.
- `apify.getDataset` — GET `/datasets/{datasetId}`. Metadata only; read `itemCount` to plan pagination before pulling items.
- `apify.getKeyValueRecord` — GET `/key-value-stores/{storeId}/records/{recordKey}`. Read a single record (e.g. `OUTPUT`) using a run's `defaultKeyValueStoreId`.

### Account
- `apify.me` — GET `/users/me`. Confirm token / plan.

## Recipes

1. **Scrape a website's content per row (one call)**
   1. `apify.runActorSync` with `{ actorId: "apify~website-content-crawler", startUrls: [{ url: "{{Website}}" }], maxCrawlPages: 1 }`.
   2. Result is the dataset items array — read `[0].text` / `[0].markdown`.

2. **Find the right actor, then run it**
   1. `apify.searchStore` with `{ search: "google maps scraper", sortBy: "popularity" }`.
   2. Take an item's `username` + `name` → `actorId = "username~name"`.
   3. `apify.runActorSync` with `{ actorId, searchStringsArray: ["coffee shops {{City}}"], maxCrawledPlacesPerSearch: 20 }`.

3. **Long scrape (over 5 min): async + poll + fetch**
   1. `apify.runActor` with `{ actorId: "apify~instagram-scraper", directUrls: ["{{Profile URL}}"], resultsLimit: 200 }` → keep `data.id` and `data.defaultDatasetId`.
   2. `apify.getRun` with `{ runId: {{data.id}} }` repeatedly until `data.status` is `SUCCEEDED`.
   3. `apify.getDatasetItems` with `{ datasetId: {{data.defaultDatasetId}}, limit: 200 }`.

4. **Re-run a saved configuration**
   1. `apify.runTaskSync` with `{ taskId: "myname~daily-leads" }` (no other input — uses the saved config) → dataset items array.

## Gotchas
- **`actorId` uses `~` not `/`.** The Store shows `username/name`; the API path needs `username~name`. Slashes break the route.
- **Input fields are actor-specific.** There is no shared schema — only `actorId`/`taskId` is required by the manifest; every other field is forwarded as the actor's input and must match THAT actor's input schema (check the actor's README/input tab). Wrong field names silently produce empty results.
- **300s sync timeout (408).** If an actor can run long, never use `runActorSync`/`runTaskSync` — use `runActor` → `getRun` (poll) → `getDatasetItems`.
- **Two output shapes.** Most actors write rows to the **dataset** (`run-sync-get-dataset-items` / `getDatasetItems`); some write a single object to **OUTPUT** in the key-value store (`runActorSyncOutput` / `getKeyValueRecord`). Pick the matching pair or you'll get an empty/204 result.
- **Async start returns a run, not data.** `runActor`/`runTask` give you `{ data: { id, defaultDatasetId } }` immediately with `status: READY/RUNNING` — you MUST poll `getRun` until terminal before fetching, or the dataset is empty.
- **Pagination.** Large datasets need `limit`+`offset` loops on `getDatasetItems`; check `getDataset.itemCount` first.
- **Apify billing ≠ grid credits.** Grid charges 1 credit per run, but the actor itself bills your Apify account (often per result). High `limit`/`results` params on paid actors can run up a real bill.
- **Failures may arrive as a finished run with `status: FAILED`, not an HTTP error.** Always check `status` on async runs rather than assuming success.
