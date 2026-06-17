// JSON-manifest extension loader — Revcode's "Upload manifest" model.
// An extension is pure data: a connector whose methods declare an HTTP request
// and a JSON-Schema input. One manifest → callable sdk methods + MCP tools + UI.

import { z } from "zod";
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
  /** For GET/DELETE: which input fields become querystring (default: all non-path fields). */
  query: z.array(z.string()).optional(),
  /** For body verbs: input fields to omit from the JSON body. */
  bodyOmit: z.array(z.string()).optional(),
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
  /** Surface this extension in the "Featured" row of the gallery. */
  featured: z.boolean().optional(),
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
      /** When header is Authorization, set the scheme prefix (e.g. "Bearer "). Default "Bearer ". */
      scheme: z.string().optional(),
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

  // Credential injection.
  const token = ctx.secrets[secretKey];
  if (token && man.auth?.type === "apiKey") {
    if (man.auth.header) {
      const isAuthz = man.auth.header.toLowerCase() === "authorization";
      headers[man.auth.header] = isAuthz ? `${man.auth.scheme ?? "Bearer "}${token}` : token;
    } else if (man.auth.query) {
      url.searchParams.set(man.auth.query, token);
    }
  }

  const init: RequestInit = { method: m.verb, headers, redirect: "manual" };
  if (m.verb === "GET" || m.verb === "DELETE") {
    const fields = m.query ?? Object.keys(input).filter((k) => !pathParams.has(k));
    for (const k of fields) {
      const v = input[k];
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  } else {
    headers["content-type"] = "application/json";
    const omit = new Set([...(m.bodyOmit ?? []), ...pathParams]);
    const body = Object.fromEntries(Object.entries(input).filter(([k]) => !omit.has(k)));
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(url, init);
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
  if (!resp.ok) {
    const detail = typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
    throw new Error(`${man.name} ${m.id} HTTP ${resp.status}: ${detail}`);
  }
  return data;
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
