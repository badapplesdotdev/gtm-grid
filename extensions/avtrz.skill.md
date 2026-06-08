# Avtrz — Agent Skill
> Resolve a person's real LinkedIn profile photo from their LinkedIn URL or handle — the fastest way to fill a "photo" / "avatar" column with a durable CDN image URL.

## When to use
- Use when a column needs a **profile picture / headshot** for a person and you have their LinkedIn URL or `/in/` handle (e.g. enriching a CRM contact list, org chart, or recruiting pipeline).
- Use when you want a **stable embeddable image URL** that auto-refreshes (Avtrz re-checks every 24h) rather than scraping LinkedIn yourself.
- Do NOT use for full profile enrichment (name, title, company, email) — Avtrz's REST API only returns an image. Use a data-enrichment connector (e.g. LeadMagic `profileSearch`) for fields.
- Do NOT use for company logos or non-LinkedIn identifiers — input must be a LinkedIn person URL or handle.

## Auth & cost
- **Base URL:** `https://www.avtrz.dev/v1`
- **Auth:** API key via the `x-api-key` header (the connector sends this). Use a **secret `sk_` key** server-side; publishable `pk_` keys are for browser embeds and are domain-locked.
- **Cost:** 1 credit per call. Free tier = 100 new people + 1,000 profile views/month. Pro from $50/mo.
- **Quota / limits:** `402` when the request or new-profile quota is exceeded; `429` when rate-limited (respect the `Retry-After` header).

## Endpoints by job

### Resolve a profile photo
- `avtrz.getAvatar` — Resolves a LinkedIn URL or handle to a CDN-hosted profile photo. **Inputs:** `linkedin_url` OR `username` (at least one required), optional `size` (32 | 64 | 128 | 256 | 512, default 128). **Returns:** on a hit, HTTP 302 with the image URL in the `Location` header (cacheable 24h); on a miss, HTTP 200 with an SVG placeholder (`Cache-Control: no-store`). Read the status/Location to tell a real photo from the fallback.

## Recipes

1. **Fill an avatar column from a LinkedIn URL column**
   1. Call `avtrz.getAvatar` with `{ "linkedin_url": "{{LinkedIn URL}}", "size": 256 }`.
   2. Store the resolved `Location` URL as the avatar. A 200/SVG response means no photo was found — leave the cell blank or flag it.

2. **Fill an avatar column when you only have a handle**
   1. Call `avtrz.getAvatar` with `{ "username": "{{LinkedIn Handle}}" }` (the slug after `/in/`, e.g. `alex-rivera`).
   2. Use the returned CDN URL directly in an `<img src>` or downstream record.

3. **High-res headshots for an org chart / directory**
   1. Call `avtrz.getAvatar` with `{ "linkedin_url": "{{LinkedIn URL}}", "size": 512 }`.
   2. The CDN URL is durable for ~24h and auto-refreshes — safe to cache in the grid.

## Gotchas
- **Provide exactly one identifier source:** `linkedin_url` OR `username`. Sending neither returns `400`.
- **Miss is a 200, not an error:** "no photo found" comes back as HTTP 200 with an SVG placeholder, not a 4xx. Don't treat 200 as success — check for a 302 + `Location` to confirm a real photo.
- **Image, not data:** this endpoint returns an image (redirect), never JSON profile fields. There is no public REST endpoint for name/title/company — that exists only in Avtrz's MCP `get_profile` tool, not the API.
- **`size` is an enum:** only 32/64/128/256/512 are valid; other values are rejected (`400`).
- **Key types matter:** use a secret `sk_` key here. A `pk_` publishable key is domain-locked and will `401` outside an allowlisted browser origin.
- **Quota errors are `402`, rate limits are `429`** — both are recoverable; back off on `429` using `Retry-After`.
