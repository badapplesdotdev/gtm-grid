// Declarative HTTP-connector factory — the Revcode extension model.
// One method definition (verb + path + zod input) becomes: an sdk.<provider>.<method>()
// call, an MCP tool (via inputSchema), and a UI form. Credentials inject into auth.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fetchWithRetry } from "../http-retry.js";
import type { Connector, ConnectorMethod, MethodContext } from "../types.js";

export interface HttpMethodDef {
  id: string;
  label: string;
  description: string;
  verb: "GET" | "POST";
  /** Path with `{param}` placeholders filled from validated inputs. */
  path: string;
  input: z.ZodTypeAny;
  batchSize?: number;
  credits?: number;
  /** Build querystring params from inputs (GET). */
  query?: (input: any) => Record<string, string | number | undefined>;
  /** Build request body from inputs (POST). Defaults to the whole input object. */
  body?: (input: any) => unknown;
}

export interface HttpConnectorDef {
  id: string;
  name: string;
  category: string;
  baseUrl: string;
  auth: Connector["auth"];
  /** Which decrypted secret holds the token (default "apiKey"). */
  secretKey?: string;
  methods: HttpMethodDef[];
}

export function defineHttpConnector(def: HttpConnectorDef): Connector {
  const secretKey = def.secretKey ?? "apiKey";
  const methods: ConnectorMethod[] = def.methods.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    inputSchema: zodToJsonSchema(m.input, m.id) as Record<string, unknown>,
    batchSize: m.batchSize ?? 1,
    credits: m.credits ?? 1,
    run: async (rawInput: Record<string, unknown>, ctx: MethodContext) => {
      const input = m.input.parse(rawInput) as Record<string, unknown>;
      const path = m.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(input[k] ?? "")));
      const url = new URL(def.baseUrl.replace(/\/$/, "") + path);
      if (m.query) {
        for (const [k, v] of Object.entries(m.query(input))) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "gtmgrid/0.1" };

      // Credential injection (mirrors Revcode's per-extension auth).
      const token = ctx.secrets[secretKey];
      if (token && def.auth?.type === "apiKey") {
        if (def.auth.header) {
          headers[def.auth.header] =
            def.auth.header.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
        } else if (def.auth.query) {
          url.searchParams.set(def.auth.query, token);
        }
      }

      const init: RequestInit = { method: m.verb, headers };
      if (m.verb === "POST") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(m.body ? m.body(input) : input);
      }

      // Retry transient upstream failures (429/503/5xx) with exponential backoff
      // + jitter, honouring Retry-After, and abort any hung request via a per-
      // attempt timeout. 402/other-4xx fall through unretried for the throw below.
      const resp = await fetchWithRetry(url, init);
      const text = await resp.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (!resp.ok) {
        const detail = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200);
        throw new Error(`${def.name} ${m.id} HTTP ${resp.status}: ${detail}`);
      }
      return data;
    },
  }));

  return { id: def.id, name: def.name, category: def.category, auth: def.auth, methods };
}
