# ZoomInfo — Agent Skill
> ZoomInfo is a broad B2B intelligence and GTM operations API. Use it to discover and enrich contacts/companies, retrieve buying signals, generate Copilot insights, and operate ZoomInfo Studio audiences.

## Connect and authorize
- Paste a ZoomInfo OAuth 2.0 **access token** into the ZoomInfo credential. The connector sends it as `Authorization: Bearer <token>`; do not include the `Bearer ` prefix when saving it.
- Tokens must carry the scope named in each function's description. A valid token with the wrong scope returns **403**; an expired or invalid token returns **401**.
- For testing, ZoomInfo supports generating an access token in its Developer Portal. Production applications should obtain tokens with Authorization Code + PKCE or Client Credentials and replace the saved token when it expires.
- Base URL: `https://api.zoominfo.com/gtm`. Request/response media type: JSON:API (`application/vnd.api+json`).

## The core discovery workflow
1. Use `searchContact` or `searchCompany` to find ZoomInfo record IDs. Search results intentionally contain only basic fields and availability hints; Contact Search does **not** reveal emails or phone numbers.
2. Pass up to 25 matches into `enrichContact` or `enrichCompany`, set `data.attributes.outputFields`, and optionally `requiredFields` to reject records missing essential data.
3. Discover exact filter/output field names with `lookup`, `lookupSearch`, and `lookupEnrich` instead of guessing enum values.

## Data API (18 endpoints)
- Search: `searchContact`, `searchCompany`, `searchIntent`, `searchNews`, `searchScoop`.
- Enrich: `enrichContact`, `enrichCompany`, `enrichCorporateHierarchy`, `enrichIntent`, `enrichNews`, `enrichOrgChart`, `enrichScoop`, `enrichTechnology`, `enrichHashtag`.
- Metadata and quota: `lookup`, `lookupSearch`, `lookupEnrich`, `userUsage`.

Search and enrich requests use a JSON:API body shaped like `{ data: { type, attributes } }`. Pagination fields such as `page[number]`, `page[size]`, and `sort` are separate top-level function inputs because the connector sends them in the query string.

## Copilot API (33 endpoints)
- Account intelligence: `getAccountSummary`, `askAccountSummaryQuestion`, `getCompanyInsightsByType`, `companyLookalikes`, `getContactRecommendations`, `getContactLookalikes`.
- Buyer personas: `listCustomerBuyerPersonas`, `upsertCustomerBuyerPersona`, `getCustomerBuyerPersona`, `deleteCustomerBuyerPersona`, `archiveCustomerBuyerPersona`, `unarchiveCustomerBuyerPersona`.
- Competitors: `listCustomerCompetitors`, `upsertCustomerCompetitor`, `getCustomerCompetitor`, `deleteCustomerCompetitor`, `archiveCustomerCompetitor`, `unarchiveCustomerCompetitor`.
- Ideal customer profiles: `listIdealCompanySegments`, `upsertIdealCompanySegment`, `getIdealCompanySegment`, `deleteIdealCompanySegment`, `archiveIdealCompanySegment`, `unarchiveIdealCompanySegment`.
- Customer configuration: `getCustomerSettings`, `upsertCustomerSettings`, `deleteCustomerSettings`.
- Products/services: `listOrganizationOfferings`, `upsertOrganizationOffering`, `getOrganizationOffering`, `deleteOrganizationOffering`, `archiveOrganizationOffering`, `unarchiveOrganizationOffering`.

## GTM Studio API (22 endpoints)
- Folders: `createFolder`, `listFolders`, `getFolderById`, `updateFolder`, `deleteFolder`.
- Audiences: `studioCreateAudience`, `listAudiences`, `studioGetAudience`, `studioDeleteAudience`, `patchAudience`, `getAudienceFilterMetadata`, `upsertMatchCriteria`, `enrichAudience`, `getJobStatus`.
- Columns: `addColumns`, `getSupportedDataDependencies`, `patchColumn`, `deleteColumn`.
- Rows: `getRowById`, `listRows`, `upsertRows`, `deleteRows`.

Studio has asynchronous operations. `enrichAudience` and `deleteRows` return job identifiers; call `getJobStatus` until the status is `SUCCEEDED`, `PARTIALLY_SUCCEEDED`, `FAILED`, or `CANCELLED`. Destructive functions permanently remove folders, audiences, columns, rows, and their contained data—only call them when the user explicitly intends that mutation.

## Marketing, Platform, and Agent APIs (11 endpoints)
- Legacy/Marketing audiences: `marketingCreateAudience`, `getAudiences`, `marketingGetAudience`, `updateAudience`, `marketingDeleteAudience`, `uploadAudience`, `getAudienceUpload`.
- Content interactions: `upsertContentInteractions`, `getContentInteractionEngagement`, `deleteContentInteractionEngagement`.
- Agent signals: `listPulses`.

The Studio and Marketing audience APIs are distinct products and use different resource shapes. Prefer Studio methods for `/studio/v1` audiences; use Marketing methods only for an existing `/marketing/v1` integration.

## Credits, records, and limits
- Contact/company search does not consume enrichment credits. Enrichment normally charges per returned managed record; no-match and errors generally do not charge.
- Signal endpoints can also count returned Intent, News, or Scoop items against record/request limits even where enrichment credits are not consumed.
- `userUsage` is the source of truth for current allowance. ZoomInfo publishes package-dependent limits; the connector conservatively throttles to the lowest documented tier of **5 requests/second** with at most 3 concurrent calls.
- The runtime honors `Retry-After` on **429** responses. An hourly or daily limit can require a long pause, so do not loop immediate retries.

## Gotchas
- Search is not enrichment: search results are candidates, not engagement-ready records.
- Enrich inputs are batch resources (up to 25 records), not one flat contact/company object.
- `outputFields` controls what enrich returns and is entitlement-sensitive. Use `lookupEnrich` with the right entity before requesting fields.
- Many filters have controlled values. Use the lookup functions rather than natural-language approximations.
- A 403 usually means missing OAuth scope or product entitlement, not a malformed credential.
- Access tokens expire. Reconnect the ZoomInfo credential with a fresh token after a 401.

## Official documentation
- Endpoint index: https://docs.zoominfo.com/llms.txt
- Authorization: https://docs.zoominfo.com/docs/authorization
- Credits: https://docs.zoominfo.com/docs/credit-usage-and-limits
- Rate limits: https://docs.zoominfo.com/docs/rate-limits
