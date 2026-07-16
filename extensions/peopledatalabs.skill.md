# People Data Labs

Use the bundled `peopledatalabs` connector for PDL person and company matching, search, data cleaning, autocomplete, IP, job-title, skill, job-posting, changelog, and subject-request workflows.

## Connection and operating limits

- Create a key in the PDL dashboard and save it as the connector's `apiKey` secret. Requests send the raw key in `X-Api-Key`; never add `Bearer` and never put the key in grid cells or method inputs.
- Base URL: `https://api.peopledatalabs.com`. The connector contains 27 distinct production verb/path operations. It covers all 21 operations in PDL's current OpenAPI repository, all 14 requests in the official Postman collection, and six current operations documented outside that OpenAPI file.
- The connector defaults to 100 requests per minute and concurrency 3. `searchJobPostings` is capped at its documented 20 requests per minute with concurrency 1. Treat PDL response rate-limit headers as authoritative for the connected account.
- PDL limits responses to 1 MB. Keep search `size` modest and use `data_include` to request only fields needed by the grid.
- Person/company/IP enrichment consumes one credit for a successful match. Search consumes one credit per returned profile, and Job Posting Search consumes one credit per returned posting. Bulk methods use one credit per successful match. Cleaner, autocomplete, changelog, and subject-request methods are marked zero-credit.

## Method groups

- People: `getPersonEnrichment`, `postPersonEnrichment`, `identifyPerson`, `searchPeopleGet`, `searchPeople`, `retrievePerson`, `retrievePeopleBulk`, and `bulkPersonEnrichment`.
- Companies: `enrichCompany`, `bulkCompanyEnrichment`, `searchCompaniesGet`, and `searchCompanies`.
- Cleaning and normalization: `cleanCompanyGet`, `cleanCompany`, `cleanSchoolGet`, `cleanSchool`, `cleanLocationGet`, and `cleanLocation`.
- Supporting enrichment: `autocompleteGet`, `autocomplete`, `enrichIp`, `enrichJobTitleGet`, `enrichJobTitle`, and `enrichSkill`.
- Jobs and dataset governance: `searchJobPostings`, `getPersonChangelog`, and `getSubjectRequests`.

Prefer POST variants for structured filters and large inputs. Use GET variants when a compact query is useful. For Person Enrichment, supply the strongest lawful identifier available (for example `email`, `profile`, or `pdl_id`) and set `min_likelihood` to the confidence threshold the workflow requires. For bulk methods, send 1–100 `requests` and use per-request `metadata` to correlate responses with grid rows.

Search supports either Elasticsearch or SQL where documented; do not send both. Search and job-posting pagination uses returned `scroll_token` values. A Job Posting Search `query` overrides its convenience field filters.

## Data responsibility

- Only request and retain fields needed for the user's stated workflow. Apply applicable privacy, employment, marketing, and data-protection rules before using personal data.
- Treat `getSubjectRequests` as a compliance feed: process returned IDs securely, remove or suppress affected records as required, and avoid displaying the raw feed broadly in a shared grid.
- Use `getPersonChangelog` only with consecutive dataset versions. Supply either a supported `type` or an ID list; `fields_updated` is valid only for `type: "updated"`.
- Do not retry 401/403 responses. Reduce request volume or follow `Retry-After` for 429 responses. A 404 from an enrichment method can mean no match, not a transport failure.
- PDL's sandbox uses a separate sandbox base URL and reduced sample data. This production connector never calls live endpoints during automated tests; Electron tests use a hermetic simulator.

## Official references

- Postman collection: https://www.postman.com/pdl-official/people-data-labs-workspace/collection/u20jtn5/people-data-labs-apis-collection
- OpenAPI repository: https://github.com/peopledatalabs/openAPI-specifications
- Authentication: https://docs.peopledatalabs.com/docs/authentication
- Person Enrichment: https://docs.peopledatalabs.com/docs/reference-person-enrichment-api
- Bulk Person Enrichment: https://docs.peopledatalabs.com/docs/bulk-enrichment-api
- Bulk Company Enrichment: https://docs.peopledatalabs.com/docs/bulk-company-enrichment-api
- Job Posting Search: https://docs.peopledatalabs.com/docs/reference-job-posting-search-api
- Person Changelog: https://docs.peopledatalabs.com/docs/reference-person-changelog-api
- Subject Request API: https://docs.peopledatalabs.com/docs/subject-request-api
- Usage limits: https://docs.peopledatalabs.com/docs/usage-limits
