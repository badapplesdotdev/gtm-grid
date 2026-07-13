// The mock origin the E2E renderer talks to. One HTTP server serves, from a
// single origin (so there is no CORS to configure):
//   • the built renderer (dist-e2e/) as static files
//   • Better Auth     — GET /api/auth/get-session, POST /api/auth/sign-in|out
//   • tRPC            — GET/POST /api/trpc/<batched procedures>
//   • the engine API  — GET /api/health|functions|extensions|ai-providers|skills
//   • test control    — POST /__test/reset, GET /__health
//
// Run standalone: `node e2e/mock/server.mjs`. Lifecycle is managed by the
// Playwright global setup/teardown (it writes/reads e2e/.mock.pid).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { PORT, DIST_E2E_DIR } from "../config.mjs";
import { freshState, sessionPayload } from "./state.mjs";
import { procedures } from "./trpc.mjs";

let state = freshState();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(res, body, status = 200, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// ── tRPC batch ──────────────────────────────────────────────────────────────
// httpBatchLink always batches: path is comma-joined procedure names; inputs are
// keyed by index (GET: `?input=<json>`; POST: body `{ "0": input, ... }`). We
// answer with a same-length array of `{ result: { data } }` envelopes.
function handleTrpc(pathname, search, body, res) {
  const procPath = decodeURIComponent(pathname.replace(/^\/api\/trpc\//, ""));
  const names = procPath.split(",").filter(Boolean);
  let inputs = {};
  try {
    if (body) inputs = JSON.parse(body);
    else {
      const raw = new URLSearchParams(search).get("input");
      if (raw) inputs = JSON.parse(raw);
    }
  } catch {
    inputs = {};
  }
  const out = names.map((name, i) => {
    const input = inputs[i] ?? inputs[String(i)];
    const handler = procedures[name];
    try {
      const data = handler ? handler(input, state) : null;
      return { result: { data } };
    } catch (err) {
      return {
        error: {
          message: String(err?.message ?? err),
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: name },
        },
      };
    }
  });
  sendJson(res, out);
}

// ── static renderer ───────────────────────────────────────────────────────
async function serveStatic(pathname, res) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST_E2E_DIR, rel);
  if (!existsSync(file)) file = join(DIST_E2E_DIR, "index.html"); // SPA fallback
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname, search } = url;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── test control ──────────────────────────────────────────────────────
  if (pathname === "/__health") return sendJson(res, { ok: true });
  if (pathname === "/__test/reset") {
    const body = method === "POST" ? await readBody(req) : "";
    state = freshState();
    if (body) {
      try {
        Object.assign(state, JSON.parse(body)); // shallow scenario overrides
      } catch {
        /* ignore malformed control payloads */
      }
    }
    return sendJson(res, { ok: true });
  }
  if (pathname === "/__test/state") {
    // Introspection hook for assertions (e.g. confirm a cell write persisted).
    return sendJson(res, state);
  }

  // ── Better Auth ───────────────────────────────────────────────────────
  if (pathname.startsWith("/api/auth/")) {
    if (pathname.endsWith("/get-session")) {
      return sendJson(res, sessionPayload(state));
    }
    if (pathname.endsWith("/sign-out")) {
      state.signedIn = false;
      return sendJson(res, { success: true });
    }
    if (pathname.includes("/sign-in/") || pathname.includes("/sign-up/")) {
      state.signedIn = true;
      return sendJson(
        res,
        { redirect: false, token: state.token, user: state.user },
        200,
        { "set-auth-token": state.token },
      );
    }
    // Any other auth endpoint (list-accounts, etc.) — benign.
    return sendJson(res, {});
  }

  // ── tRPC ──────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/trpc/")) {
    const body = method === "POST" ? await readBody(req) : "";
    return handleTrpc(pathname, search, body, res);
  }

  // ── agent CLIs: connection status + a scripted chat turn (SSE) ─────────
  // Lets the E2E suite drive REAL agent-panel behaviour (streamed text, gtmgrid
  // MCP tool calls = the agent's skills, tool results, ask-user cards) without a
  // real claude/codex/cursor binary or model call.
  if (pathname === "/api/agents" || pathname === "/api/agents/connect") {
    const a = { installed: true, version: "1.0.0-e2e", path: "/usr/local/bin/agent" };
    return sendJson(res, { claude: a, codex: a, cursor: a });
  }
  if (pathname === "/api/agent/chat" && method === "POST") {
    const raw = await readBody(req);
    let msg = {};
    try {
      msg = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    // Persist the request so tests can assert what the renderer sent — notably the
    // active-table context (`context.tableName` + `cloud.tableId`), which proves the
    // agent is scoped to the table in view rather than left to invent a new one.
    state.lastChat = msg;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ type: "session", sessionId: "e2e-session" });
    ev({ type: "text", text: "Reading the Leads table…\n" });
    // Tool events carry the BARE gtmgrid tool name (the server strips the
    // mcp__gtmgrid__ prefix) — these are the agent's MCP tools / skills in action.
    ev({ type: "tool", name: "get_table", raw: "mcp__gtmgrid__get_table", input: {} });
    ev({ type: "tool_result", result: "Leads — 2 rows (Acme, Globex)" });
    if (/\b(ask|which|choose|option|pick)\b/i.test(msg.message || "")) {
      ev({
        type: "ask_user",
        questions: [
          { header: "Provider", question: "Which provider should I use?", multiSelect: false, options: [{ label: "Exa" }, { label: "Trigify" }] },
        ],
      });
      return res.end();
    }
    ev({ type: "tool", name: "add_rows", raw: "mcp__gtmgrid__add_rows", input: { count: 1 } });
    ev({ type: "tool_result", result: "added 1 row" });
    ev({ type: "grid" });
    ev({ type: "text", text: "Done — enriched the Leads table.\n" });
    ev({ type: "done", result: "Done", sessionId: "e2e-session" });
    return res.end();
  }

  // ── engine sidecar API ────────────────────────────────────────────────
  if (pathname === "/api/health") return sendJson(res, { ok: true, project: "e2e" });
  if (pathname === "/api/functions") return sendJson(res, []);
  if (pathname === "/api/extensions")
    return sendJson(res, [
      // Minimal Attio tool so the Tools sidebar + panel (incl. the CRM OAuth
      // management card) are exercisable end-to-end.
      { id: "attio", name: "Attio", category: "crm", description: "Attio CRM — records, lists and webhooks via the v2 REST API.", featured: true, methods: 1, connected: false, logo: null },
      { id: "hubspot", name: "HubSpot", category: "crm", description: "HubSpot CRM — contacts, companies and lists via the v3 API.", featured: true, methods: 1, connected: false, logo: null },
    ]);
  if (pathname === "/api/extensions/attio")
    return sendJson(res, {
      id: "attio",
      name: "Attio",
      category: "crm",
      description: "Attio CRM — records, lists and webhooks via the v2 REST API.",
      version: "1.0.0",
      baseUrl: "https://api.attio.com",
      logo: null,
      auth: { type: "apiKey", header: "Authorization", secretKey: "apiKey" },
      connected: false,
      connectedScopes: [],
      methods: [{ id: "records.query", label: "Query records", description: "POST /v2/objects/{object}/records/query", credits: 1 }],
    });
  if (pathname === "/api/extensions/hubspot")
    return sendJson(res, {
      id: "hubspot",
      name: "HubSpot",
      category: "crm",
      description: "HubSpot CRM — contacts, companies and lists via the v3 API.",
      version: "1.0.0",
      baseUrl: "https://api.hubapi.com",
      logo: null,
      auth: { type: "apiKey", header: "Authorization", secretKey: "apiKey" },
      connected: false,
      connectedScopes: [],
      methods: [{ id: "objects.list", label: "List records", description: "GET /crm/v3/objects/{object}", credits: 1 }],
    });
  if (pathname === "/api/ai-providers") return sendJson(res, []);
  if (pathname === "/api/skills") return sendJson(res, []);
  if (pathname.startsWith("/api/")) return sendJson(res, {}); // any other engine call

  // ── renderer static files ─────────────────────────────────────────────
  return serveStatic(pathname, res);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[e2e-mock] port ${PORT} already in use — assuming a server is up; exiting`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[e2e-mock] listening on http://localhost:${PORT} (serving ${DIST_E2E_DIR})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
