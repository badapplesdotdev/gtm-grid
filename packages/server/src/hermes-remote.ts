// Remote "brain" bridge — when Hermes is configured as a remote gateway (URL +
// key), GTM Grid keeps the grid AND its tools LOCAL and uses the gateway only as
// the model: a standard OpenAI function-calling loop where the local gtmgrid MCP
// tools are offered to the gateway and every tool call is executed locally.
// Streams the same SSE shape the agent panel already renders (text / tool /
// tool_result / grid / done / end).

import type { ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { corsHeadersFor } from "./cors.js";
import { contextPreamble, mcpLauncher, type AgentContext } from "./agent.js";

// Host base (no /v1). Endpoints are formed as `${base}/v1/chat/completions`.
const DEFAULT_HERMES_BASE_URL = "http://localhost:18642";
const MAX_STEPS = 16; // safety cap on tool-loop iterations per turn

interface SseClient {
  write: (event: Record<string, unknown>) => void;
  end: () => void;
}
// Same allowlisted-CORS SSE writer the agent.ts bridges use (never `*`).
function sseClient(res: ServerResponse, origin?: string): SseClient {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...corsHeadersFor(origin),
  });
  return {
    write: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => res.end(),
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** One streamed chat-completion turn against the gateway. Emits assistant text
 *  deltas as SSE and returns the full text + any accumulated tool calls. */
async function streamCompletion(
  base: string,
  apiKey: string,
  model: string | undefined,
  messages: unknown[],
  tools: unknown[],
  sse: SseClient,
  signal: AbortSignal,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        sse.write({ type: "text", text: delta.content });
      }
      // Tool calls stream in fragments across chunks; accumulate by index.
      if (Array.isArray(delta.tool_calls)) {
        for (const d of delta.tool_calls) {
          const i = d.index ?? 0;
          const tc = (toolCalls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (d.id) tc.id = d.id;
          if (d.function?.name) tc.function.name += d.function.name;
          if (d.function?.arguments) tc.function.arguments += d.function.arguments;
        }
      }
    }
  }
  return { text, toolCalls: toolCalls.filter(Boolean) };
}

/** Drive the grid with a remote gateway as the brain. Grid tools come from the
 *  LOCAL gtmgrid MCP; the gateway only reasons + decides which tools to call. */
export function streamHermesRemote(
  res: ServerResponse,
  opts: {
    message: string;
    project: string;
    repoRoot: string;
    url?: string;
    apiKey?: string;
    model?: string;
    context?: AgentContext;
    origin?: string;
  },
): void {
  const sse = sseClient(res, opts.origin);
  // Normalize to the host root: strip a trailing slash AND an optional "/v1" the
  // user may have included, so endpoints form cleanly as `${base}/v1/...`.
  const base = (opts.url || DEFAULT_HERMES_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/i, "");
  const apiKey = opts.apiKey || "hermes";
  // Model is OPTIONAL — when omitted, the gateway uses the agent's own configured
  // model (the user said the remote agent sets this itself).
  const model = opts.model?.trim() || undefined;
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  (async () => {
    // Connect to the LOCAL gtmgrid MCP as a tool client (same launcher the
    // claude/codex agents use — bundled in the packaged app, repo/bin in dev).
    const transport = new StdioClientTransport({
      command: mcpLauncher(opts.repoRoot),
      args: [],
      env: { ...process.env, GTMGRID_PROJECT: opts.project } as Record<string, string>,
    });
    const mcp = new Client({ name: "gtmgrid-remote-brain", version: "0.0.1" });
    let tools: unknown[] = [];
    try {
      await mcp.connect(transport);
      const listed = await mcp.listTools();
      tools = listed.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        },
      }));
    } catch (e) {
      sse.write({ type: "error", message: `Couldn't start the local grid tools: ${errMsg(e)}` });
      sse.write({ type: "end" });
      try {
        await mcp.close();
      } catch {
        /* ignore */
      }
      return sse.end();
    }

    const messages: any[] = [
      { role: "system", content: contextPreamble(opts.context) },
      { role: "user", content: opts.message },
    ];

    let isError = false;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const { text, toolCalls } = await streamCompletion(base, apiKey, model, messages, tools, sse, abort.signal);
        messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!toolCalls.length) break; // model produced a final answer
        for (const tc of toolCalls) {
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            /* leave {} */
          }
          sse.write({ type: "tool", name, raw: name, input: args });
          let resultText = "";
          try {
            const r = await mcp.callTool({ name, arguments: args });
            const content = (r as { content?: Array<{ type?: string; text?: string }> }).content;
            resultText = Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text ?? "" : "")).join("") : "";
          } catch (e) {
            resultText = `error: ${errMsg(e)}`;
          }
          sse.write({ type: "tool_result", result: resultText.slice(0, 600) });
          sse.write({ type: "grid" }); // a tool ran — nudge the UI to refetch
          messages.push({ role: "tool", tool_call_id: tc.id, content: resultText.slice(0, 4000) });
        }
        if (step === MAX_STEPS - 1) sse.write({ type: "text", text: "\n\n_(stopped after hitting the step limit)_" });
      }
    } catch (e) {
      isError = true;
      if (!abort.signal.aborted) sse.write({ type: "error", message: errMsg(e) });
    } finally {
      sse.write({ type: "done", result: "", isError });
      sse.write({ type: "end" });
      sse.end();
      try {
        await mcp.close();
      } catch {
        /* ignore */
      }
    }
  })();
}
