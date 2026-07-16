// Generate the bundled ZoomInfo connector from ZoomInfo's official machine-readable
// documentation. Each reference page embeds the complete OpenAPI operation and its
// component schemas, while llms.txt is the canonical endpoint index.
//
// Run: pnpm --filter @gtmgrid/engine gen:zoominfo

// The generated manifest is committed so builds and tests never depend on network
// access. Re-run this script when ZoomInfo adds or changes API reference pages.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_URL = "https://docs.zoominfo.com/llms.txt";
const LOGO_URL = "https://files.readme.io/d3656e40c59be0569b7d6a6e7eab4a2684859b047bc95b0989058a37c3dfd81a-ZI_logomark_red.svg";
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../extensions/zoominfo.json");
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return response.text();
}

async function getDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

function extractOpenApi(markdown, url) {
  const match = markdown.match(/# OpenAPI definition\s*```json\s*([\s\S]*?)```/);
  if (!match) throw new Error(`No embedded OpenAPI definition in ${url}`);
  return JSON.parse(match[1]);
}

function jsonPointer(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported external OpenAPI ref: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, part) => value?.[part], root);
}

function mergeObjectSchemas(schemas) {
  const descriptions = schemas.map((schema) => schema.description).filter(Boolean);
  const properties = Object.assign({}, ...schemas.map((schema) => schema.properties ?? {}));
  const required = [...new Set(schemas.flatMap((schema) => schema.required ?? []))];
  return {
    type: "object",
    ...(descriptions.length ? { description: descriptions.join(" ") } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.length ? { required } : {}),
    ...Object.assign({}, ...schemas.map((schema) => Object.fromEntries(
      Object.entries(schema).filter(([key]) => !["type", "description", "properties", "required"].includes(key)),
    ))),
  };
}

/** Dereference and simplify OpenAPI schemas into the JSON-Schema subset the UI renders. */
function normalizeSchema(schema, openapi, seen = new Set()) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { type: "object", description: `Recursive value (${schema.$ref})` };
    const target = jsonPointer(openapi, schema.$ref);
    if (!target) throw new Error(`Unresolved OpenAPI ref: ${schema.$ref}`);
    return normalizeSchema(target, openapi, new Set([...seen, schema.$ref]));
  }

  if (schema.allOf) {
    const normalized = schema.allOf.map((item) => normalizeSchema(item, openapi, seen));
    const combined = normalized.every((item) => item.type === "object" || item.properties)
      ? mergeObjectSchemas(normalized)
      : Object.assign({}, ...normalized);
    return normalizeSchema({
      ...combined,
      ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "allOf")),
    }, openapi, seen);
  }

  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const normalized = alternatives.map((item) => normalizeSchema(item, openapi, seen));
    if (normalized.every((item) => item.type === "object" || item.properties)) {
      // A union's fields are all useful to the mapping UI, but none is globally
      // required unless every alternative requires it.
      const merged = mergeObjectSchemas(normalized);
      const commonRequired = normalized
        .map((item) => new Set(item.required ?? []))
        .reduce((common, current) => new Set([...common].filter((key) => current.has(key))));
      return normalizeSchema({
        ...merged,
        required: [...commonRequired],
        description: schema.description ?? merged.description,
      }, openapi, seen);
    }
    return normalizeSchema({ ...normalized[0], description: schema.description ?? normalized[0]?.description }, openapi, seen);
  }

  const keep = [
    "type", "title", "description", "format", "enum", "default", "minimum", "maximum",
    "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  ];
  const out = Object.fromEntries(keep.filter((key) => schema[key] !== undefined).map((key) => [key, schema[key]]));
  if (!out.type && schema.properties) out.type = "object";
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([, value]) => !value?.readOnly)
        .map(([key, value]) => [key, normalizeSchema(value, openapi, seen)]),
    );
  }
  if (schema.required) {
    const available = new Set(Object.keys(out.properties ?? {}));
    const required = schema.required.filter((key) => available.has(key));
    if (required.length) out.required = required;
  }
  if (schema.items) out.items = normalizeSchema(schema.items, openapi, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    out.additionalProperties = normalizeSchema(schema.additionalProperties, openapi, seen);
  } else if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out;
}

function operationBaseId(operationId) {
  const tail = operationId.includes("_") ? operationId.slice(operationId.lastIndexOf("_") + 1) : operationId;
  return tail.charAt(0).toLowerCase() + tail.slice(1);
}

function namespaceFor(path) {
  return path.split("/").filter(Boolean)[0] ?? "api";
}

function categoryFor(path, summary) {
  const text = `${path} ${summary}`.toLowerCase();
  if (text.includes("contact") && text.includes("enrich")) return "Enrich people";
  if ((text.includes("compan") || text.includes("corporate")) && text.includes("enrich")) return "Enrich company";
  if (text.includes("search")) return "Search";
  if (/intent|news|scoop|pulse|insight|recommend|lookalike/.test(text)) return "Signals";
  if (/audience|folder|column|row|job/.test(text)) return "Audiences";
  if (/buyer-persona|competitor|ideal-company|customer-settings|products/.test(text)) return "GTM configuration";
  if (/lookup|usage/.test(text)) return "Data";
  return "Other";
}

function conciseDescription(operation, page, scopes) {
  const prose = String(operation.description ?? "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, (match) => match.replace(/\]\([^)]+\)/, "]"))
    .replace(/\s+/g, " ")
    .trim();
  const first = prose.split(/(?<=[.!?])\s/)[0] ?? "";
  const detail = first && first !== operation.summary ? ` ${first}` : "";
  const scope = scopes.length ? ` OAuth scope: ${scopes.join(" or ")}.` : "";
  return `${operation.summary ?? page.name}.${detail}${scope} Official docs: ${page.url}`.slice(0, 1200);
}

function operationInput(openapi, pathItem, operation) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  const properties = {};
  const required = [];
  const query = [];

  for (const parameter of parameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const normalized = normalizeSchema(parameter.schema ?? {}, openapi);
    properties[parameter.name] = parameter.description
      ? { ...normalized, description: parameter.description.replace(/\s+/g, " ").trim() }
      : normalized;
    if (parameter.required) required.push(parameter.name);
    if (parameter.in === "query") query.push(parameter.name);
  }

  let contentType;
  if (operation.requestBody) {
    const body = operation.requestBody.$ref
      ? jsonPointer(openapi, operation.requestBody.$ref)
      : operation.requestBody;
    const entries = Object.entries(body.content ?? {});
    const selected = entries.find(([type]) => type === "application/vnd.api+json")
      ?? entries.find(([type]) => type === "application/json")
      ?? entries[0];
    if (!selected) throw new Error(`${operation.operationId} declares a request body without content`);
    contentType = selected[0];
    const bodySchema = normalizeSchema(selected[1].schema ?? {}, openapi);
    if (bodySchema.type !== "object" && !bodySchema.properties) {
      throw new Error(`${operation.operationId} has unsupported non-object request body`);
    }
    Object.assign(properties, bodySchema.properties ?? {});
    required.push(...(bodySchema.required ?? []));
  }

  return {
    input: {
      type: "object",
      ...(required.length ? { required: [...new Set(required)] } : {}),
      properties,
    },
    query,
    contentType,
    hasBody: Boolean(operation.requestBody),
  };
}

const [index, logo] = await Promise.all([getText(INDEX_URL), getDataUrl(LOGO_URL)]);
const pages = [...index.matchAll(/^- \[([^\]]+)\]\((https:\/\/docs\.zoominfo\.com\/reference\/[^)]+\.md)\)/gm)]
  .map((match) => ({ name: match[1], url: match[2] }))
  .filter((page) => !page.url.endsWith("/overview.md"));

const docs = await Promise.all(pages.map(async (page) => ({
  page,
  openapi: extractOpenApi(await getText(page.url), page.url),
})));

const operations = [];
for (const { page, openapi } of docs) {
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const [verb, operation] of Object.entries(pathItem)) {
      if (!HTTP_VERBS.has(verb)) continue;
      operations.push({ page, openapi, path, pathItem, verb: verb.toUpperCase(), operation });
    }
  }
}

const idCounts = new Map();
for (const item of operations) {
  const id = operationBaseId(item.operation.operationId);
  idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
}

const methods = operations.map((item) => {
  const baseId = operationBaseId(item.operation.operationId);
  const id = idCounts.get(baseId) > 1
    ? `${namespaceFor(item.path)}${baseId.charAt(0).toUpperCase()}${baseId.slice(1)}`
    : baseId;
  const { input, query, contentType, hasBody } = operationInput(item.openapi, item.pathItem, item.operation);
  const scopes = (item.operation.security ?? item.openapi.security ?? [])
    .flatMap((entry) => Object.values(entry).flat());
  return {
    id,
    label: item.operation.summary ?? item.page.name,
    description: conciseDescription(item.operation, item.page, scopes),
    category: categoryFor(item.path, item.operation.summary ?? item.page.name),
    verb: item.verb,
    path: item.path,
    ...(query.length ? { query } : {}),
    ...(item.verb === "DELETE" && hasBody ? { body: true } : {}),
    ...(!hasBody && item.verb !== "GET" && item.verb !== "DELETE" ? { body: false } : {}),
    ...(contentType ? { contentType } : {}),
    input,
    credits: /\/data\/v1\//.test(item.path) && /enrich/.test(item.path) ? 1 : 0,
  };
});

const uniqueIds = new Set(methods.map((method) => method.id));
if (uniqueIds.size !== methods.length) throw new Error("Generated ZoomInfo method ids are not unique");

const manifest = {
  id: "zoominfo",
  name: "ZoomInfo",
  version: "1.0.0",
  category: "enrichment",
  description: `ZoomInfo GTM intelligence, enrichment, Copilot, Studio, Marketing, Platform, and Agent APIs (${methods.length} endpoints).`,
  baseUrl: "https://api.zoominfo.com/gtm",
  logo,
  auth: {
    type: "apiKey",
    header: "Authorization",
    secretKey: "apiKey",
    credentialLabel: "OAuth access token",
    scheme: "Bearer ",
  },
  // The lowest documented ZoomInfo package allows five requests per second.
  rateLimit: { rps: 5, concurrency: 3 },
  headers: { accept: "application/vnd.api+json" },
  methods,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}\n  ${methods.length} ZoomInfo endpoints from ${pages.length} reference pages`);
