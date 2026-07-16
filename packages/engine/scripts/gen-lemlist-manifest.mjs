// Generate the bundled Lemlist connector from Lemlist's official OpenAPI v2
// document and reconcile it against every endpoint page in llms.txt.
// Run: pnpm --filter @gtmgrid/engine gen:lemlist

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_URL = "https://developer.lemlist.com/llms.txt";
const SPEC_URL = "https://developer.lemlist.com/api-reference/openapi/v2.json";
const LOGO_URL = "https://developer.lemlist.com/mintlify-assets/_mintlify/favicons/lemlist/me0cPoV7UJ7b682L/_generated/favicon/android-chrome-192x192.png";
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../extensions/lemlist.json");
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

async function getText(url) {
  const response = await fetch(url, { headers: { "user-agent": "gtmgrid-manifest-generator/1.0" } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return response.text();
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

async function getDataUrl(url) {
  const response = await fetch(url, { headers: { "user-agent": "gtmgrid-manifest-generator/1.0" } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  const type = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

function jsonPointer(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported external OpenAPI ref: ${ref}`);
  return ref.slice(2).split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, part) => value?.[part], root);
}

function dereference(value, openapi) {
  return value?.$ref ? jsonPointer(openapi, value.$ref) : value;
}

function mergeObjectSchemas(schemas, commonRequired = false) {
  const properties = Object.assign({}, ...schemas.map((schema) => schema.properties ?? {}));
  const requiredSets = schemas.map((schema) => new Set(schema.required ?? []));
  const required = commonRequired && requiredSets.length
    ? [...requiredSets[0]].filter((key) => requiredSets.every((set) => set.has(key)))
    : [...new Set(schemas.flatMap((schema) => schema.required ?? []))];
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function normalizeSchema(schema, openapi, seen = new Set(), depth = 0) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth >= 10) {
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
      return { ...mergeObjectSchemas(normalized, true), ...(schema.description ? { description: schema.description } : {}) };
    }
    return normalized[0]
      ? { ...normalized[0], ...(schema.description ? { description: schema.description } : {}) }
      : schema.description ? { description: schema.description } : {};
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

function camelSlug(slug) {
  return slug.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+(.)/g, (_, char) => char.toUpperCase());
}

function operationInput(openapi, pathItem, operation) {
  const properties = {};
  const required = [];
  const query = [];
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = dereference(raw, openapi);
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    properties[parameter.name] = {
      ...normalizeSchema(parameter.schema ?? {}, openapi),
      ...(parameter.description ? { description: parameter.description.replace(/\s+/g, " ").trim() } : {}),
    };
    if (parameter.required) required.push(parameter.name);
    if (parameter.in === "query") query.push(parameter.name);
  }

  let hasBody = false;
  let contentType;
  let bodyFrom;
  if (operation.requestBody) {
    hasBody = true;
    const requestBody = dereference(operation.requestBody, openapi);
    const entries = Object.entries(requestBody.content ?? {});
    const selected = entries.find(([type]) => type === "application/json")
      ?? entries.find(([type]) => type === "multipart/form-data") ?? entries[0];
    if (!selected) throw new Error(`${operation.summary} declares a body without content`);
    contentType = selected[0];
    const bodySchema = normalizeSchema(selected[1].schema ?? {}, openapi);
    if (bodySchema.type === "object" || bodySchema.properties) {
      Object.assign(properties, bodySchema.properties ?? {});
      required.push(...(bodySchema.required ?? []));
    } else {
      bodyFrom = "items";
      properties.items = { ...bodySchema, description: bodySchema.description ?? "Top-level request payload." };
      required.push("items");
    }
  }
  return {
    input: { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
    query, hasBody, contentType, bodyFrom,
  };
}

const [index, openapi, logo] = await Promise.all([getText(INDEX_URL), getJson(SPEC_URL), getDataUrl(LOGO_URL)]);
const pageUrls = [...index.matchAll(/^- \[[^\]]+\]\((https:\/\/developer\.lemlist\.com\/api-reference\/endpoints\/[^)]+\.md)\)/gm)]
  .map((match) => match[1]);
if (pageUrls.length !== 139) throw new Error(`Expected 139 endpoint pages in llms.txt; found ${pageUrls.length}`);

const pageEntries = await mapLimit(pageUrls, 12, async (url) => {
  const markdown = await getText(url);
  const operation = markdown.match(/^````?yaml (get|post|put|patch|delete) ([^\s]+)$/m);
  if (!operation) throw new Error(`No OpenAPI operation header in ${url}`);
  const slug = url.split("/").pop();
  return { key: `${operation[1].toUpperCase()} ${operation[2]}`, url, id: camelSlug(slug) };
});
const pageByRequest = new Map(pageEntries.map((entry) => [entry.key, entry]));
if (pageByRequest.size !== 139) throw new Error("Endpoint pages do not map to 139 unique operations");

const methods = [];
for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  for (const [verbLower, operation] of Object.entries(pathItem)) {
    if (!HTTP_VERBS.has(verbLower)) continue;
    const verb = verbLower.toUpperCase();
    const requestKey = `${verb} ${path}`;
    const page = pageByRequest.get(requestKey);
    const id = page?.id ?? (requestKey === "DELETE /campaigns/{campaignId}/leads/"
      ? "unsubscribeAllCampaignLeads" : null);
    if (!id) throw new Error(`OpenAPI operation has no endpoint page mapping: ${requestKey}`);
    const { input, query, hasBody, contentType, bodyFrom } = operationInput(openapi, pathItem, operation);
    methods.push({
      id,
      label: operation.summary ?? id,
      description: `${operation.summary ?? id}.${operation.deprecated ? " Deprecated by Lemlist; prefer the corresponding v2 unsubscribe operation." : ""} Official docs: ${page?.url ?? SPEC_URL}`,
      category: operation.tags?.[0] ?? "Other",
      verb,
      path,
      ...(query.length ? { query } : {}),
      ...(!hasBody && verb !== "GET" && verb !== "DELETE" ? { body: false } : {}),
      ...(hasBody && verb === "DELETE" ? { body: true } : {}),
      ...(contentType ? { contentType } : {}),
      ...(bodyFrom ? { bodyFrom } : {}),
      input,
      credits: 1,
    });
  }
}

const requestSet = new Set(methods.map((method) => `${method.verb} ${method.path}`));
for (const page of pageEntries) {
  if (!requestSet.has(page.key)) throw new Error(`Documented endpoint is missing from OpenAPI: ${page.key}`);
}
if (methods.length !== 140 || requestSet.size !== 140 || new Set(methods.map((method) => method.id)).size !== 140) {
  throw new Error(`Expected 140 unique Lemlist operations; generated ${methods.length}`);
}

const manifest = {
  id: "lemlist",
  name: "Lemlist",
  version: "1.0.0",
  category: "sales-engagement",
  description: `Lemlist campaigns, leads, CRM, inbox, enrichment, deliverability, sequences, tasks, signals, webhooks, and account APIs (${methods.length} operations).`,
  baseUrl: "https://api.lemlist.com/api",
  logo,
  auth: {
    type: "apiKey", header: "Authorization", secretKey: "apiKey", credentialLabel: "API key",
    scheme: "Basic ", basicUsername: "",
  },
  rateLimit: { rps: 10, concurrency: 3 },
  methods,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}\n  ${methods.length} unique operations across ${Object.keys(openapi.paths).length} paths\n  verified all ${pageEntries.length} endpoint pages from llms.txt\n  included 1 additional official OpenAPI operation`);
