// Generate the bundled TheirStack connector from TheirStack's official OpenAPI
// 3.1 document. Active operations are committed into the app; deprecated
// operations remain discoverable upstream but are omitted from the catalog.
// Run: pnpm --filter @gtmgrid/engine gen:theirstack

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_URL = "https://api.theirstack.com/openapi.json";
const LOGO_URL = "https://theirstack.com/static/generated/favicon-32x32.png";
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../extensions/theirstack.json");
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
  const sets = schemas.map((schema) => new Set(schema.required ?? []));
  const required = sets.length ? [...sets[0]].filter((key) => sets.every((set) => set.has(key))) : [];
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function normalizeSchema(schema, openapi, seen = new Set(), depth = 0) {
  if (schema === true) return {};
  if (schema === false || !schema || typeof schema !== "object") return {};
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
    const merged = parts.every((item) => item.type === "object" || item.properties)
      ? mergeObjectSchemas(parts)
      : Object.assign({}, ...parts);
    return normalizeSchema({
      ...merged,
      ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "allOf")),
    }, openapi, seen, depth);
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const nonNull = alternatives.filter((item) => item?.type !== "null");
    const normalized = (nonNull.length ? nonNull : alternatives)
      .map((item) => normalizeSchema(item, openapi, seen, depth + 1));
    if (normalized.every((item) => item.type === "object" || item.properties)) {
      return { ...mergeObjectSchemas(normalized), ...(schema.description ? { description: schema.description } : {}) };
    }
    return { ...normalized[0], ...(schema.description ? { description: schema.description } : {}) };
  }

  const keep = [
    "type", "title", "description", "format", "enum", "const", "default",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  ];
  const out = Object.fromEntries(keep.filter((key) => schema[key] !== undefined).map((key) => [key, schema[key]]));
  if (Array.isArray(out.type)) out.type = out.type.find((type) => type !== "null");
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

function operationInput(openapi, pathItem, operation) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  const properties = {};
  const required = [];
  const query = [];
  for (const parameter of parameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    properties[parameter.name] = {
      ...normalizeSchema(parameter.schema ?? {}, openapi),
      ...(parameter.description ? { description: parameter.description.replace(/\s+/g, " ").trim() } : {}),
    };
    if (parameter.required) required.push(parameter.name);
    if (parameter.in === "query") query.push(parameter.name);
  }

  let contentType;
  let hasBody = false;
  if (operation.requestBody) {
    hasBody = true;
    const body = operation.requestBody.$ref ? jsonPointer(openapi, operation.requestBody.$ref) : operation.requestBody;
    const entries = Object.entries(body.content ?? {});
    const selected = entries.find(([type]) => type === "application/json")
      ?? entries.find(([type]) => type === "application/x-www-form-urlencoded")
      ?? entries[0];
    if (!selected) throw new Error(`${operation.operationId} declares a request body without content`);
    contentType = selected[0];
    const bodySchema = normalizeSchema(selected[1].schema ?? {}, openapi);
    if (bodySchema.type !== "object" && !bodySchema.properties && bodySchema.additionalProperties !== true) {
      throw new Error(`${operation.operationId} has unsupported non-object request body`);
    }
    Object.assign(properties, bodySchema.properties ?? {});
    required.push(...(bodySchema.required ?? []));
  }
  return {
    input: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
    query,
    contentType,
    hasBody,
  };
}

function descriptionFor(operation) {
  const prose = String(operation.description ?? "").replace(/\s+/g, " ").trim();
  const first = prose.split(/(?<=[.!?])\s/)[0] ?? "";
  const summary = operation.summary ?? operation.operationId;
  return `${summary}.${first && first !== summary ? ` ${first}` : ""} Official schema: ${SPEC_URL}`.slice(0, 1600);
}

function creditsFor(id) {
  if (id === "search_jobs_v1") return 1;
  if (["search_companies_v1", "technographics_v1", "buying_intents_v1"].includes(id)) return 3;
  return 0;
}

const [openapi, logo] = await Promise.all([getJson(SPEC_URL), getDataUrl(LOGO_URL)]);
const operations = [];
for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  for (const [verb, operation] of Object.entries(pathItem)) {
    if (!HTTP_VERBS.has(verb) || operation.deprecated) continue;
    operations.push({ path, pathItem, verb: verb.toUpperCase(), operation });
  }
}

const methods = operations.map(({ path, pathItem, verb, operation }) => {
  const { input, query, contentType, hasBody } = operationInput(openapi, pathItem, operation);
  const security = operation.security ?? openapi.security ?? [];
  const tiered = ["search_jobs_v1", "search_companies_v1", "technographics_v1"].includes(operation.operationId);
  return {
    id: operation.operationId,
    label: operation.summary ?? operation.operationId,
    description: descriptionFor(operation),
    category: operation.tags?.[0] ?? "Other",
    verb,
    path,
    ...(query.length ? { query } : {}),
    ...(!hasBody && verb !== "GET" && verb !== "DELETE" ? { body: false } : {}),
    ...(verb === "DELETE" && hasBody ? { body: true } : {}),
    ...(contentType ? { contentType } : {}),
    ...(!security.length ? { auth: false } : {}),
    ...(tiered ? { rateLimit: { rpm: 10, concurrency: 1 } } : {}),
    input,
    credits: creditsFor(operation.operationId),
  };
});

if (new Set(methods.map((method) => method.id)).size !== methods.length) {
  throw new Error("Generated TheirStack method ids are not unique");
}

const deprecatedCount = Object.values(openapi.paths).flatMap((item) => Object.values(item))
  .filter((operation) => operation?.deprecated).length;
const manifest = {
  id: "theirstack",
  name: "TheirStack",
  version: "1.0.0",
  category: "enrichment",
  description: `TheirStack jobs, companies, technographics, buying intent, lists, datasets, catalogs, saved searches, requests, preferences, billing, and webhooks (${methods.length} active endpoints).`,
  baseUrl: "https://api.theirstack.com",
  logo,
  auth: {
    type: "apiKey",
    header: "Authorization",
    secretKey: "apiKey",
    credentialLabel: "API key",
    scheme: "Bearer ",
  },
  rateLimit: { rps: 4, concurrency: 2 },
  methods,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}\n  ${methods.length} active endpoints from ${Object.keys(openapi.paths).length} paths\n  omitted ${deprecatedCount} deprecated operation`);
