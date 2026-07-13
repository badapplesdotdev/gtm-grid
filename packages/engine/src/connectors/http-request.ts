// Built-in "HTTP" connector — a single generic `request` method that calls ANY
// HTTP API. This is the universal fallback: when no dedicated connector/function
// maps an endpoint, the agent (or a user) can still reach it by attaching an
// `http.request` column. Every field supports {{Column}} templating, so the URL,
// auth headers, query, and body can all be built from other cells per row.
//
// Beyond the basics it mirrors a full request builder: response-field selection,
// empty-value pruning, metadata envelope, redirect control, timeout, and retries.

import { fetchWithRetry } from "../http-retry.js";
import { assertPublicUrl } from "../ssrf.js";
import type { Connector, ConnectorMethod, MethodContext } from "../types.js";

/** Hard ceiling on a buffered response body (bytes) — caps memory for an any-URL connector. */
const MAX_RESPONSE_BYTES = 10_000_000; // 10 MB

/** Header names that carry credentials and must NOT cross an origin boundary on redirect. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/**
 * Drop credential-bearing headers (the URL is agent/LLM-templated, so a hostile
 * endpoint can 302 us to its own host to harvest a bearer token / api key).
 * Strips the well-known auth headers plus anything that looks like an api-key /
 * token / secret — erring toward stripping, since security beats convenience on
 * a cross-origin hop.
 */
function stripSensitiveHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_HEADERS.has(lk)) continue;
    if (/(?:^|[-_])(?:api[-_]?key|token|secret|auth)(?:[-_]|$)/.test(lk)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Read a response body to a string, aborting once it exceeds `cap` bytes so a
 * large/hostile response can't exhaust memory. Falls back to `resp.text()` when
 * the body isn't a readable stream.
 */
async function readBodyCapped(resp: Response, cap: number): Promise<string> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`http.request: response too large (${declared} bytes > ${cap})`);
  }
  if (!resp.body) return resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* already closing */ }
      throw new Error(`http.request: response too large (> ${cap} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function str(v: unknown): string {
  return v == null ? "" : typeof v === "string" ? v : String(v);
}

function asBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function asNum(v: unknown, dflt: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Normalise responseFields into a clean string[] (accepts an array or a comma/newline list). */
function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x).trim()).filter(Boolean);
  const s = str(v).trim();
  if (!s) return [];
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (isPlainObject(v) && Object.keys(v).length === 0)
  );
}

/** Recursively drop null/empty leaves. Keeps falsy-but-meaningful values (0, false). */
function pruneEmpty(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(pruneEmpty).filter((x) => !isEmptyValue(x));
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const pruned = pruneEmpty(val);
      if (!isEmptyValue(pruned)) out[k] = pruned;
    }
    return out;
  }
  return v;
}

/** Read a dot-path (e.g. "data.items.0.email") out of a parsed response. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (isPlainObject(cur)) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

const request: ConnectorMethod = {
  id: "request",
  label: "HTTP Request",
  description:
    "Make an arbitrary HTTP request to ANY API endpoint — the universal fallback when no dedicated connector or function exists for an API. Specify method, endpoint URL, headers (including auth), query params, and a JSON or text body; every field supports {{Column}} templating so each row builds its own request. Optionally pick specific response fields, prune empty values, return response metadata (status/headers), and control redirects, timeout, and retries. Returns the parsed JSON (or text) response and throws on a non-2xx status. Use this to call REST APIs, webhooks, or any endpoint not yet mapped as a connector.",
  batchSize: 1,
  credits: 0,
  output: "json",
  source: `// Build the request from templated params, then fetch with retries.
const url = new URL(input.url);                 // {{Column}}-templated
for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
const headers = { "user-agent": "gtmgrid/0.1", accept: "application/json", ...input.headers };
const init = { method: input.method ?? "GET", headers };
if (init.method !== "GET" && input.body != null) {
  init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
}
const resp = await fetch(url, init);            // timeout + retries applied
let data = resp.headers.get("content-type")?.includes("json") ? await resp.json() : await resp.text();
// optional: pick fields, drop empties, wrap with {status, headers} metadata.
return data;`,
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        description: "HTTP method (default GET).",
      },
      url: {
        type: "string",
        description:
          "Full request URL (endpoint), e.g. https://api.example.com/v1/users?id={{Id}}. Supports {{Column}} templating.",
      },
      query: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Query-string parameters merged into the URL. Values support {{Column}} templating.",
      },
      body: {
        type: ["object", "string", "array", "number", "boolean"],
        description:
          "Request body for POST/PUT/PATCH. A JSON object/array (sent as application/json) or a raw string. Supports {{Column}} templating.",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'Request headers, e.g. { "Authorization": "Bearer {{API Key}}" }. Values support {{Column}} templating.',
      },
      responseFields: {
        type: "array",
        items: { type: "string" },
        description:
          'Response values to return: dot-paths to pick from the response, e.g. ["email", "company.name", "results.0.id"]. When set, only these are returned (keyed by path). Empty = return the whole response.',
      },
      removeEmpty: {
        type: "boolean",
        description: 'Remove empty values (null, "", empty arrays/objects) from the response. Default true.',
      },
      returnMetadata: {
        type: "boolean",
        description:
          "Return response metadata: { status, statusText, headers, body } instead of just the body. Default false.",
      },
      followRedirects: {
        type: "boolean",
        description:
          "Follow 3xx redirects (default true). Ignored on guarded server-side runs, which fail closed on any redirect.",
      },
      maxRedirects: {
        type: "number",
        description: "Maximum redirects to follow when followRedirects is on (default 5).",
      },
      timeout: {
        type: "number",
        description: "Per-attempt response timeout in milliseconds (default 30000).",
      },
      retryOnFailure: {
        type: "boolean",
        description: "Retry transient failures (429/503/5xx, network errors) with backoff. Default true.",
      },
      maxRetries: {
        type: "number",
        description: "Maximum retries on transient failure when retryOnFailure is on (default 3).",
      },
    },
  },
  run: async (input: Record<string, unknown>, ctx: MethodContext): Promise<unknown> => {
    const rawUrl = str(input.url).trim();
    if (!rawUrl) throw new Error("http.request: 'url' is required");

    const method = (str(input.method) || "GET").toUpperCase();
    if (!METHODS.has(method)) {
      throw new Error(`http.request: unsupported method ${JSON.stringify(method)}`);
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`http.request: invalid url ${JSON.stringify(rawUrl)}`);
    }

    // Merge query params (params win over any already in the URL string).
    if (isPlainObject(input.query)) {
      for (const [k, v] of Object.entries(input.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    // Headers: sensible defaults the caller can override.
    const headers: Record<string, string> = { "user-agent": "gtmgrid/0.1", accept: "application/json" };
    if (isPlainObject(input.headers)) {
      for (const [k, v] of Object.entries(input.headers)) {
        if (v !== undefined && v !== null) headers[k] = String(v);
      }
    }

    // Body for non-GET methods.
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD" && input.body !== undefined && input.body !== null && input.body !== "") {
      if (typeof input.body === "string") {
        body = input.body;
      } else {
        body = JSON.stringify(input.body);
        if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
      }
    }

    const timeout = asNum(input.timeout, 30_000);
    const retryOnFailure = asBool(input.retryOnFailure, true);
    const maxRetries = asNum(input.maxRetries, 3);
    const followRedirects = asBool(input.followRedirects, true);
    const maxRedirects = asNum(input.maxRedirects, 5);
    const guarded = !!ctx.guardSsrf;
    const retryOptions = { timeoutMs: timeout, maxAttempts: retryOnFailure ? Math.max(1, maxRetries) + 1 : 1 };

    // Redirect strategy:
    //  - Guarded (shared server) runs FAIL CLOSED on any 3xx — a row's templated
    //    URL is untrusted, so we never let a redirect bounce into an internal host.
    //  - Local runs follow up to `maxRedirects` hops manually, capping the chain and
    //    downgrading to GET (no body) after the first hop (browser behaviour).
    let current = url;
    // Headers carried into the next hop — credential headers are dropped the
    // moment a redirect crosses an origin boundary (see stripSensitiveHeaders).
    let activeHeaders = headers;
    let resp: Response;
    for (let hop = 0; ; hop++) {
      if (guarded) await assertPublicUrl(current);
      const redirectMode: RequestInit["redirect"] = guarded ? "error" : "manual";
      const init: RequestInit = {
        method: hop > 0 ? "GET" : method,
        headers: activeHeaders,
        redirect: redirectMode,
      };
      if (hop === 0 && body !== undefined) init.body = body;

      resp = await fetchWithRetry(current, init, retryOptions);

      const isRedirect = resp.status >= 300 && resp.status < 400;
      if (!isRedirect) break;
      const location = resp.headers.get("location");
      if (!followRedirects || guarded || !location) break; // return the 3xx as-is
      if (hop >= maxRedirects) {
        throw new Error(`http.request: exceeded maxRedirects (${maxRedirects}) for ${url.host}`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        break;
      }
      // SECURITY: never send Authorization/Cookie/api-key to a different origin.
      if (next.origin !== current.origin) activeHeaders = stripSensitiveHeaders(activeHeaders);
      current = next;
    }

    // Binary/image responses carry no JSON to store.
    const contentType = resp.headers.get("content-type") ?? "";
    if (/^(image\/|application\/octet-stream)/.test(contentType)) {
      if (resp.status >= 400) throw new Error(`http.request ${method} ${url.host} HTTP ${resp.status}`);
      return resp.headers.get("location") ?? null;
    }

    const text = await readBodyCapped(resp, MAX_RESPONSE_BYTES);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    // Only 4xx/5xx are errors. A 3xx that survived here means we were told NOT to
    // follow redirects (or are guarded) — surface it rather than throwing.
    if (resp.status >= 400) {
      const detail = typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
      throw new Error(`http.request ${method} ${url.host} HTTP ${resp.status}: ${detail}`);
    }
    if (resp.status >= 300 && (data === "" || data === null || data === undefined)) {
      // Empty redirect body → return where it points so the cell isn't blank.
      const loc = resp.headers.get("location");
      if (loc) data = { status: resp.status, location: loc };
    }

    // Pick specific response fields, if requested (keyed by the path as written).
    const fields = asStringList(input.responseFields);
    let result: unknown = data;
    if (fields.length > 0) {
      const picked: Record<string, unknown> = {};
      for (const path of fields) picked[path] = getPath(data, path);
      result = picked;
    }

    // Prune empty values (default on, like a typical request builder).
    if (asBool(input.removeEmpty, true)) {
      result = pruneEmpty(result);
    }

    // Optionally wrap with response metadata.
    if (asBool(input.returnMetadata, false)) {
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body: result };
    }

    return result;
  },
};

export const httpRequestConnector: Connector = {
  id: "http",
  name: "HTTP",
  category: "http",
  auth: null,
  methods: [request],
};
