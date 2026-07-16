// Generate the bundled Surfe connector from the current public API catalog.
//
// Surfe's documentation does not currently publish a machine-readable OpenAPI
// download. The endpoint catalog and request schemas below mirror the official
// reference pages; generation first verifies that every supported endpoint in
// the docs navigation is represented and that its documented verb/path has not
// drifted.
//
// Run: pnpm --filter @gtmgrid/engine gen:surfe

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_ROOT = "https://developers.surfe.com";
const LOGO_URL = "https://www.surfe.com/wp-content/uploads/2022/12/cropped-surfe_faveicon_1200-270x270.png";
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../extensions/surfe.json");

const stringArray = (description) => ({
  type: "array",
  ...(description ? { description } : {}),
  items: { type: "string" },
});
const integerRange = (description) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties: { from: { type: "integer" }, to: { type: "integer" } },
});
const numberRange = (description) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties: { from: { type: "number" }, to: { type: "number" } },
});
const state = {
  type: "object",
  properties: {
    code: { type: "string" },
    country: { type: "string", description: "ISO alpha-2 country code." },
    countryAlpha2: { type: "string", description: "ISO alpha-2 country code." },
  },
};
const zipCode = {
  type: "object",
  properties: { countryCode: { type: "string" }, zipCode: { type: "string" } },
};
const locality = {
  type: "object",
  properties: {
    countries: stringArray(),
    freeTexts: stringArray(),
    isExcluded: { type: "boolean" },
    isPrimary: { type: "boolean" },
    states: { type: "array", items: state },
    zipCodes: { type: "array", items: zipCode },
  },
};
const departmentSize = {
  type: "object",
  properties: {
    department: { type: "string" },
    from: { type: "integer" },
    to: { type: "integer" },
  },
};

const searchCompanyFilters = {
  type: "object",
  properties: {
    countries: stringArray("Country or Surfe region codes."),
    departmentSizes: { type: "array", items: departmentSize },
    domains: stringArray(),
    domainsExcluded: stringArray(),
    employeeCount: integerRange(),
    industries: stringArray(),
    industriesExcluded: stringArray(),
    keywords: stringArray(),
    keywordsExcluded: stringArray(),
    localities: { type: "array", items: locality },
    naicsCodes: { type: "array", items: { type: "integer" } },
    naicsCodesExcluded: { type: "array", items: { type: "integer" } },
    names: stringArray(),
    revenue: numberRange(),
    technologies: stringArray(),
    technologiesExcluded: stringArray(),
    technologyCategories: stringArray(),
    technologyCategoriesExcluded: stringArray(),
    yearFounded: integerRange(),
  },
};

const searchPeopleFilters = {
  type: "object",
  properties: {
    countries: stringArray("Country or Surfe region codes."),
    countriesExcluded: stringArray(),
    departments: stringArray(),
    exactJobTitles: stringArray("Exact titles without semantic expansion."),
    jobChangePeriodInDays: { type: "integer", minimum: 1 },
    jobTitles: stringArray("Titles are expanded through acronym and semantic matching."),
    previousCompanyDomains: stringArray(),
    seniorities: stringArray(),
    states: { type: "array", items: state },
    statesExcluded: { type: "array", items: state },
  },
};

const personIdentifier = {
  type: "object",
  properties: {
    companyDomain: { type: "string" },
    companyName: { type: "string" },
    externalID: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    linkedinUrl: { type: "string", format: "uri" },
  },
};
const notificationOptions = {
  type: "object",
  properties: {
    webhookUrl: { type: "string", format: "uri", description: "HTTPS callback for completed enrichment results." },
  },
};

const icpCompanyFilters = {
  type: "object",
  properties: {
    departmentSizes: { type: "array", items: departmentSize },
    employeeCount: integerRange(),
    employeeCounts: { type: "array", items: integerRange() },
    excludeDomains: stringArray(),
    excludeIndustries: stringArray(),
    excludeTechnologies: stringArray(),
    includeDomains: stringArray(),
    industries: stringArray(),
    localities: { type: "array", items: locality },
    locations: stringArray(),
    primaryLocations: stringArray(),
    revenue: numberRange(),
    revenues: { type: "array", items: numberRange() },
    states: { type: "array", items: state },
    technologies: stringArray(),
    yearFounded: integerRange(),
    zipCodes: { type: "array", items: zipCode },
  },
};
const icpPeopleFilters = {
  type: "object",
  properties: {
    countries: stringArray(),
    departments: stringArray(),
    exactJobTitles: stringArray(),
    excludeDepartments: stringArray(),
    jobChangePeriodInDays: { type: "integer", minimum: 1 },
    jobTitles: stringArray(),
    previousCompanyDomains: stringArray(),
    seniorities: stringArray(),
    states: { type: "array", items: state },
  },
};

const methods = [
  {
    id: "searchPeople",
    label: "Search People",
    category: "Search",
    verb: "POST",
    path: "/v2/people/search",
    doc: "/public-009-search-people-v2",
    description: "Search people by persona and company filters. Uses pageToken pagination and charges at least one ICP search credit when charging is enabled.",
    credits: 1,
    input: {
      type: "object",
      properties: {
        companies: searchCompanyFilters,
        limit: { type: "integer", minimum: 1, maximum: 200, default: 10 },
        organizationIDMappings: { type: "object", additionalProperties: { type: "string" } },
        pageToken: { type: "string", description: "Token from nextPageToken; original filters are reused." },
        people: searchPeopleFilters,
        peoplePerCompany: { type: "integer", minimum: 1, maximum: 40 },
      },
    },
  },
  {
    id: "startPeopleEnrichment",
    label: "Enrich People (start)",
    category: "Enrich people",
    verb: "POST",
    path: "/v2/people/enrich",
    doc: "/public-015-create-people-bulk-enrichment",
    description: "Start an asynchronous enrichment job for up to 10,000 people. Returns enrichmentID and enrichmentCallbackURL; use the matching get method or a webhook for results.",
    credits: 1,
    input: {
      type: "object",
      required: ["include", "people"],
      properties: {
        enrichmentOptions: {
          type: "object",
          properties: {
            acceptedEmailType: { type: "string", enum: ["professional", "personal"] },
            skipMobileEnrichmentIfNoEmailFound: { type: "boolean" },
          },
        },
        include: {
          type: "object",
          description: "Select at least one enrichment field.",
          properties: {
            email: { type: "boolean" },
            jobHistory: { type: "boolean" },
            linkedInUrl: { type: "boolean" },
            mobile: { type: "boolean" },
          },
        },
        notificationOptions,
        people: { type: "array", minItems: 1, maxItems: 10000, items: personIdentifier },
      },
    },
  },
  {
    id: "getPeopleEnrichment",
    label: "Enrich People (get)",
    category: "Enrich people",
    verb: "GET",
    path: "/v2/people/enrich/{id}",
    doc: "/public-016-get-bulk-enrichment",
    description: "Get progress and completed results for an asynchronous people enrichment. Poll about once per second only when webhooks are unavailable.",
    credits: 0,
    input: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Enrichment ID returned by Enrich People (start)." } },
    },
  },
  {
    id: "findPeopleByEmail",
    label: "Enrich People by Email (start)",
    category: "Enrich people",
    verb: "POST",
    path: "/v2/people/find-by-email",
    doc: "/public-018-v2-people-find-by-email-post",
    description: "Start asynchronous person lookup by email. Finding a LinkedIn URL costs 10 Search credits; retrieve results with Get People Enrichment or a webhook.",
    credits: 10,
    input: {
      type: "object",
      required: ["people"],
      properties: {
        notificationOptions,
        people: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" }, externalID: { type: "string" } },
          },
        },
      },
    },
  },
  {
    id: "searchCompanies",
    label: "Search Companies",
    category: "Search",
    verb: "POST",
    path: "/v2/companies/search",
    doc: "/public-011-search-companies",
    description: "Search companies by firmographic, location, technology, and keyword filters. Uses pageToken pagination and charges by results returned when enabled.",
    credits: 1,
    input: {
      type: "object",
      required: ["filters"],
      properties: {
        filters: searchCompanyFilters,
        limit: { type: "integer", minimum: 1, maximum: 200, default: 10 },
        pageToken: { type: "string", description: "Token from nextPageToken; original filters are reused." },
      },
    },
  },
  {
    id: "startCompaniesEnrichment",
    label: "Enrich Companies (start)",
    category: "Enrich company",
    verb: "POST",
    path: "/v2/companies/enrich",
    doc: "/public-013-create-companies-enrichment",
    description: "Start asynchronous enrichment for up to 500 company domains. Paid plans charge one credit for each company returned with annual revenue and industry.",
    credits: 1,
    input: {
      type: "object",
      required: ["companies"],
      properties: {
        companies: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            required: ["domain"],
            properties: { domain: { type: "string" }, externalID: { type: "string" } },
          },
        },
        notificationOptions,
      },
    },
  },
  {
    id: "getCompaniesEnrichment",
    label: "Enrich Companies (get)",
    category: "Enrich company",
    verb: "GET",
    path: "/v2/companies/enrich/{id}",
    doc: "/public-014-get-bulk-enrichment-organizations",
    description: "Get progress and completed results for an asynchronous company enrichment job.",
    credits: 0,
    input: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Enrichment ID returned by Enrich Companies (start)." } },
    },
  },
  {
    id: "upsertRecommendationIcp",
    label: "Create or Update ICP",
    category: "Recommendations",
    verb: "POST",
    path: "/v2/recommendations/icp",
    doc: "/public-019-v2-recommendations-icp-post",
    description: "Create or replace an Ideal Customer Profile for the authenticated user or an externalUserId.",
    credits: 0,
    input: {
      type: "object",
      properties: {
        companies: icpCompanyFilters,
        externalUserId: { type: "string", maxLength: 250 },
        people: icpPeopleFilters,
      },
    },
  },
  {
    id: "fetchRecommendations",
    label: "Fetch Recommendations",
    category: "Recommendations",
    verb: "POST",
    path: "/v2/recommendations/fetch",
    doc: "/public-020-v2-recommendations-fetch-post",
    description: "Fetch daily-stable company and people recommendations matching a saved ICP. Billing is based on unique companies fetched during the month.",
    credits: 1,
    input: {
      type: "object",
      required: ["pagination"],
      properties: {
        externalUserId: { type: "string", maxLength: 255 },
        pagination: {
          type: "object",
          required: ["from", "to"],
          properties: { from: { type: "integer", minimum: 0 }, to: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
  {
    id: "getRecommendationIcps",
    label: "Get Recommendation ICP Filters",
    category: "Recommendations",
    verb: "GET",
    path: "/v2/recommendations/icp",
    query: ["externalUserId"],
    doc: "/public-021-v2-recommendations-icp-get",
    description: "Retrieve saved Ideal Customer Profile filters for the authenticated user or an externalUserId.",
    credits: 0,
    input: {
      type: "object",
      properties: { externalUserId: { type: "string", description: "External user whose saved ICPs should be returned." } },
    },
  },
  {
    id: "getCredits",
    label: "Get Credits",
    category: "Data",
    verb: "GET",
    path: "/v1/credits",
    doc: "/public-017-get-credits",
    description: "Return remaining email, mobile, and search credit balances.",
    credits: 0,
    input: { type: "object", properties: {} },
  },
  {
    id: "getFilters",
    label: "Get Filters",
    category: "Data",
    verb: "GET",
    path: "/v1/people/search/filters",
    doc: "/public-008-people-filters",
    description: "Return Surfe's predefined department, employee-count, industry, revenue, seniority, and technology filter values.",
    credits: 0,
    input: { type: "object", properties: {} },
  },
];

const [home, logo] = await Promise.all([fetch(DOCS_ROOT).then((response) => {
  if (!response.ok) throw new Error(`GET ${DOCS_ROOT} failed with HTTP ${response.status}`);
  return response.text();
}), fetch(LOGO_URL).then(async (response) => {
  if (!response.ok) throw new Error(`GET ${LOGO_URL} failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
})]);
const publicLinks = [...home.matchAll(/href="(\/public-[^"]+)"/g)].map((match) => match[1]);
const supportedLinks = [...new Set(publicLinks)];
const declaredLinks = methods.map((method) => method.doc);
const missing = supportedLinks.filter((link) => !declaredLinks.includes(link));
const stale = declaredLinks.filter((link) => !supportedLinks.includes(link));
if (missing.length || stale.length) {
  throw new Error(`Surfe endpoint catalog drifted. Missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}`);
}

await Promise.all(methods.map(async (method) => {
  const url = `${DOCS_ROOT}${method.doc}`;
  const html = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
    return response.text();
  });
  if (!html.includes(`>${method.verb}<`) || !html.includes(method.path.replace("{id}", "<string>")) && !html.includes(method.path.replace("{id}", "<your-enrichment-id>")) && !html.includes(method.path.replace("{id}", ""))) {
    throw new Error(`Surfe verb/path drift detected for ${method.id}: ${method.verb} ${method.path}`);
  }
}));

const manifest = {
  id: "surfe",
  name: "Surfe",
  version: "1.0.0",
  category: "enrichment",
  description: `Surfe people and company search, enrichment, recommendations, credits, and filters (${methods.length} endpoints).`,
  baseUrl: "https://api.surfe.com",
  logo,
  auth: {
    type: "apiKey",
    header: "Authorization",
    secretKey: "apiKey",
    credentialLabel: "API key",
    scheme: "Bearer ",
  },
  rateLimit: { rps: 10, concurrency: 3 },
  methods: methods.map(({ doc, ...method }) => ({
    ...method,
    description: `${method.description} Official docs: ${DOCS_ROOT}${doc}`,
  })),
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}\n  ${methods.length} Surfe endpoints verified against ${DOCS_ROOT}`);
