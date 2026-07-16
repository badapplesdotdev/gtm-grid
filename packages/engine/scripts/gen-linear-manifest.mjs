// Generate the bundled Linear connector from Linear's public GraphQL schema.
// Linear exposes one GraphQL endpoint, but every active Query and Mutation root
// field is a distinct callable operation in GTM Grid. The generated manifest is
// committed so production builds never introspect the network at runtime.
//
// Run: pnpm --filter @gtmgrid/engine gen:linear

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.linear.app/graphql";
const DOCS_URL = "https://linear.app/developers/graphql";
const LOGO_URL = "https://linear.app/static/favicon.svg?v=2";
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../../extensions/linear.json");

const TYPE_REF = `
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
`;

async function graphQL(query) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    const detail = payload.errors?.map((error) => error.message).join("; ") ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload.data;
}

async function getDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/svg+xml";
  return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

const ROOT_FIELDS = `
  fields(includeDeprecated: true) {
    name description isDeprecated deprecationReason
    args { name description defaultValue type { ${TYPE_REF} } }
    type { ${TYPE_REF} }
  }
`;

const TYPE_DETAIL = `
  kind name description
  fields(includeDeprecated: true) {
    name description isDeprecated
    args { name description defaultValue type { ${TYPE_REF} } }
    type { ${TYPE_REF} }
  }
  inputFields(includeDeprecated: true) {
    name description isDeprecated defaultValue type { ${TYPE_REF} }
  }
  enumValues(includeDeprecated: true) { name description isDeprecated }
`;

function escapeGraphqlString(value) {
  return JSON.stringify(value);
}

async function fetchTypeBatch(names) {
  if (!names.length) return [];
  const query = `query LinearConnectorTypes { ${names
    .map((name, index) => `t${index}: __type(name: ${escapeGraphqlString(name)}) { ${TYPE_DETAIL} }`)
    .join("\n")} }`;
  try {
    const data = await graphQL(query);
    return names.map((name, index) => [name, data[`t${index}`]]);
  } catch (error) {
    if (names.length === 1) throw new Error(`Could not introspect Linear type ${names[0]}: ${error.message}`);
    const middle = Math.ceil(names.length / 2);
    return [
      ...(await fetchTypeBatch(names.slice(0, middle))),
      ...(await fetchTypeBatch(names.slice(middle))),
    ];
  }
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function unwrap(ref) {
  let current = ref;
  while (current?.kind === "NON_NULL" || current?.kind === "LIST") current = current.ofType;
  return current;
}

function typeString(ref) {
  if (!ref) return "String";
  if (ref.kind === "NON_NULL") return `${typeString(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${typeString(ref.ofType)}]`;
  return ref.name;
}

function isRequired(field) {
  return field.type?.kind === "NON_NULL" && field.defaultValue == null;
}

const scalarSchemas = {
  Boolean: { type: "boolean" },
  Int: { type: "integer" },
  Float: { type: "number" },
  ID: { type: "string" },
  String: { type: "string" },
  UUID: { type: "string", format: "uuid" },
  DateTime: { type: "string", format: "date-time" },
  DateTimeOrDuration: { type: "string" },
  Date: { type: "string", format: "date" },
  TimelessDate: { type: "string", format: "date" },
  URL: { type: "string", format: "uri" },
  JSON: { type: "object", additionalProperties: true },
  JSONObject: { type: "object", additionalProperties: true },
};

function inputSchema(ref, types, seen = new Set(), depth = 0) {
  if (!ref) return {};
  if (ref.kind === "NON_NULL") return inputSchema(ref.ofType, types, seen, depth);
  if (ref.kind === "LIST") return { type: "array", items: inputSchema(ref.ofType, types, seen, depth) };
  const name = ref.name;
  const type = types.get(name);
  if (ref.kind === "SCALAR") return { ...(scalarSchemas[name] ?? { type: "string" }), ...(type?.description ? { description: type.description } : {}) };
  if (ref.kind === "ENUM") {
    const values = (type?.enumValues ?? []).filter((value) => !value.isDeprecated).map((value) => value.name);
    return { type: "string", ...(values.length ? { enum: values } : {}), ...(type?.description ? { description: type.description } : {}) };
  }
  if (ref.kind !== "INPUT_OBJECT" || !type) return { type: "object", additionalProperties: true };
  // Linear's filter inputs recursively compose `and`/`or` branches across a
  // very large schema. Expanding those trees independently into 516 method
  // schemas grows exponentially. Two typed levels cover normal form fields;
  // deeper branches remain valid arbitrary JSON objects.
  if (seen.has(name) || depth >= 2) return {
    type: "object",
    additionalProperties: true,
    description: type.description ?? `Nested ${name} input.`,
  };
  const nextSeen = new Set([...seen, name]);
  const fields = (type.inputFields ?? []).filter((field) => !field.isDeprecated);
  const properties = Object.fromEntries(fields.map((field) => [
    field.name,
    {
      ...inputSchema(field.type, types, nextSeen, depth + 1),
      ...(field.description ? { description: field.description.replace(/\s+/g, " ").trim() } : {}),
      ...(field.defaultValue != null ? { default: field.defaultValue } : {}),
    },
  ]));
  const required = fields.filter(isRequired).map((field) => field.name);
  return {
    type: "object",
    ...(type.description ? { description: type.description.replace(/\s+/g, " ").trim() } : {}),
    properties,
    ...(required.length ? { required } : {}),
  };
}

function canOmitArguments(field) {
  return (field.args ?? []).every((argument) => !isRequired(argument));
}

function selectionFor(ref, types, depth = 0, seen = new Set()) {
  const named = unwrap(ref);
  if (!named || named.kind === "SCALAR" || named.kind === "ENUM") return "";
  if (named.kind === "UNION" || named.kind === "INTERFACE") return "{ __typename }";
  const type = types.get(named.name);
  if (!type || seen.has(named.name)) return "{ __typename }";
  const fields = (type.fields ?? []).filter((field) => !field.isDeprecated && canOmitArguments(field));
  const scalarFields = fields.filter((field) => {
    const result = unwrap(field.type);
    return result?.kind === "SCALAR" || result?.kind === "ENUM";
  });
  const preferred = ["id", "identifier", "name", "title", "url", "createdAt", "updatedAt", "success", "lastSyncId"];
  const orderedScalars = [...scalarFields].sort((a, b) => {
    const ai = preferred.indexOf(a.name);
    const bi = preferred.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.name.localeCompare(b.name);
  });
  const selected = orderedScalars.slice(0, 20).map((field) => field.name);
  if (depth < 2) {
    const nestedPriority = ["nodes", "pageInfo", "issue", "project", "team", "user", "comment", "customer"];
    const nested = fields.filter((field) => {
      const result = unwrap(field.type);
      return result && !["SCALAR", "ENUM"].includes(result.kind);
    }).sort((a, b) => {
      const ai = nestedPriority.indexOf(a.name);
      const bi = nestedPriority.indexOf(b.name);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.name.localeCompare(b.name);
    });
    for (const field of nested.slice(0, depth === 0 ? 5 : 2)) {
      const child = selectionFor(field.type, types, depth + 1, new Set([...seen, named.name]));
      if (child) selected.push(`${field.name} ${child}`);
    }
  }
  return `{ ${selected.length ? selected.join(" ") : "__typename"} }`;
}

function humanize(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function categoryFor(name) {
  const value = name.toLowerCase();
  if (/issue|comment|attachment|label/.test(value)) return "Issues";
  if (/project|initiative|milestone|roadmap/.test(value)) return "Projects";
  if (/team|workflowstate/.test(value)) return "Teams";
  if (/user|member|organization|workspace/.test(value)) return "Users & workspace";
  if (/customer/.test(value)) return "Customers";
  if (/cycle/.test(value)) return "Cycles";
  if (/document|template/.test(value)) return "Documents";
  if (/webhook/.test(value)) return "Webhooks";
  if (/integration|oauth|github|slack|jira/.test(value)) return "Integrations";
  if (/agent|session/.test(value)) return "Agents";
  return "Other";
}

const [rootData, typeIndex, logo] = await Promise.all([
  graphQL(`query LinearConnectorRoots {
    query: __type(name: "Query") { ${ROOT_FIELDS} }
    mutation: __type(name: "Mutation") { ${ROOT_FIELDS} }
  }`),
  graphQL("query LinearConnectorTypeIndex { __schema { types { name kind } } }"),
  getDataUrl(LOGO_URL),
]);

const typeNames = typeIndex.__schema.types
  .filter((type) => type.name && !type.name.startsWith("__") && !["Query", "Mutation"].includes(type.name))
  .map((type) => type.name);
const types = new Map([
  ["Query", { kind: "OBJECT", name: "Query", ...rootData.query }],
  ["Mutation", { kind: "OBJECT", name: "Mutation", ...rootData.mutation }],
]);
for (const batch of chunks(typeNames, 8)) {
  for (const [name, detail] of await fetchTypeBatch(batch)) if (detail) types.set(name, detail);
}

function methodFor(operation, field) {
  const args = field.args ?? [];
  const properties = Object.fromEntries(args.map((argument) => [
    argument.name,
    {
      ...inputSchema(argument.type, types),
      ...(argument.description ? { description: argument.description.replace(/\s+/g, " ").trim() } : {}),
    },
  ]));
  const required = args.filter(isRequired).map((argument) => argument.name);
  const id = `${operation}_${field.name}`;
  const summary = field.description?.replace(/\s+/g, " ").trim() ?? `${humanize(field.name)} Linear ${operation}.`;
  return {
    id,
    label: `${operation === "query" ? "Get" : "Run"} ${humanize(field.name)}`,
    description: `${summary} Official schema: ${DOCS_URL}`.slice(0, 1600),
    category: categoryFor(field.name),
    verb: "POST",
    path: "/graphql",
    input: { type: "object", properties, ...(required.length ? { required } : {}) },
    graphql: {
      operation,
      field: field.name,
      variables: Object.fromEntries(args.map((argument) => [argument.name, typeString(argument.type)])),
      selection: selectionFor(field.type, types),
    },
    credits: 0,
  };
}

const activeQueries = rootData.query.fields.filter((field) => !field.isDeprecated);
const activeMutations = rootData.mutation.fields.filter((field) => !field.isDeprecated);
const methods = [
  {
    id: "executeGraphQL",
    label: "Execute custom GraphQL",
    description: `Run a custom Linear GraphQL operation for advanced selections or schema additions. Official schema: ${DOCS_URL}`,
    category: "Advanced",
    verb: "POST",
    path: "/graphql",
    input: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Complete GraphQL query or mutation." },
        variables: { type: "object", additionalProperties: true, description: "GraphQL variables keyed by variable name." },
        operationName: { type: "string", description: "Optional operation name when the document contains multiple operations." },
      },
    },
    graphql: { custom: true },
    credits: 0,
  },
  ...activeQueries.map((field) => methodFor("query", field)),
  ...activeMutations.map((field) => methodFor("mutation", field)),
];

const manifest = {
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  category: "project-management",
  description: `Linear issues, projects, teams, cycles, customers, documents, integrations, agents, and administration through all ${activeQueries.length + activeMutations.length} active GraphQL root operations.`,
  baseUrl: "https://api.linear.app",
  logo,
  auth: {
    type: "apiKey",
    header: "Authorization",
    secretKey: "apiKey",
    credentialLabel: "personal API key",
    scheme: "",
  },
  rateLimit: { rpm: 40, concurrency: 2 },
  methods,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}\n  ${activeQueries.length} active queries\n  ${activeMutations.length} active mutations\n  ${methods.length} callable methods`);
