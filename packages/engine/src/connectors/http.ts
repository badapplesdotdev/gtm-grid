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
  /**
   * Bulk request shape, used only when `batchSize > 1`. The engine hands this the
   * ordered batch of per-row inputs; it makes ONE call and must return results in
   * the SAME order (one per input). When omitted but `batchSize > 1`, the engine
   * falls back to per-row `run` calls — correct, just not collapsed.
   */
  batch?: {
    /** Path for the bulk endpoint (default: the method `path`). */
    path?: string;
    /** Verb for the bulk endpoint (default: "POST"). */
    verb?: "GET" | "POST";
    /** Build the bulk request body from the ordered batch of inputs. */
    body: (inputs: any[]) => unknown;
    /** Map the bulk response to an ordered array of per-row results. */
    map: (data: unknown, inputs: any[]) => unknown[];
  };
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

  const methods: ConnectorMethod[] = def.methods.map((m) => {
    const batchSize = m.batchSize ?? 1;

    // One fetch with auth injected, JSON-parsed, throwing on non-2xx. Shared by
    // both the per-row `run` and the bulk `runBatch` so credential handling and
    // error shape stay identical across the two paths.
    const request = async (
      ctx: MethodContext,
      verb: "GET" | "POST",
      path: string,
      query: Record<string, string | number | undefined> | undefined,
      body: unknown,
    ): Promise<unknown> => {
      const url = new URL(def.baseUrl.replace(/\/$/, "") + path);
      if (query) {
        for (const [k, v] of Object.entries(query)) {
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

      const init: RequestInit = { method: verb, headers };
      if (verb === "POST") {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
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
    };

    const run = async (rawInput: Record<string, unknown>, ctx: MethodContext): Promise<unknown> => {
      const input = m.input.parse(rawInput) as Record<string, unknown>;
      const path = m.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(input[k] ?? "")));
      return request(ctx, m.verb, path, m.query?.(input), m.body ? m.body(input) : input);
    };

    const method: ConnectorMethod = {
      id: m.id,
      label: m.label,
      description: m.description,
      inputSchema: zodToJsonSchema(m.input, m.id) as Record<string, unknown>,
      batchSize,
      credits: m.credits ?? 1,
      run,
    };

    // Wire a bulk path only when the method opts in (batchSize > 1 AND a batch
    // shape is declared). The engine calls this ONCE per chunk and maps the
    // ordered result array back to each row's cell.
    if (batchSize > 1 && m.batch) {
      const bdef = m.batch;
      method.runBatch = async (rawInputs, ctx) => {
        const inputs = rawInputs.map((r) => m.input.parse(r) as Record<string, unknown>);
        const verb = bdef.verb ?? "POST";
        const path = bdef.path ?? m.path;
        const data = await request(ctx, verb, path, undefined, bdef.body(inputs));
        const results = bdef.map(data, inputs);
        if (results.length !== inputs.length) {
          throw new Error(
            `${def.name} ${m.id} batch returned ${results.length} results for ${inputs.length} inputs`,
          );
        }
        return results;
      };
    }

    return method;
  });

  return { id: def.id, name: def.name, category: def.category, auth: def.auth, methods };
}
