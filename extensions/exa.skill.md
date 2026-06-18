# Exa — Agent Skill
> Neural (embeddings-based) web search + clean page-content retrieval + cited LLM answers — reach for it when you need to find or read live web pages by meaning, not exact keywords.

## When to use
- Use for: meaning-based web discovery (find companies/people/news/papers like X), pulling clean parsed text/summaries from URLs, finding pages similar to a seed URL, and per-row cited Q&A over the live web.
- Use `answer` for a quick one-shot question → cited answer in a single synchronous call.
- Use `createResearchTask` (+ poll) only when you need deep, multi-source research that an LLM should agentically gather over many pages — it is slower and costs more.
- Do NOT use for: enriching a known LinkedIn profile / finding a person's email or phone (use LeadMagic), or for CRM/social-graph data. Exa reads the open web; it is not a contact database.

## Auth & cost
- Base URL: `https://api.exa.ai`
- Auth header: `x-api-key: <EXA_API_KEY>` (secret key `apiKey` in the connector). Content-Type `application/json`.

## Rate limit & picker fields
- **Rate limit (documented):** default **10 QPS** on `/search` and `/answer`; `/contents` is more permissive at 100 QPS; the legacy `/research/v1` API caps at 15 concurrent tasks. The connector sets a conservative `rateLimit` of `{ "rps": 10, "concurrency": 5 }` at the connector level (the strictest shared limit). No per-method override is added because the only more-permissive endpoint (`/contents`) does not need a *stricter* cap. 429 → `{ "error": "rate limit exceeded" }`. Higher limits via Enterprise (hello@exa.ai).
- **No selectable (`options`) fields.** Exa is a stateless web-search/retrieval API with no enumerable account-scoped resources (no campaigns/lists/accounts/sequences/workspaces/owners/folders/tags/tables/sending accounts). All inputs are free-text queries, URLs, domains, dates, or fixed string enums (`type`, `category`) — nothing another endpoint can list. So no list endpoint and no `options` blocks were added; only the connector-level `rateLimit`.
- Billing is usage/credit based per request; `search`, `getContents`, `findSimilar`, `answer` ≈ 1 credit; research tasks are heavier (marked 3). `getResearchTask` / `listResearchTasks` are free polls.
- Every response includes a `costDollars` breakdown — read it if you need exact spend. `numResults`, `text`, and `summary` all increase cost.

## Endpoints by job

### Search & discover
- `exa.search` — neural/keyword web search. Inputs: `query` (required), `type` (auto|keyword|neural|fast), `category` (company|news|people|research paper|financial report|personal site), `numResults` (1-100), `includeDomains`/`excludeDomains`, `startPublishedDate`/`endPublishedDate`, `contents` (e.g. `{ text:true, highlights:true, summary:{query:"..."} }`). Returns `{ results[] }` with `url, title, id, score, publishedDate, author` (+ inline `text/highlights/summary` when `contents` set).
- `exa.findSimilar` — given a seed `url`, return pages similar in meaning (e.g. competitor companies). Inputs: `url` (required), `numResults`, `excludeSourceDomain`, `includeDomains`/`excludeDomains`, `contents`. Returns `{ results[] }`.

### Read page content
- `exa.getContents` — fetch clean text / highlights / summary for known `urls` (or Exa `ids` from search). Inputs: `urls` OR `ids` (1-100), `text`, `highlights`, `summary` (`{query:"..."}`). Returns `{ results[], statuses[] }` — each result has `text/highlights/summary`; `statuses` reports per-URL success/cached/crawled.

### Answer a question
- `exa.answer` — one-shot LLM answer over a fresh web search, with citations. Inputs: `query` (required), `text` (include full page text in citations), `outputSchema` (JSON Schema → returns structured JSON instead of prose). Returns `{ answer, citations[], costDollars }`. Synchronous; do not stream.

### Deep research (async)
- `exa.createResearchTask` — start a multi-step research agent. Inputs: `instructions` (required, ≤4096 chars), `model` (`exa-research` default | `exa-research-pro`), `output` (`{schema:{...}}` or `{inferSchema:true}`). Returns `{ id }` immediately — task is NOT finished.
- `exa.getResearchTask` — poll a task by `id`. Returns `{ id, status, instructions, schema, data, citations }`. `status` ∈ running|completed|failed; `data`+`citations` only present once `completed`.
- `exa.listResearchTasks` — list prior tasks. Inputs: `cursor`, `limit` (1-200). Returns `{ data[], hasMore, nextCursor }`.

## Recipes
1. **Find similar companies to a target** — 1. `exa.findSimilar` with `{ url: {{Company Website}}, numResults: 10, excludeSourceDomain: true, category: "company" }`; 2. read `results[].url`/`title` into new rows.
2. **Search + read top result in one shot** — `exa.search` with `{ query: "{{Topic}} pricing page", numResults: 3, contents: { text: true, summary: { query: "What does it cost?" } } }`; the page text/summary come back inline — no second `getContents` call needed.
3. **Summarize a known URL** — `exa.getContents` with `{ urls: ["{{URL}}"], summary: { query: "What does this company sell and to whom?" } }`; use `results[0].summary`. Check `statuses[0]` for crawl success first.
4. **Cited fact per row** — `exa.answer` with `{ query: "What funding round did {{Company Name}} most recently raise and when?" }`; write `answer` to the cell and `citations[0].url` to a source column. For structured fields, add `outputSchema`.
5. **Deep dossier (async)** — 1. `exa.createResearchTask` with `{ instructions: "Profile {{Company Name}}: products, customers, recent news, competitors", output: { inferSchema: true } }` → keep `id`; 2. poll `exa.getResearchTask` with that `id` until `status === "completed"`; 3. read `data` (+ `citations`).

## Gotchas
- **`answer` vs research:** `answer` is synchronous and returns the result in the call. `createResearchTask` is async — it returns only an `id`; you MUST poll `getResearchTask` until `status: completed` or you'll have no data. `failed` is a terminal status too — stop polling on it.
- **`getResearchTask` path param:** `id` goes in the URL (`/research/v0/tasks/{id}`), not the body. Use the `id` from `createResearchTask`.
- **Inline contents = fewer calls:** prefer passing `contents` to `search`/`findSimilar` over a separate `getContents` round-trip. Only use `getContents` when you already have URLs and didn't search.
- **`getContents` partial failures:** a 200 can still contain per-URL failures — always check `statuses[]` (source can be `cached` or `crawled`; some URLs error individually) before trusting `text`.
- **Cost traps:** large `numResults`, `text: true`, and `summary` each add cost; research-pro is materially more expensive than default. Read `costDollars` if budget matters.
- **`type` matters:** default `auto` picks neural vs keyword. Force `keyword` for exact-string/site lookups, `neural` for conceptual "things like this" queries.
- **Websets (NOT in this connector):** Exa also has a separate async Websets API (curated/enriched datasets) under its own endpoints. It is not part of this manifest — do not call `/websets/...` paths through this connector; they aren't defined here.
- **Deprecation note:** Exa has signaled migrating deep research toward `search` with `type: "deep-reasoning"`. The `/research/v0/tasks` endpoints above are what the published OpenAPI spec exposes; if a research call 404s, fall back to `exa.search` with `type: "deep-reasoning"`.
