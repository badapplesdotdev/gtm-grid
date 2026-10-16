# Upspring - Agent Skill
> Ad intelligence by domain: for any company website, get the advertiser's ads plus coarse modelled spend, traffic and sales grades (D to A+), creative signals and a strategy read. Reach for it when a grid column needs to know whether a brand is advertising, how big it is, and what it is saying in its ads.

## When to use
- Score or segment accounts by advertising scale: `spend`, `traffic` and `sales` grades per domain (D, C, B, A, A+).
- See what an account is running now: advertiser brief, top ads, and the live ad list for that advertiser.
- Find advertisers matching a size or vertical filter (`spend_tier`, `traffic_tier`, `sales_tier`, `vertical`, `min_ads`).
- Do NOT use for: contact or email data (use LeadMagic, FullEnrich, etc.), headcount or firmographics (use The Companies API), or exact spend figures. Grades are coarse estimates and Upspring never exposes the underlying numbers.

## Auth & cost
- **Base URL:** `https://public-api.upspring.ai`
- **Auth:** `Authorization: Bearer upk_...` (secret key `apiKey` in the connector). Keys are issued by Upspring; a missing, malformed or revoked key returns a uniform `401` with code `public-api-invalid-key`.
- **Rate limit (documented):** standard tier is 60 requests per minute and 5000 per day per key, `429` with a `Retry-After` header when exceeded. The connector sets `rateLimit` to `{ "rpm": 60, "concurrency": 3 }`. The daily cap is not expressible in the manifest, so very large runs should be batched across days.
- **Credits:** the manifest does not set a per-call `credits` value; Upspring usage is billed on the user's own Upspring plan.
- **No selectable (`options`) fields.** Inputs are free text, domains, ids or fixed enums. The one id input (`advertiser_id`, `id`) comes from `getAdvertiserByDomain` or `listAdvertisers` output, so pass it through a column reference rather than a picker.

## Endpoints by job

### Enrich a company by domain
- `upspring.getAdvertiserByDomain` - `domain` (required; bare domain or full URL), `sync` (optional boolean). Returns `{ data }` with `id`, `name`, `vertical`, `category`, `summary { one_line, short_summary }`, `enrichment { spend, traffic, sales }` (each `{ grade, floor, estimated, note }`), `social { fb_followers, ig_followers, active_ads, as_of }`, `reddit`, `signals` (`personas`, `mechanisms`, `hooks`, `media_mix`, `funnel`, each `[{ id, label, share }]`), `hook_themes`, `top_ads [{ id, one_line, media_type, is_active }]`, `status`, and `refetch_after` when pending.
- `upspring.getAdvertiser` - same shape by advertiser `id`.

### Search
- `upspring.listAdvertisers` - filter by `name`, `domain`, `fb_page`, `vertical`, `category`, `geo`, `min_ads`, `spend_tier`, `traffic_tier`, `sales_tier`; page with `cursor`. Returns `{ data[], meta }`.
- `upspring.listAds` - filter by `advertiser_id`, `is_active`, `q`, `recency_days`, `order_by` (random | recent | best); page with `cursor`. Returns `{ data[], meta }`, each ad with `one_line`, `hook_text`, `media_type`, `is_active`, `started_at`, `ad_library_url`.

## Recipes
1. **Ad-spend grade per account** - `upspring.getAdvertiserByDomain` with `{ domain: {{Company Website}}, sync: true }`; read `data.enrichment.spend.grade` into a column. Add traffic and sales grades the same way.
2. **Only accounts that are big and advertising** - run recipe 1, then filter rows where `data.status == "ready"` and `data.enrichment.spend.grade` is A or A+.
3. **Live ads for an account** - 1. `getAdvertiserByDomain` to get `data.id`; 2. `upspring.listAds` with `{ advertiser_id: [{{Advertiser ID}}], is_active: true, order_by: "recent", limit: 10 }`; 3. read `data[].one_line` and `data[].ad_library_url`.
4. **Find lookalike-size advertisers in a vertical** - `upspring.listAdvertisers` with `{ vertical: ["<vertical id>"], spend_tier: "B", min_ads: 5 }`.

## Gotchas
- **Never a 404 on `getAdvertiserByDomain`.** It always returns `200` with a `status`. `ready` means data is populated, `pending` means call again after `refetch_after` seconds (or use `sync: true`), `unavailable` means a minimal body `{ data: { domain, status: "unavailable" } }`. Check `status` before reading `enrichment`.
- **`ready` does not mean every field is filled.** `enrichment` can be present before `summary`, `signals` and `top_ads`; read whichever fields are non-null.
- **Grades are tiers, not numbers.** `D <= C <= B <= A <= A+`. `spend_tier`, `traffic_tier` and `sales_tier` filters are open floors ("this tier or bigger").
- **Array filters repeat the query key** (`advertiser_id`, `vertical`). The manifest engine does this for array inputs.
- **Pagination:** a `cursor` is tied to the filter set that produced it. Do not reuse it after changing filters.
