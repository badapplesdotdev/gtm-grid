# Surfe — Agent Skill
> Surfe provides people/company discovery, asynchronous enrichment, ICP recommendations, and account-level credit/filter metadata.

## Connect and authenticate
- Save the Surfe **API key** in the Surfe credential. The connector sends `Authorization: Bearer <api-key>`; do not paste the `Bearer ` prefix.
- Create or rotate the key in Surfe API Settings. A missing or invalid key returns **401**.
- Base URL: `https://api.surfe.com`. Requests and responses are JSON.

## Supported API catalog (12 endpoints)

### People
- `searchPeople` — search by job title, seniority, department, location, previous employer, and company criteria.
- `startPeopleEnrichment` — start bulk enrichment for 1–10,000 people using LinkedIn URL or name plus company identifiers.
- `getPeopleEnrichment` — retrieve job progress/results by `enrichmentID`.
- `findPeopleByEmail` — start asynchronous lookup from email; results are retrieved through `getPeopleEnrichment` or a webhook.

### Company
- `searchCompanies` — search using domains, names, industries, headcount, revenue, technology, NAICS, keyword, and location filters.
- `startCompaniesEnrichment` — start enrichment for 1–500 company domains.
- `getCompaniesEnrichment` — retrieve company job progress/results by `enrichmentID`.

### Recommendations
- `upsertRecommendationIcp` — create or replace an ICP for the authenticated user or `externalUserId`.
- `fetchRecommendations` — fetch company and people recommendations using `pagination.from`/`pagination.to`.
- `getRecommendationIcps` — retrieve saved ICP filters, optionally by `externalUserId`.

### Account metadata
- `getCredits` — retrieve email, mobile, and search credit balances.
- `getFilters` — retrieve controlled department, headcount, industry, revenue, seniority, and technology values.

## Recommended workflows

### Search, then enrich people
1. Call `getFilters` when you need controlled filter values.
2. Call `searchPeople` with `people` and/or `companies`. Use `limit` in multiples of 10 for efficient credit use.
3. Use `nextPageToken` as `pageToken` for another page; do not change filters on token requests because Surfe reuses the original criteria.
4. Pass selected matches to `startPeopleEnrichment`, requesting only necessary `include` fields.
5. Prefer `notificationOptions.webhookUrl`. Otherwise call `getPeopleEnrichment` around once per second until status is no longer `IN_PROGRESS`.

### Search or enrich companies
1. Call `searchCompanies` for candidate discovery, using `pageToken` for pagination.
2. Call `startCompaniesEnrichment` with domain/externalID pairs for richer data.
3. Receive the completion webhook or call `getCompaniesEnrichment` by enrichment ID.

### Recommendations
1. Call `upsertRecommendationIcp`; repeated calls replace the ICP for that authenticated/external user.
2. Call `fetchRecommendations` with the same `externalUserId` and a `pagination` range.
3. Recommendations refresh daily and are stable within a day. Exhausted or overly restrictive ICPs can legitimately return no companies.

## Credits, quotas, and rate limits
- Search People and Search Companies charge `ceil(results returned / 10)` ICP search credits when credit charging is enabled. Charges use actual results, not requested limit.
- People enrichment charges per valid email/mobile found. Personal email can cost 2 email credits and requires account enablement. Mobile is ignored during personal-email enrichment.
- Find by Email costs 10 Search credits when it finds a LinkedIn URL.
- Company enrichment costs one credit on paid plans when both annual revenue and industry are returned.
- Recommendations are billed monthly by unique companies fetched, including repeats only once.
- Most endpoints have a 2,000 request/day quota. Quotas reset at midnight in the user's local time.
- The connector enforces Surfe's published **10 requests/second**, with at most three concurrent calls. The runtime honors `Retry-After` for 429 responses.

## Error handling and gotchas
- **400**: malformed request or an invalid filter shape.
- **401**: missing, invalid, or rotated API key—replace the saved credential.
- **403**: insufficient credits or daily quota.
- **404**: enrichment ID or resource was not found.
- **429**: burst rate or quota exceeded; honor `Retry-After` and avoid immediate polling loops.
- Async start methods return IDs, not enrichment results. Store `enrichmentID` if you are not using webhooks.
- Each person needs LinkedIn URL, or first/last name plus company name/domain. More identifiers improve match rate.
- `include` must select at least one people enrichment field.
- Search job titles use acronym and semantic expansion. Use `exactJobTitles` for stricter matching.

## Official documentation
- Endpoint catalog and quick start: https://developers.surfe.com/
- Authentication: https://developers.surfe.com/api-key
- Credits and quotas: https://developers.surfe.com/credits-and-quotas
- Rate limits: https://developers.surfe.com/rate-limits
- Responses and errors: https://developers.surfe.com/api-responses
- Webhooks: https://developers.surfe.com/webhooks
