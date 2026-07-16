// Generate the bundled People Data Labs connector from PDL's official OpenAPI
// repository, cross-checking the official Postman collection and adding current
// production operations that are documented outside the OpenAPI file.
// Run: pnpm --filter @gtmgrid/engine gen:peopledatalabs

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_URL = "https://raw.githubusercontent.com/peopledatalabs/openAPI-specifications/main/pdl-specs.json";
const SPEC_PAGE = "https://github.com/peopledatalabs/openAPI-specifications";
const POSTMAN_URL = "https://www.postman.com/_api/collection/32867294-ef278c05-d32d-47a1-b147-b819bc96238a/sync?since_id=0&favorite=true";
const POSTMAN_PAGE = "https://www.postman.com/pdl-official/people-data-labs-workspace/collection/u20jtn5/people-data-labs-apis-collection";
const LOGO_URL = "https://files.readme.io/4c975e465c8d72cb9bbada87a7d59ebe770f65c0593a7d2e3258708fb7ee733a-Favicon.ico";
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../extensions/peopledatalabs.json");
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function getDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

function jsonPointer(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported external OpenAPI ref: ${ref}`);
  return ref.slice(2).split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, part) => value?.[part], root);
}

function mergeObjectSchemas(schemas) {
  const properties = Object.assign({}, ...schemas.map((schema) => schema.properties ?? {}));
  const required = [...new Set(schemas.flatMap((schema) => schema.required ?? []))];
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function normalizeSchema(schema, openapi, seen = new Set(), depth = 0) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth >= 8) {
      return { type: "object", additionalProperties: true, description: `Recursive value (${schema.$ref})` };
    }
    const target = jsonPointer(openapi, schema.$ref);
    if (!target) throw new Error(`Unresolved OpenAPI ref: ${schema.$ref}`);
    return normalizeSchema(target, openapi, new Set([...seen, schema.$ref]), depth + 1);
  }
  if (schema.allOf) {
    const parts = schema.allOf.map((item) => normalizeSchema(item, openapi, seen, depth + 1));
    return normalizeSchema({
      ...mergeObjectSchemas(parts),
      ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "allOf")),
    }, openapi, seen, depth);
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const normalized = alternatives.filter((item) => item?.type !== "null")
      .map((item) => normalizeSchema(item, openapi, seen, depth + 1));
    if (normalized.every((item) => item.type === "object" || item.properties)) {
      const requiredSets = normalized.map((item) => new Set(item.required ?? []));
      const required = requiredSets.length
        ? [...requiredSets[0]].filter((key) => requiredSets.every((set) => set.has(key)))
        : [];
      return { ...mergeObjectSchemas(normalized), ...(required.length ? { required } : { required: undefined }) };
    }
    return normalized[0] ?? {};
  }

  const keep = [
    "type", "title", "description", "format", "enum", "default", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern",
    "minItems", "maxItems", "uniqueItems",
  ];
  const out = Object.fromEntries(keep.filter((key) => schema[key] !== undefined).map((key) => [key, schema[key]]));
  if (!out.type && schema.properties) out.type = "object";
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties)
      .filter(([, value]) => !value?.readOnly)
      .map(([key, value]) => [key, normalizeSchema(value, openapi, seen, depth + 1)]));
  }
  if (schema.required) {
    const available = new Set(Object.keys(out.properties ?? {}));
    const required = schema.required.filter((key) => available.has(key));
    if (required.length) out.required = required;
  }
  if (schema.items) out.items = normalizeSchema(schema.items, openapi, seen, depth + 1);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    out.additionalProperties = normalizeSchema(schema.additionalProperties, openapi, seen, depth + 1);
  } else if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out;
}

const ids = new Map(Object.entries({
  "GET /v5/person/enrich": "getPersonEnrichment",
  "POST /v5/person/enrich": "postPersonEnrichment",
  "GET /v5/person/identify": "identifyPerson",
  "GET /v5/person/search": "searchPeopleGet",
  "POST /v5/person/search": "searchPeople",
  "GET /v5/person/retrieve/{person_id}": "retrievePerson",
  "POST /v5/person/retrieve/bulk": "retrievePeopleBulk",
  "GET /v5/company/clean": "cleanCompanyGet",
  "POST /v5/company/clean": "cleanCompany",
  "GET /v5/school/clean": "cleanSchoolGet",
  "POST /v5/school/clean": "cleanSchool",
  "GET /v5/location/clean": "cleanLocationGet",
  "POST /v5/location/clean": "cleanLocation",
  "GET /v5/company/enrich": "enrichCompany",
  "GET /v5/company/search": "searchCompaniesGet",
  "POST /v5/company/search": "searchCompanies",
  "GET /v5/autocomplete": "autocompleteGet",
  "POST /v5/autocomplete": "autocomplete",
  "GET /v5/ip/enrich": "enrichIp",
  "GET /v5/job_title/enrich": "enrichJobTitleGet",
  "POST /v5/job_title/enrich": "enrichJobTitle",
  "GET /v5/skill/enrich": "enrichSkill",
  "POST /v5/person/bulk": "bulkPersonEnrichment",
  "POST /v5/company/enrich/bulk": "bulkCompanyEnrichment",
  "POST /v5/job_posting/search": "searchJobPostings",
  "POST /v5/person/changelog": "getPersonChangelog",
  "GET /v5/person/subjectrequest": "getSubjectRequests",
}));

const labels = {
  getPersonEnrichment: "Enrich Person (GET)", postPersonEnrichment: "Enrich Person (POST)",
  identifyPerson: "Identify Person", searchPeopleGet: "Search People (GET)", searchPeople: "Search People (POST)",
  retrievePerson: "Retrieve Person", retrievePeopleBulk: "Retrieve People in Bulk",
  cleanCompanyGet: "Clean Company (GET)", cleanCompany: "Clean Company (POST)",
  cleanSchoolGet: "Clean School (GET)", cleanSchool: "Clean School (POST)",
  cleanLocationGet: "Clean Location (GET)", cleanLocation: "Clean Location (POST)",
  enrichCompany: "Enrich Company", searchCompaniesGet: "Search Companies (GET)", searchCompanies: "Search Companies (POST)",
  autocompleteGet: "Autocomplete (GET)", autocomplete: "Autocomplete (POST)", enrichIp: "Enrich IP Address",
  enrichJobTitleGet: "Enrich Job Title (GET)", enrichJobTitle: "Enrich Job Title (POST)", enrichSkill: "Enrich Skill",
};

function operationInput(openapi, pathItem, operation) {
  const properties = {};
  const required = [];
  const query = [];
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    properties[parameter.name] = {
      ...normalizeSchema(parameter.schema ?? {}, openapi),
      ...(parameter.description ? { description: parameter.description.replace(/\s+/g, " ").trim() } : {}),
    };
    if (parameter.required) required.push(parameter.name);
    if (parameter.in === "query") query.push(parameter.name);
  }
  let hasBody = false;
  if (operation.requestBody) {
    hasBody = true;
    const body = operation.requestBody.$ref ? jsonPointer(openapi, operation.requestBody.$ref) : operation.requestBody;
    const selected = Object.entries(body.content ?? {}).find(([type]) => type === "application/json")
      ?? Object.entries(body.content ?? {})[0];
    if (!selected) throw new Error("Request body has no content");
    const bodySchema = normalizeSchema(selected[1].schema ?? {}, openapi);
    Object.assign(properties, bodySchema.properties ?? {});
    required.push(...(bodySchema.required ?? []));
  }
  return {
    input: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
    query,
    hasBody,
  };
}

function categoryFor(path) {
  if (path.includes("/person/")) return path.includes("search") || path.includes("identify") ? "Find people" : "Enrich people";
  if (path.includes("/company/")) return path.includes("search") ? "Find companies" : "Company data";
  if (path.includes("/clean")) return "Clean data";
  if (path.includes("job_posting")) return "Job data";
  return "Data enrichment";
}

function creditsFor(path) {
  if (path.includes("/clean") || path.includes("/autocomplete") || path.includes("/changelog") || path.includes("/subjectrequest")) return 0;
  return 1;
}

const [openapi, postman, logo] = await Promise.all([getJson(SPEC_URL), getJson(POSTMAN_URL), getDataUrl(LOGO_URL)]);
const methods = [];
for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  for (const [verbLower, operation] of Object.entries(pathItem)) {
    if (!HTTP_VERBS.has(verbLower) || operation.deprecated) continue;
    const verb = verbLower.toUpperCase();
    const key = `${verb} ${path}`;
    const id = ids.get(key);
    if (!id) throw new Error(`Missing stable method id for ${key}`);
    const { input, query, hasBody } = operationInput(openapi, pathItem, operation);
    if (id === "retrievePeopleBulk") {
      input.properties.requests = {
        type: "array", minItems: 1, maxItems: 100,
        description: "PDL person IDs to retrieve, with optional response metadata.",
        items: { type: "object", required: ["id"], properties: { id: { type: "string" }, metadata: { type: "object", additionalProperties: true } } },
      };
      input.required = [...new Set([...(input.required ?? []), "requests"])];
    }
    methods.push({
      id, label: labels[id] ?? operation.summary ?? id,
      description: `${operation.summary ?? labels[id] ?? id}. Official schema: ${SPEC_URL}`,
      category: categoryFor(path), verb, path, ...(query.length ? { query } : {}),
      ...(!hasBody && verb !== "GET" && verb !== "DELETE" ? { body: false } : {}),
      input, credits: creditsFor(path),
    });
  }
}

const personGet = methods.find((method) => method.id === "getPersonEnrichment");
const companyGet = methods.find((method) => method.id === "enrichCompany");
const manual = [
  {
    id: "postPersonEnrichment", label: "Enrich Person (POST)", path: "/v5/person/enrich", category: "Enrich people",
    description: "Enrich one person using a JSON request body. Official docs: https://docs.peopledatalabs.com/docs/reference-person-enrichment-api",
    input: personGet.input, credits: 1,
  },
  {
    id: "bulkPersonEnrichment", label: "Bulk Person Enrichment", path: "/v5/person/bulk", category: "Enrich people",
    description: "Enrich 1–100 people in one request; credits are charged per successful match. Official docs: https://docs.peopledatalabs.com/docs/bulk-enrichment-api",
    input: { type: "object", required: ["requests"], properties: {
      requests: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["params"], properties: {
        params: { type: "object", additionalProperties: true, description: "Person enrichment parameters." },
        metadata: { type: "object", additionalProperties: true, description: "Caller metadata returned with the matching response." },
      } } },
      data_include: { type: "string" }, required: { type: "string" }, min_likelihood: { type: "integer", minimum: 1, maximum: 10 },
      include_if_matched: { type: "boolean" }, titlecase: { type: "boolean" }, pretty: { type: "boolean" },
    } }, credits: 1,
  },
  {
    id: "bulkCompanyEnrichment", label: "Bulk Company Enrichment", path: "/v5/company/enrich/bulk", category: "Company data",
    description: "Enrich 1–100 companies in one request; credits are charged per successful match. Official docs: https://docs.peopledatalabs.com/docs/bulk-company-enrichment-api",
    input: { type: "object", required: ["requests"], properties: {
      requests: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["params"], properties: {
        params: { ...companyGet.input, description: "Company enrichment parameters." },
        metadata: { type: "object", additionalProperties: true },
      } } },
    } }, credits: 1,
  },
  {
    id: "searchJobPostings", label: "Search Job Postings", path: "/v5/job_posting/search", category: "Job data",
    description: "Search PDL job postings with field filters or Elasticsearch; one credit is charged per record. Official docs: https://docs.peopledatalabs.com/docs/reference-job-posting-search-api",
    rateLimit: { rpm: 20, concurrency: 1 },
    input: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" }, title_class: { type: "string" }, title_role: { type: "string" },
      title_sub_role: { type: "string" }, title_levels: { type: "string" }, company_id: { type: "string" }, company_name: { type: "string" },
      company_website: { type: "string" }, company_linkedin_url: { type: "string" }, location: { type: "string" }, description: { type: "string" },
      salary_min: { type: "integer" }, salary_max: { type: "integer" }, salary_currency: { type: "string" }, salary_period: { type: "string" },
      remote_work_policy: { type: "string" }, inferred_skills: { type: "string" }, active_only: { type: "boolean", default: false },
      query: { type: "object", additionalProperties: true, description: "Elasticsearch 7.7 query; overrides field filters." },
      size: { type: "integer", minimum: 1, maximum: 100, default: 10 }, scroll_token: { type: "string" },
    } }, credits: 1,
  },
  {
    id: "getPersonChangelog", label: "Get Person Changelog", path: "/v5/person/changelog", category: "Person data",
    description: "Get record changes between consecutive PDL dataset versions. Official docs: https://docs.peopledatalabs.com/docs/reference-person-changelog-api",
    input: { type: "object", required: ["origin_version", "current_version"], properties: {
      origin_version: { type: "number", description: "Older PDL dataset version." }, current_version: { type: "number", description: "Newer consecutive PDL dataset version." },
      type: { type: "string", enum: ["added", "deleted", "updated", "merged", "opted_out"] },
      ids: { type: "array", minItems: 1, maxItems: 59999, items: { type: "string" } },
      fields_updated: { type: "array", items: { type: "string" } }, scroll_token: { type: "string" },
    } }, credits: 0,
  },
  {
    id: "getSubjectRequests", label: "Get Subject Requests", verb: "GET", path: "/v5/person/subjectrequest", category: "Compliance",
    description: "Stream PDL IDs affected by privacy subject requests. Official docs: https://docs.peopledatalabs.com/docs/subject-request-api",
    input: { type: "object", properties: {} }, credits: 0,
  },
].map((method) => ({ verb: "POST", ...method }));
methods.push(...manual);

const requestSet = new Set(methods.map((method) => `${method.verb} ${method.path}`));
const postmanRequests = postman.entities?.[0]?.data?.requests ?? [];
for (const request of postmanRequests) {
  const path = String(request.url).replace(/^\{\{baseUrl\}\}/, "").split("?")[0];
  if (!requestSet.has(`${request.method} ${path}`)) throw new Error(`Official Postman request is missing: ${request.method} ${path}`);
}
if (methods.length !== 27 || new Set(methods.map((method) => method.id)).size !== 27 || requestSet.size !== 27) {
  throw new Error(`Expected 27 unique PDL operations; generated ${methods.length}`);
}

const manifest = {
  id: "peopledatalabs",
  name: "People Data Labs",
  version: "1.0.0",
  category: "enrichment",
  description: `People, company, search, cleaning, autocomplete, IP, job-title, skill, job-posting, changelog, and privacy APIs (${methods.length} production operations).`,
  baseUrl: "https://api.peopledatalabs.com",
  logo,
  auth: { type: "apiKey", header: "X-Api-Key", secretKey: "apiKey", credentialLabel: "API key", scheme: "" },
  rateLimit: { rpm: 100, concurrency: 3 },
  methods,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}\n  ${methods.length} production operations\n  verified all ${postmanRequests.length} official Postman requests\n  sources: ${SPEC_PAGE}, ${POSTMAN_PAGE}`);
