# Lemlist

Use the bundled `lemlist` connector for Lemlist campaigns, sequences, schedules, leads, CRM contacts and companies, inbox messaging, enrichment, deliverability, tasks, Signal Agents, webhooks, unsubscribe compliance, lemwarm, email accounts, and team data.

## Connection and limits

- Save the Lemlist API key as `apiKey`. Authentication is HTTP Basic with an empty username: the connector safely builds `Authorization: Basic base64(:API_KEY)`. Never pre-encode the key and never put it in grid cells.
- Base URL: `https://api.lemlist.com/api`.
- The generated catalog contains all 140 unique verb/path operations in Lemlist's official v2 OpenAPI across 99 paths. It reconciles all 139 endpoint pages in `llms.txt` and includes the additional official OpenAPI operation `DELETE /campaigns/{campaignId}/leads/`.
- Five legacy unsubscribe operations are still documented and therefore included, but are marked deprecated. Prefer the corresponding `/v2/unsubscribes/...` methods for new workflows.
- Lemlist documents 20 requests per 2 seconds per API key. The connector throttles to 10 requests per second with concurrency 3 and the retry layer respects `Retry-After` on 429 responses.

## Working safely

- Read methods are safe for discovery. Mutating methods can launch or pause campaigns, create/send messages, modify leads, delete CRM data, change unsubscribe status, connect email accounts, create webhooks, and alter Signal Agents. Confirm the intended campaign/contact and user authorization before running them across rows.
- Use `getManyCampaigns`, `getCampaign`, `getCampaignSequences`, `getCampaignSchedules`, and `getCampaignLeads` to resolve IDs before mutations.
- `createLeadInCampaign` accepts enrichment toggles in the query string and lead fields in JSON. Use deduplication when appropriate and respect unsubscribe status before adding or launching a lead.
- `bulkEnrichData` accepts `items` in the grid mapping and sends that value as the API's required top-level JSON array. Limit batches to 500 entities.
- `uploadAudioForVoiceMessageStep` accepts the `file` field as a base64 data URL such as `data:audio/wav;base64,...`; the runtime converts it to multipart form data with a generated boundary.
- Campaign/contact exports may return CSV text or redirect to a generated file. Store or expose exported personal data only where the user has authorized it.
- Webhook creation supports a shared secret. Store webhook secrets securely, validate callbacks, use HTTPS targets, and rotate by deleting/recreating because Lemlist webhook secrets are immutable.
- Never automatically re-subscribe contacts or variables without explicit authorization. Treat the v2 contact/variable unsubscribe operations as the preferred compliance interface.

## Official references

- Overview: https://developer.lemlist.com/api-reference/getting-started/overview
- Documentation index: https://developer.lemlist.com/llms.txt
- OpenAPI: https://developer.lemlist.com/api-reference/openapi/v2.json
- Authentication: https://developer.lemlist.com/api-reference/getting-started/authentication
- Rate limits: https://developer.lemlist.com/api-reference/getting-started/rate-limits
- Errors: https://developer.lemlist.com/api-reference/getting-started/errors
- Endpoint reference: https://developer.lemlist.com/api-reference/endpoints/campaigns/get-many-campaigns
