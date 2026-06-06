// JSON-manifest extension loader — Revcode's "Upload manifest" model.
// An extension is pure data: a connector whose methods declare an HTTP request
// and a JSON-Schema input. One manifest → callable sdk methods + MCP tools + UI.

import { z } from "zod";
import type { Connector, ConnectorMethod, MethodContext } from "../types.js";

const methodSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]+$/, "method id must be alphanumeric/underscore"),
  label: z.string().optional(),
  description: z.string(),
  verb: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  /** JSON Schema for inputs (object). Surfaced to agents + UI as-is. */
  input: z.record(z.string(), z.any()).optional(),
  /** For GET/DELETE: which input fields become querystring (default: all non-path fields). */
  query: z.array(z.string()).optional(),
  /** For body verbs: input fields to omit from the JSON body. */
  bodyOmit: z.array(z.string()).optional(),
  credits: z.number().optional(),
  batchSize: z.number().optional(),
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
  methods: z.array(methodSchema).min(1),
});

export type ExtensionManifest = z.infer<typeof manifestSchema>;
type ManifestMethod = z.infer<typeof methodSchema>;

/** Validate raw JSON (string or object) into a typed manifest. Throws on invalid. */
export function parseManifest(raw: unknown): ExtensionManifest {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return manifestSchema.parse(obj);
}

async function httpCall(
  man: ExtensionManifest,
  m: ManifestMethod,
  input: Record<string, unknown>,
  ctx: MethodContext,
): Promise<unknown> {
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

/** Build a runnable Connector from a validated manifest. */
export function connectorFromManifest(man: ExtensionManifest): Connector {
  const methods: ConnectorMethod[] = man.methods.map((m) => ({
    id: m.id,
    label: m.label ?? m.id,
    description: m.description,
    inputSchema: m.input ?? { type: "object", properties: {} },
    batchSize: m.batchSize ?? 1,
    credits: m.credits ?? 1,
    run: (input, ctx) => httpCall(man, m, input, ctx),
  }));
  return { id: man.id, name: man.name, category: man.category ?? "custom", auth: man.auth ?? null, methods };
}
