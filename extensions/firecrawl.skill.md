# Firecrawl — Agent Skill
> Turn any website into clean, LLM-ready data: scrape one page to markdown/html/json, crawl whole sites, map every URL, run web search, and pull structured fields across pages with an LLM. The right tool when a grid column needs content from a web page, a list of a site's URLs, fresh search results, or a structured fact (industry, headcount, pricing) extracted from a company's site.

## When to use
- A column needs the *content* of a known URL as markdown/html/json — homepage copy, a pricing page, a blog post (`scrape`), or many known URLs at once (`startBatchScrape`).
- You need to turn a domain into structured fields (e.g. `{ industry, employees, founded }`) without writing selectors — point `startExtract` at the URL with a `schema`.
- You need fresh web results (and optionally their page content) for a query — `search`.
- You need to discover what's on a site: just the URLs (`map`, cheap/fast) or the full content of every page (`startCrawl`, expensive/slow).
- Do NOT reach for `startCrawl` when you already know the paths — `map` (to list URLs) then `scrape`/`startBatchScrape` is far cheaper and faster. Do NOT use Firecrawl for CRM data, email finding, or social/LinkedIn enrichment (that's HubSpot/Attio, LeadMagic, Trigify) — Firecrawl only reads the public web.

## Auth & cost
- **Base URL:** `https://api.firecrawl.dev`. Auth is **`Authorization: Bearer fc-...`** (the manifest injects the `fc-` token from the secret).
- **Credits:** scrape/map/search cost ~1 credit per page; crawl and batch-scrape burn 1 credit *per page scraped* (a 500-page crawl ≈ 500 credits); extract is billed in **Extract tokens**, tracked separately from credits. Screenshot/json formats cost extra. Status/error/cancel calls are free.
- **Check before big jobs:** `firecrawl.getCreditUsage` (remaining credits) and `firecrawl.getTokenUsage` (Extract tokens). Map first to size a crawl.
- **Rate limits** are per-plan and per-endpoint (sliding 60s window, shared across a team's API keys). The manifest sets a connector default of `rpm: 500, concurrency: 5` (Standard-plan scrape/map tier + concurrent-browser cap), with stricter per-method overrides on the heavy job starters: `startCrawl`, `startBatchScrape`, `startExtract`, `extract` → `rpm: 50` (crawl/extract tier), and `search` → `rpm: 250`. Free tier is far tighter (scrape 10, crawl 1, search 5 rpm). A `429` means back off, a `402` means out of credits/tokens. Docs: https://docs.firecrawl.dev/rate-limits.
- **No picker (`options`) fields.** Firecrawl is a stateless web-data API — every input is a URL, query, JSON Schema, or a job `id` returned by a prior `start*` call. There is no enumerable account-scoped resource (campaign/list/account/etc.) to pick from, so no field carries `options`.

## Endpoints by job

**Scrape a page**
- `firecrawl.scrape` — one URL → `{ markdown, html, links, screenshot, metadata }`. Key inputs: `url`, `formats` (e.g. `['markdown','html','links','screenshot']`), `onlyMainContent`, `includeTags`/`excludeTags`, `waitFor`, `actions` (click/scroll/wait before scraping). Synchronous.
- `firecrawl.parse` — same idea for a hosted PDF/DOCX URL → markdown.

**Crawl a site (async job → poll)**
- `firecrawl.startCrawl` — follow links from a base `url` and scrape every page. Inputs: `limit`, `maxDiscoveryDepth`, `includePaths`/`excludePaths` (regex), `allowSubdomains`, `scrapeOptions`. Returns an `id`.
- `firecrawl.getCrawlStatus` — poll the `id` for `status`/`data`; follow `next` to page large result sets.
- `firecrawl.cancelCrawl` / `firecrawl.getCrawlErrors` — stop a running job / inspect failed + robots-blocked pages.
- `firecrawl.crawlParamsPreview` — preview the resolved crawl options for a `url` + natural-language `prompt` without spending credits.

**Map URLs**
- `firecrawl.map` — base `url` → fast list of `{ url, title, description }`. Inputs: `search` (rank by relevance), `includeSubdomains`, `limit`. Cheap — use to discover paths before scraping.

**Web search**
- `firecrawl.search` — `query` → `{ web, images, news }` results. Inputs: `limit`, `sources`, `includeDomains`/`excludeDomains`, `country`, `tbs` (time filter), and `scrapeOptions` to also scrape each result page in one call.

**LLM extract (async job → poll)**
- `firecrawl.startExtract` — `urls[]` (glob ok) + `prompt` + `schema` (JSON Schema) → structured data. `enableWebSearch` to augment. Returns an `id`.
- `firecrawl.getExtractStatus` — poll the `id` until `status='completed'`, read `data`.

**Batch (async job → poll)**
- `firecrawl.startBatchScrape` — many known `urls[]`, one set of scrape options → returns `id` + `invalidURLs`.
- `firecrawl.getBatchScrapeStatus` / `firecrawl.cancelBatchScrape` / `firecrawl.getBatchScrapeErrors`.

**Usage**
- `firecrawl.getCreditUsage`, `firecrawl.getCreditUsageHistorical`, `firecrawl.getTokenUsage`.

## Recipes
1. **Map a site, then scrape each URL to markdown**
   1. `firecrawl.map` with `{ "url": "{{Domain}}", "search": "blog", "limit": 50 }` → `links[]`.
   2. `add_rows` one row per `link.url`.
   3. `firecrawl.scrape` per row with `{ "url": "{{URL}}", "formats": ["markdown"], "onlyMainContent": true }` → `data.markdown`.
   (Cheaper + faster than `startCrawl` because you only fetch the pages you want.)

2. **Scrape a company homepage and extract structured firmographics**
   1. `firecrawl.startExtract` with `{ "urls": ["{{Company Website}}"], "prompt": "Extract the company's industry, employee count and a one-line description.", "schema": { "type": "object", "properties": { "industry": { "type": "string" }, "employees": { "type": "integer" }, "description": { "type": "string" } } } }` → `id`.
   2. Poll `firecrawl.getExtractStatus` with `{ "id": "{{Extract ID}}" }` until `status='completed'`; spread `data.industry` / `data.employees` into columns.

3. **Crawl a docs site and collect every page (async)**
   1. (Optional) `firecrawl.getCreditUsage` to confirm budget; `firecrawl.map` to size it.
   2. `firecrawl.startCrawl` with `{ "url": "{{Docs URL}}", "limit": 200, "includePaths": ["^/docs/.*"], "scrapeOptions": { "formats": ["markdown"] } }` → `id`.
   3. Poll `firecrawl.getCrawlStatus` with `{ "id": "{{Crawl ID}}" }` until `status='completed'`; follow `data[].next` pages; `firecrawl.getCrawlErrors` for any failures.

4. **Web search for a topic and pull the top pages' content**
   - `firecrawl.search` with `{ "query": "{{Company}} pricing", "limit": 5, "tbs": "qdr:m", "scrapeOptions": { "formats": ["markdown"] } }` → `data.web[]` with `markdown` already populated. No second call needed.

## Gotchas
- **Crawl, extract, and batch scrape are ASYNC.** The `start*` call returns an `id`, NOT the data — you must poll `get*Status` until `status` is `completed` (`failed`/`cancelled` are terminal too). An empty/`processing` first poll is normal, not an error. Only `scrape`, `parse`, `map`, and `search` return data synchronously.
- **`formats` controls the output.** No markdown back? You didn't request it. Want a screenshot or structured JSON? Add `'screenshot'` or a `{ type:'json', prompt, schema }` item to `formats` (json/screenshot cost extra credits).
- **Map is cheap, crawl is expensive.** `map` returns thousands of URLs in one ~1-credit call; `startCrawl` scrapes each page and bills per page. When you know the paths, prefer `map` + `scrape`/`startBatchScrape` over a blind crawl.
- **Credits vs tokens.** Scrape/crawl/map/search/batch spend *credits* (`getCreditUsage`); Extract spends *tokens* (`getTokenUsage`). A `402` on extract means out of tokens, not credits.
- **Large jobs paginate.** Crawl/batch status responses cap data at ~10MB and return a `next` URL — keep following it to get the full result set.
- **Respect the site.** Use `limit`, `maxDiscoveryDepth`, and `includePaths`/`excludePaths` to scope crawls; `getCrawlErrors` surfaces `robotsBlocked` pages Firecrawl skipped.
- **Auth is `Authorization: Bearer fc-...`** — a `401` means a missing/wrong `fc-` key, not a transient error; a `429` means rate-limited (back off).
- Docs: https://docs.firecrawl.dev (API reference at https://docs.firecrawl.dev/api-reference).
