// JSON-manifest extension loader — Revcode's "Upload manifest" model.
// An extension is pure data: a connector whose methods declare an HTTP request
// and a JSON-Schema input. One manifest → callable sdk methods + MCP tools + UI.

import { z } from "zod";
import { fetchWithRetry } from "../http-retry.js";
import type { Connector, ConnectorMethod, MethodContext, RateLimit } from "../types.js";

/** A live-options source for one input field (pick by name → store the id). */
const fieldOptionSourceSchema = z.object({
  /** A method id ON THIS CONNECTOR that returns the list of choices. */
  method: z.string(),
  /** Dot-path to the array in the source response (default: items/data/results, or the response if it is itself an array). */
  itemsPath: z.string().optional(),
  /** Key on each item for the display label (default: name|title|label). */
  labelKey: z.string().optional(),
  /** Key on each item for the stored value (default: id|uuid|_id|value). */
  valueKey: z.string().optional(),
  /** Optional key for a secondary line under the label. */
  sublabelKey: z.string().optional(),
  /** Static args passed to the source method call (e.g. { limit: 100 }). */
  args: z.record(z.string(), z.any()).optional(),
});

/** Outbound throttle — spreads a large run over time per the upstream API limits. */
const rateLimitSchema = z.object({
  rps: z.number().positive().optional(),
  rpm: z.number().positive().optional(),
  concurrency: z.number().int().positive().optional(),
});

const methodSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]+$/, "method id must be alphanumeric/underscore"),
  label: z.string().optional(),
  description: z.string(),
  /** Functions-gallery category for THIS method (e.g. "Enrich people",
   *  "Find email", "Signals"). A connector's methods span many use cases, so
   *  the category is per-method, not per-connector. Omitted/unknown → the
   *  method is listed under "All" only. */
  category: z.string().optional(),
  verb: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  /** JSON Schema for inputs (object). Surfaced to agents + UI as-is. */
  input: z.record(z.string(), z.any()).optional(),
  /**
   * Fields whose value is PICKED from a live list the connector can fetch
   * (field id → option source). The UI renders a searchable name-dropdown that
   * resolves to the stored id — so e.g. an Instantly `campaign` field is picked
   * by campaign name instead of pasting a UUID. The `method` must be another
   * method on this same connector that returns the list of choices.
   */
  options: z.record(z.string(), fieldOptionSourceSchema).optional(),
  /** Per-method outbound throttle override (stricter than the connector default). */
  rateLimit: rateLimitSchema.optional(),
  /** Input fields sent in the query string (bodyless methods default to all non-path fields). */
  query: z.array(z.string()).optional(),
  /** Send a JSON request body even for verbs that are normally bodyless (notably DELETE). */
  body: z.boolean().optional(),
  /** Content type for a JSON request body (default: application/json). */
  contentType: z.string().optional(),
  /** Override connector-level authentication for a public method. */
  auth: z.boolean().optional(),
  /** Build a GraphQL operation from this method's inputs. Generated operations
   * declare a root field + variable types + selection set; `custom` passes a
   * caller-provided query/variables pair through the same error-aware runtime. */
  graphql: z
    .object({
      custom: z.boolean().optional(),
      operation: z.enum(["query", "mutation"]).optional(),
      field: z.string().optional(),
      variables: z.record(z.string(), z.string()).optional(),
      selection: z.string().optional(),
    })
    .optional(),
  /** For body verbs: input fields to omit from the JSON body. */
  bodyOmit: z.array(z.string()).optional(),
  /** Send one input field as the entire request body (for top-level arrays/scalars). */
  bodyFrom: z.string().optional(),
  credits: z.number().optional(),
  batchSize: z.number().optional(),
  /**
   * Async-job convenience. When set, this method STARTS a job (its own verb/path),
   * then polls a sibling `statusMethod` until the job reaches `doneWhen` (or a
   * `failWhen` state / timeout), returning the job's data. The whole poll runs
   * HOST-SIDE in one connector call, so it is not bound by the in-sandbox per-cell
   * timeout — the right shape for "start extract → wait for completion" APIs.
   */
  poll: z
    .object({
      /** Sibling method id whose GET returns the job status (e.g. "getExtractStatus"). */
      statusMethod: z.string(),
      /** Dot-path to the job id in THIS method's start response (default "id"; also tries "data.id"). */
      idFrom: z.string().optional(),
      /** Param name the status method expects the id under (default "id"). */
      idParam: z.string().optional(),
      /** Dot-path to the status string in the status response (default "status"; also tries "data.status"). */
      statusFrom: z.string().optional(),
      /** Status value that means "done" (default "completed"). */
      doneWhen: z.string().optional(),
      /** Status values that mean "give up and throw" (default ["failed","cancelled"]). */
      failWhen: z.array(z.string()).optional(),
      /** Dot-path to the result payload in the status response (default "data"). */
      dataFrom: z.string().optional(),
      /** Delay between polls in ms (default 3000). */
      intervalMs: z.number().optional(),
      /** Overall wait budget in ms before throwing a timeout (default 300000). */
      timeoutMs: z.number().optional(),
    })
    .optional(),
});

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, "extension id must be lowercase kebab/underscore"),
  name: z.string(),
  version: z.string().optional(),
  category: z.string().optional(),
  /** Short description shown in the extensions gallery. */
  description: z.string().optional(),
  /** Optional brand logo URL; falls back to a derived favicon when absent. */
  logo: z.string().url().optional(),
  baseUrl: z.string().url(),
  auth: z
    .object({
      type: z.literal("apiKey"),
      header: z.string().optional(),
      query: z.string().optional(),
      /** Which decrypted secret holds the token (default "apiKey"). */
      secretKey: z.string().optional(),
      /** User-facing name for the credential (default "API key"). */
      credentialLabel: z.string().optional(),
      /** When header is Authorization, set the scheme prefix (e.g. "Bearer "). Default "Bearer ". */
      scheme: z.string().optional(),
      /** For HTTP Basic APIs that use the API key as the password, encode `username:key`. */
      basicUsername: z.string().optional(),
    })
    .nullable()
    .optional(),
  /** Static headers sent on every request. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Default outbound throttle for every method (a method may override it stricter). */
  rateLimit: rateLimitSchema.optional(),
  methods: z.array(methodSchema).min(1),
});

export type ExtensionManifest = z.infer<typeof manifestSchema>;
type ManifestMethod = z.infer<typeof methodSchema>;

/** Validate raw JSON (string or object) into a typed manifest. Throws on invalid. */
export function parseManifest(raw: unknown): ExtensionManifest {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return manifestSchema.parse(obj);
}

/**
 * Coerce string inputs to the type their input-schema declares (integer/number/
 * boolean). The UI's column-mapping and the live-options picker both hand values
 * over as strings, so a field typed `integer` (e.g. a HeyReach `campaignId`)
 * would otherwise be sent as `"123"` and rejected by the API. Only clean,
 * unambiguous strings are converted; anything else is passed through untouched.
 */
function coerceInputTypes(input: Record<string, unknown>, schema: unknown): Record<string, unknown> {
  const props = ((schema as { properties?: Record<string, { type?: string }> } | undefined)?.properties) ?? {};
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string") continue;
    const t = props[k]?.type;
    if ((t === "integer" || t === "number") && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
      out[k] = Number(v);
    } else if (t === "boolean" && (v === "true" || v === "false")) {
      out[k] = v === "true";
    }
  }
  return out;
}

async function httpCall(
  man: ExtensionManifest,
  m: ManifestMethod,
  rawInput: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  const input = coerceInputTypes(rawInput, m.input);

  // Required-field pre-flight. The manifest's input JSON-Schema declares which
  // fields are mandatory; enforce them locally BEFORE firing the request. A row
  // whose `{{Email}}` resolves to empty would otherwise send `{ email: "" }` and
  // bounce off the upstream with a cryptic 400 ("the email field is required") —
  // while still consuming the user's API credits on a call that never could
  // succeed. Throw an actionable local error naming the missing field instead.
  // Applies to every manifest connector, not just one.
  const missing = missingRequiredFields(input, m.input);
  if (missing.length > 0) throw new Error(missingFieldsMessage(man, m, missing));

  const secretKey = man.auth?.secretKey ?? "apiKey";
  const pathParams = new Set<string>();
  const path = m.path.replace(/\{(\w+)\}/g, (_, k: string) => {
    pathParams.add(k);
    return encodeURIComponent(String(input[k] ?? ""));
  });

  const url = new URL(man.baseUrl.replace(/\/$/, "") + path);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "gtmgrid/0.1",
    ...man.headers,
  };

  // Credential injection. Pre-flight: when the manifest declares apiKey auth but
  // no secret is resolved (no credential connected, or the wrong key), fail fast
  // with a clear, actionable message instead of firing an unauthenticated request
  // and surfacing the upstream's cryptic 401 body. Applies to every apiKey
  // connector, not just one.
  const token = ctx.secrets[secretKey];
  if (man.auth?.type === "apiKey" && m.auth !== false) {
    if (!token) throw new Error(missingKeyMessage(man));
    if (man.auth.header) {
      const isAuthz = man.auth.header.toLowerCase() === "authorization";
      const credential = isAuthz && man.auth.basicUsername !== undefined
        ? `${man.auth.scheme ?? "Basic "}${btoa(`${man.auth.basicUsername}:${token}`)}`
        : isAuthz ? `${man.auth.scheme ?? "Bearer "}${token}` : token;
      headers[man.auth.header] = credential;
    } else if (man.auth.query) {
      url.searchParams.set(man.auth.query, token);
    }
  }

  const hasBody = m.body ?? (m.verb !== "GET" && m.verb !== "DELETE");
  const queryFields = m.query ?? (hasBody ? [] : Object.keys(input).filter((k) => !pathParams.has(k)));
  for (const k of queryFields) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      url.searchParams.delete(k);
      for (const item of v) url.searchParams.append(k, String(item));
    } else if (typeof v === "object") {
      url.searchParams.set(k, JSON.stringify(v));
    } else {
      url.searchParams.set(k, String(v));
    }
  }

  const init: RequestInit = { method: m.verb, headers, redirect: "manual" };
  if (m.graphql) {
    headers["content-type"] = "application/json";
    if (m.graphql.custom) {
      init.body = JSON.stringify({
        query: input.query,
        variables: input.variables ?? {},
        ...(input.operationName ? { operationName: input.operationName } : {}),
      });
    } else {
      const operation = m.graphql.operation ?? "query";
      const field = m.graphql.field;
      if (!field) throw new Error(`${man.name} ${m.id} is missing its GraphQL root field`);
      const variableTypes = m.graphql.variables ?? {};
      const declarations = Object.entries(variableTypes).map(([name, type]) => `$${name}: ${type}`).join(", ");
      const argumentsList = Object.keys(variableTypes).map((name) => `${name}: $${name}`).join(", ");
      const operationName = m.id.replace(/[^A-Za-z0-9_]/g, "_");
      const query = `${operation} ${operationName}${declarations ? `(${declarations})` : ""} { ${field}${argumentsList ? `(${argumentsList})` : ""}${m.graphql.selection ? ` ${m.graphql.selection}` : ""} }`;
      const variables = Object.fromEntries(
        Object.keys(variableTypes)
          .filter((name) => input[name] !== undefined)
          .map((name) => [name, input[name]]),
      );
      init.body = JSON.stringify({ query, variables, operationName });
    }
  } else if (hasBody) {
    const omit = new Set([...(m.bodyOmit ?? []), ...queryFields, ...pathParams]);
    const body = Object.fromEntries(Object.entries(input).filter(([k]) => !omit.has(k)));
    const payload = m.bodyFrom ? input[m.bodyFrom] : body;
    if (m.contentType === "multipart/form-data") {
      const form = new FormData();
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === null) continue;
        const fieldSchema = (m.input?.properties as Record<string, { format?: string }> | undefined)?.[key];
        if (fieldSchema?.format === "binary" && typeof value === "string") {
          const match = value.match(/^data:([^;,]+)?;base64,(.+)$/s);
          if (match) {
            const bytes = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0));
            form.append(key, new Blob([bytes], { type: match[1] ?? "application/octet-stream" }), "upload");
          } else {
            form.append(key, new Blob([value], { type: "application/octet-stream" }), "upload");
          }
        } else if (Array.isArray(value)) {
          for (const item of value) form.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
        } else {
          form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
      }
      init.body = form;
    } else if (m.contentType === "application/x-www-form-urlencoded") {
      headers["content-type"] = m.contentType;
      const encoded = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const item of value) encoded.append(key, String(item));
        else encoded.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      init.body = encoded.toString();
    } else {
      headers["content-type"] = m.contentType ?? "application/json";
      init.body = JSON.stringify(payload);
    }
  }

  // Retry transient upstream failures (429/503/5xx and network blips) with capped
  // exponential backoff + full jitter, honouring `Retry-After`, and abort a hung
  // request via a per-attempt timeout. Mirrors the declarative HTTP connector
  // (connectors/http.ts). `init` is passed through untouched, so `redirect:
  // "manual"` is preserved and a 3xx is returned unretried for the location
  // branch below; 402/other-4xx also fall through unretried for the throw below.
  const resp = await fetchWithRetry(url, init);
  // Redirect responses (e.g. avatar/image endpoints) → return the resolved URL.
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location");
    if (loc) return loc;
  }
  // Binary/image responses carry no JSON to store.
  if (/^(image\/|application\/octet-stream)/.test(resp.headers.get("content-type") ?? "")) {
    if (!resp.ok) throw new Error(`${man.name} ${m.id} HTTP ${resp.status}`);
    return null;
  }
  const text = await resp.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (m.graphql && data && typeof data === "object") {
    const errors = (data as { errors?: Array<{ message?: string; extensions?: { code?: string } }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const code = errors[0]?.extensions?.code ?? "";
      const message = errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ").slice(0, 500);
      if (/AUTH|UNAUTH/i.test(code) || /authenticat|unauthori[sz]ed|api key/i.test(message)) {
        throw new Error(invalidKeyMessage(man));
      }
      throw new Error(`${man.name} ${m.id} GraphQL${code ? ` ${code}` : ""}: ${message}`);
    }
  }
  if (!resp.ok) {
    // A 401 on an apiKey connector almost always means the configured key is
    // invalid/expired (a missing key is already caught pre-flight) — turn the raw
    // upstream "Unauthenticated" body into the same actionable guidance.
    if (resp.status === 401 && man.auth?.type === "apiKey") {
      throw new Error(invalidKeyMessage(man));
    }
    const detail = typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
    throw new Error(`${man.name} ${m.id} HTTP ${resp.status}: ${detail}`);
  }
  if (m.graphql && data && typeof data === "object") {
    const payload = (data as { data?: Record<string, unknown> }).data;
    return m.graphql.custom ? payload : payload?.[m.graphql.field ?? ""];
  }
  return data;
}

/**
 * Return the manifest-declared `required` input fields that are absent or empty.
 * A field counts as missing when it is undefined/null, an empty/whitespace-only
 * string, or an empty array — the shapes that reliably trigger an upstream "field
 * is required" 400. Values are read post-coercion, so a numeric `0` or boolean
 * `false` is treated as present.
 */
function missingRequiredFields(input: Record<string, unknown>, schema: unknown): string[] {
  const required = (schema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(required)) return [];
  const missing: string[] = [];
  for (const field of required) {
    if (typeof field !== "string") continue;
    const v = input[field];
    if (v === undefined || v === null) missing.push(field);
    else if (typeof v === "string" && v.trim() === "") missing.push(field);
    else if (Array.isArray(v) && v.length === 0) missing.push(field);
  }
  return missing;
}

/** Actionable message for a method invoked with required inputs missing/empty. */
function missingFieldsMessage(man: ExtensionManifest, m: ManifestMethod, fields: string[]): string {
  const label = m.label ?? m.id;
  const list = fields.join(", ");
  const plural = fields.length > 1 ? "fields are" : "field is";
  return `${man.name} ${label}: required ${plural} missing or empty: ${list} — map a non-empty input for ${fields.length > 1 ? "these fields" : "this field"}.`;
}

/** Actionable message for an apiKey connector invoked with no resolved secret. */
function missingKeyMessage(man: ExtensionManifest): string {
  const label = man.auth?.credentialLabel ?? "API key";
  return `${man.name} ${label} not configured — connect a ${man.name} credential to run this function.`;
}

/** Actionable message for an apiKey connector rejected with a 401. */
function invalidKeyMessage(man: ExtensionManifest): string {
  const label = man.auth?.credentialLabel ?? "API key";
  return `${man.name} ${label} invalid or expired (HTTP 401) — check the ${man.name} credential and update it.`;
}

/** One resolved choice for a pick-field dropdown. */
export interface FieldOption {
  label: string;
  value: string;
  sublabel?: string;
}

/**
 * Map a connector list-response into `{label, value}[]` for a pick-field
 * dropdown, per a {@link FieldOptionSource}. Tolerant of the common envelope
 * shapes (`items`/`data`/`results`, or a bare array) and the common id/name
 * key spellings, so a manifest can declare just `{ method }` and still resolve.
 */
export function extractOptions(
  raw: unknown,
  source: {
    itemsPath?: string;
    labelKey?: string;
    valueKey?: string;
    sublabelKey?: string;
  },
): FieldOption[] {
  let arr: unknown = source.itemsPath ? getPath(raw, source.itemsPath) : raw;
  if (!Array.isArray(arr)) {
    // Fallback: unwrap the usual list envelopes.
    for (const k of ["items", "data", "results", "records", "campaigns", "lists", "accounts"]) {
      const v = getPath(raw, k);
      if (Array.isArray(v)) {
        arr = v;
        break;
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  const labelKeys = source.labelKey ? [source.labelKey] : ["name", "title", "label", "displayName"];
  const valueKeys = source.valueKey ? [source.valueKey] : ["id", "uuid", "_id", "value"];
  const pick = (item: unknown, keys: string[]): string | undefined => {
    if (item == null || typeof item !== "object") return undefined;
    for (const k of keys) {
      const v = (item as Record<string, unknown>)[k];
      if (v != null && v !== "") return String(v);
    }
    return undefined;
  };
  const out: FieldOption[] = [];
  for (const item of arr) {
    const value = pick(item, valueKeys);
    if (value === undefined) continue;
    const label = pick(item, labelKeys) ?? value;
    const sublabel = source.sublabelKey ? pick(item, [source.sublabelKey]) : undefined;
    out.push(sublabel ? { label, value, sublabel } : { label, value });
  }
  return out;
}

/** Build a runnable Connector from a validated manifest. */
/** Read a dot-path (e.g. "data.status") out of a parsed response. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a `poll`-flavoured method: start the job (this method's verb/path), then poll
 * the sibling status method host-side until it reaches `doneWhen` (return its data),
 * hits a `failWhen` state, or exceeds the timeout (throw). Because this awaits on the
 * host, the in-sandbox per-cell interrupt never fires mid-wait — a multi-minute job
 * completes in a single connector call.
 */
async function runPollingMethod(
  man: ExtensionManifest,
  m: ManifestMethod,
  input: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
  const p = m.poll!;
  const statusMethod = man.methods.find((x) => x.id === p.statusMethod);
  if (!statusMethod) {
    throw new Error(`${man.name} ${m.id}: poll.statusMethod "${p.statusMethod}" is not a method on this connector`);
  }
  const idFrom = p.idFrom ?? "id";
  const idParam = p.idParam ?? "id";
  const statusFrom = p.statusFrom ?? "status";
  const doneWhen = p.doneWhen ?? "completed";
  const failWhen = p.failWhen ?? ["failed", "cancelled"];
  const dataFrom = p.dataFrom ?? "data";
  const intervalMs = p.intervalMs ?? 3000;
  const timeoutMs = p.timeoutMs ?? 300_000;

  const started = await httpCall(man, m, input, ctx);
  const id = getPath(started, idFrom) ?? getPath(started, `data.${idFrom}`);
  if (id == null || id === "") {
    throw new Error(`${man.name} ${m.id}: no job id (looked at "${idFrom}") in start response`);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await httpCall(man, statusMethod, { [idParam]: id }, ctx);
    const status = String(getPath(st, statusFrom) ?? getPath(st, `data.${statusFrom}`) ?? "");
    if (status === doneWhen) {
      const data = getPath(st, dataFrom);
      return data === undefined ? st : data;
    }
    if (failWhen.includes(status)) {
      throw new Error(`${man.name} ${m.id}: job ${status} (id ${String(id)})`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${man.name} ${m.id}: timed out after ${timeoutMs}ms waiting for "${doneWhen}" (id ${String(id)}, last status "${status || "unknown"}")`,
      );
    }
    await delay(intervalMs);
  }
}

export function connectorFromManifest(man: ExtensionManifest): Connector {
  const connectorRate: RateLimit | undefined = man.rateLimit;
  const methods: ConnectorMethod[] = man.methods.map((m) => ({
    id: m.id,
    label: m.label ?? m.id,
    description: m.description,
    category: m.category,
    inputSchema: m.input ?? { type: "object", properties: {} },
    options: m.options,
    // Method override wins; otherwise inherit the connector default. So every
    // method on a throttled connector is throttled, and a heavy endpoint can
    // tighten its own cap further.
    rateLimit: m.rateLimit ?? connectorRate,
    batchSize: m.batchSize ?? 1,
    credits: m.credits ?? 1,
    run: m.poll
      ? (input, ctx) => runPollingMethod(man, m, input, ctx)
      : (input, ctx) => httpCall(man, m, input, ctx),
  }));
  return {
    id: man.id,
    name: man.name,
    category: man.category ?? "custom",
    auth: man.auth ?? null,
    rateLimit: connectorRate,
    methods,
  };
}
