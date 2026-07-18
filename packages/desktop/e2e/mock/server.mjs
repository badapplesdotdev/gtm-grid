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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, DIST_E2E_DIR } from "../config.mjs";
import { freshState, sessionPayload } from "./state.mjs";
import { procedures } from "./trpc.mjs";

let state = freshState();

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../extensions");
const reviewAllTools = process.env.GTMGRID_REVIEW_ALL_TOOLS === "1";
const extensionManifests = readdirSync(extensionDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(extensionDir, file), "utf8")))
  .sort((a, b) => a.name.localeCompare(b.name));
const extensionManifestById = new Map(extensionManifests.map((manifest) => [manifest.id, manifest]));
// Ids the base list already emits, so the GTMGRID_REVIEW_ALL_TOOLS manifest scan
// must NOT re-add them. "slack" is here despite being DERIVED from its manifest
// rather than hand-detailed: what this set means is "already in the list", and
// omitting it emitted Slack twice (the specs only survived on .first()).
const detailedMockExtensionIds = new Set(["attio", "hubspot", "zoominfo", "surfe", "linear", "theirstack", "peopledatalabs", "lemlist", "slack"]);
// Keep review mode aligned with the production source of truth in
// packages/server/src/index.ts. Manifests deliberately do not control this.
const reviewFeaturedToolIds = new Set(["trigify", "smuggler", "leadmagic", "avtrz"]);
const zoomInfoLogo = JSON.parse(readFileSync(join(extensionDir, "zoominfo.json"), "utf8")).logo;
const surfeLogo = JSON.parse(readFileSync(join(extensionDir, "surfe.json"), "utf8")).logo;
const linearLogo = JSON.parse(readFileSync(join(extensionDir, "linear.json"), "utf8")).logo;
const theirStackLogo = JSON.parse(readFileSync(join(extensionDir, "theirstack.json"), "utf8")).logo;
const peopleDataLabsManifest = JSON.parse(readFileSync(join(extensionDir, "peopledatalabs.json"), "utf8"));
const peopleDataLabsLogo = peopleDataLabsManifest.logo;
const lemlistManifest = JSON.parse(readFileSync(join(extensionDir, "lemlist.json"), "utf8"));
const lemlistLogo = lemlistManifest.logo;
// Slack is served from its manifest wholesale (summary AND detail), so there is
// exactly one source of truth for it: extensions/slack.json.
const slackManifest = extensionManifestById.get("slack");
const attioLogo = extensionManifestById.get("attio")?.logo ?? null;
const hubspotLogo = extensionManifestById.get("hubspot")?.logo ?? null;

function extensionConnected(extensionId, includeWorkspace = true) {
  return state.credentials.some(
    (credential) => credential.extensionId === extensionId && (includeWorkspace || credential.scope !== "workspace"),
  );
}

function extensionScopes(extensionId) {
  return state.credentials
    .filter((credential) => credential.extensionId === extensionId && credential.scope !== "workspace")
    .map((credential) => credential.scope);
}

/**
 * Fail LOUDLY if the tools list would serve the same id twice.
 *
 * A duplicate is what happens whenever a tool is added to the base list but not
 * to `detailedMockExtensionIds`, so the GTMGRID_REVIEW_ALL_TOOLS manifest scan
 * re-emits it. That happened to Slack and NOTHING caught it: the specs locate
 * tools with `.first()`, which quietly takes row one and moves on. A mock that
 * serves a shape the real API never would, without complaint, is worse than no
 * mock — the suite goes green on a fiction.
 *
 * Throwing here surfaces as a 500 and fails every tools spec at once, which is
 * the correct volume for "the fixture is lying".
 */
function assertUniqueExtensionIds(rows) {
  const seen = new Set();
  const dupes = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) dupes.add(row.id);
    seen.add(row.id);
  }
  if (dupes.size > 0) {
    throw new Error(
      `[e2e-mock] /api/extensions would serve duplicate ids: ${[...dupes].join(", ")}. ` +
        `Add them to detailedMockExtensionIds so the review-mode manifest scan skips them.`,
    );
  }
  return rows;
}

function manifestSummary(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    description: manifest.description,
    featured: reviewFeaturedToolIds.has(manifest.id),
    methods: manifest.methods?.length ?? 0,
    connected: extensionConnected(manifest.id),
    logo: manifest.logo ?? null,
  };
}

function manifestDetail(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    description: manifest.description,
    version: manifest.version,
    baseUrl: manifest.baseUrl,
    logo: manifest.logo ?? null,
    auth: manifest.auth ?? null,
    connected: extensionConnected(manifest.id, false),
    connectedScopes: extensionScopes(manifest.id),
    methods: (manifest.methods ?? []).map(({ id, label, description, credits, verb, path }) => ({
      id,
      label,
      description,
      credits: credits ?? 0,
      verb,
      path,
    })),
  };
}

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

const zoomInfoMethods = [
  {
    id: "searchContact",
    label: "Search Contacts",
    description: "Search ZoomInfo contacts by company and person criteria.",
    credits: 0,
    verb: "POST",
    path: "/data/v1/contacts/search",
  },
  ...Array.from({ length: 83 }, (_, index) => ({
    id: `referenceMethod${index + 2}`,
    label: `ZoomInfo reference method ${index + 2}`,
    description: "A simulated endpoint from the complete ZoomInfo API catalog.",
    credits: 0,
    verb: "GET",
    path: `/simulated/reference/${index + 2}`,
  })),
];

const zoomInfoFunction = {
  provider: "zoominfo",
  name: "ZoomInfo",
  category: "enrichment",
  requiresCredential: true,
  logo: zoomInfoLogo,
  methods: [
    {
      method: "searchContact",
      label: "Search Contacts",
      description: "Search ZoomInfo contacts by company and person criteria.",
      category: "Search",
      credits: 0,
      batchSize: 1,
      output: "json",
      input: {
        type: "object",
        required: ["data"],
        properties: {
          "page[size]": { type: "integer", description: "Results per page (1–100)." },
          data: {
            type: "object",
            required: ["type", "attributes"],
            properties: {
              type: { type: "string", description: "Use ContactSearch." },
              attributes: {
                type: "object",
                properties: {
                  companyName: { type: "string", description: "Company name to search." },
                },
              },
            },
          },
        },
      },
    },
  ],
};

const surfeMethods = [
  ["searchPeople", "Search People", "POST", "/v2/people/search"],
  ["startPeopleEnrichment", "Enrich People (start)", "POST", "/v2/people/enrich"],
  ["getPeopleEnrichment", "Enrich People (get)", "GET", "/v2/people/enrich/{id}"],
  ["findPeopleByEmail", "Enrich People by Email (start)", "POST", "/v2/people/find-by-email"],
  ["searchCompanies", "Search Companies", "POST", "/v2/companies/search"],
  ["startCompaniesEnrichment", "Enrich Companies (start)", "POST", "/v2/companies/enrich"],
  ["getCompaniesEnrichment", "Enrich Companies (get)", "GET", "/v2/companies/enrich/{id}"],
  ["upsertRecommendationIcp", "Create or Update ICP", "POST", "/v2/recommendations/icp"],
  ["fetchRecommendations", "Fetch Recommendations", "POST", "/v2/recommendations/fetch"],
  ["getRecommendationIcps", "Get Recommendation ICP Filters", "GET", "/v2/recommendations/icp"],
  ["getCredits", "Get Credits", "GET", "/v1/credits"],
  ["getFilters", "Get Filters", "GET", "/v1/people/search/filters"],
].map(([id, label, verb, path]) => ({
  id,
  label,
  description: `${label} through the simulated complete Surfe API catalog.`,
  credits: id === "findPeopleByEmail" ? 10 : id.startsWith("get") ? 0 : 1,
  verb,
  path,
}));

const surfeFunction = {
  provider: "surfe",
  name: "Surfe",
  category: "enrichment",
  requiresCredential: true,
  logo: surfeLogo,
  methods: [
    {
      method: "searchPeople",
      label: "Search People",
      description: "Search Surfe people using persona and company filters.",
      category: "Search",
      credits: 1,
      batchSize: 1,
      output: "json",
      input: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Results per page (1–200)." },
          companies: {
            type: "object",
            properties: {
              domains: { type: "array", items: { type: "string" }, description: "Company domains." },
            },
          },
          people: {
            type: "object",
            properties: {
              jobTitles: { type: "array", items: { type: "string" }, description: "Target job titles." },
            },
          },
        },
      },
    },
  ],
};

const linearKnownMethods = [
  ["executeGraphQL", "Execute custom GraphQL"],
  ["query_viewer", "Get Viewer"],
  ["query_teams", "Get Teams"],
  ["query_issues", "Get Issues"],
  ["query_issue", "Get Issue"],
  ["mutation_issueCreate", "Run Issue Create"],
  ["mutation_issueUpdate", "Run Issue Update"],
  ["mutation_commentCreate", "Run Comment Create"],
].map(([id, label]) => ({
  id,
  label,
  description: `${label} through Linear's simulated GraphQL API.`,
  credits: 0,
  verb: "POST",
  path: "/graphql",
}));

const linearMethods = [
  ...linearKnownMethods,
  ...Array.from({ length: 517 - linearKnownMethods.length }, (_, index) => ({
    id: `schemaOperation${index + 1}`,
    label: `Linear schema operation ${index + 1}`,
    description: "A simulated operation from Linear's complete active GraphQL schema.",
    credits: 0,
    verb: "POST",
    path: "/graphql",
  })),
];

const linearFunction = {
  provider: "linear",
  name: "Linear",
  category: "project-management",
  requiresCredential: true,
  logo: linearLogo,
  methods: [
    {
      method: "query_issues",
      label: "Get Issues",
      description: "Filter and paginate Linear issues.",
      category: "Issues",
      credits: 0,
      batchSize: 1,
      output: "json",
      input: {
        type: "object",
        properties: {
          first: { type: "integer", description: "Number of issues to return." },
          filter: {
            type: "object",
            properties: {
              title: {
                type: "object",
                properties: { contains: { type: "string", description: "Case-insensitive title search." } },
              },
            },
          },
        },
      },
    },
  ],
};

const theirStackKnownMethods = [
  ["search_jobs_v1", "Job Search", "POST", "/v1/jobs/search", 1],
  ["search_companies_v1", "Company Search", "POST", "/v1/companies/search", 3],
  ["technographics_v1", "Technographics", "POST", "/v1/companies/technologies", 3],
  ["buying_intents_v1", "Buying Intents", "POST", "/v1/companies/buying_intents", 3],
  ["get_billing_credit_balance_v0", "Get Credit Balance", "GET", "/v0/billing/credit-balance", 0],
  ["get_webhooks_v0", "List All Webhooks", "GET", "/v0/webhooks", 0],
  ["post_company_lists_v0", "Create Company List", "POST", "/v0/company_lists", 0],
  ["get_datasets_v1", "List Datasets", "GET", "/v1/datasets", 0],
].map(([id, label, verb, path, credits]) => ({
  id,
  label,
  description: `${label} through TheirStack's simulated API.`,
  credits,
  verb,
  path,
}));

const theirStackMethods = [
  ...theirStackKnownMethods,
  ...Array.from({ length: 51 - theirStackKnownMethods.length }, (_, index) => ({
    id: `theirStackOperation${index + 1}`,
    label: `TheirStack operation ${index + 1}`,
    description: "A simulated operation from TheirStack's complete active OpenAPI catalog.",
    credits: 0,
    verb: "GET",
    path: `/simulated/theirstack/${index + 1}`,
  })),
];

const theirStackFunction = {
  provider: "theirstack",
  name: "TheirStack",
  category: "enrichment",
  requiresCredential: true,
  logo: theirStackLogo,
  methods: [{
    method: "search_jobs_v1",
    label: "Job Search",
    description: "Search current and historical job postings using company, role, location, date, and technology filters.",
    category: "Jobs",
    credits: 1,
    batchSize: 1,
    output: "json",
    input: {
      type: "object",
      properties: {
        company_domain_or: { type: "array", items: { type: "string" }, description: "Exact company domains." },
        posted_at_max_age_days: { type: "integer", description: "Maximum job age in days." },
        job_title_or: { type: "array", items: { type: "string" }, description: "Job title patterns." },
        limit: { type: "integer", description: "Results per page." },
      },
    },
  }],
};

const peopleDataLabsMethods = peopleDataLabsManifest.methods;
const peopleDataLabsFunction = {
  provider: "peopledatalabs",
  name: "People Data Labs",
  category: "enrichment",
  requiresCredential: true,
  logo: peopleDataLabsLogo,
  methods: [{
    method: "getPersonEnrichment",
    label: "Enrich Person (GET)",
    description: "Match and enrich one person from an email, profile, PDL ID, or other identity fields.",
    category: "Enrich people",
    credits: 1,
    batchSize: 1,
    output: "json",
    input: peopleDataLabsMethods.find((item) => item.id === "getPersonEnrichment").input,
  }],
};

const lemlistMethods = lemlistManifest.methods;
const lemlistFunction = {
  provider: "lemlist",
  name: "Lemlist",
  category: "sales-engagement",
  requiresCredential: true,
  logo: lemlistLogo,
  methods: [{
    method: "getCampaign",
    label: "Get Campaign",
    description: "Retrieve one Lemlist campaign by its campaign ID.",
    category: "Campaigns",
    credits: 1,
    batchSize: 1,
    output: "json",
    input: lemlistMethods.find((item) => item.id === "getCampaign").input,
  }],
};

function template(value, row, state) {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, name) => {
      const column = state.columns.find((item) => item.name === name && item.tableId === row.tableId);
      return column ? String(state.cells[row._id]?.[column._id]?.value ?? "") : "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => template(item, row, state));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, template(item, row, state)]));
  }
  return value;
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

/** The tools list the mock serves. Ids are static; only `connected` reads state. */
function extensionRows() {
  return [
      // Minimal Attio tool so the Tools sidebar + panel (incl. the CRM OAuth
      // management card) are exercisable end-to-end.
      { id: "attio", name: "Attio", category: "crm", description: "Attio CRM — records, lists and webhooks via the v2 REST API.", featured: !reviewAllTools, methods: 1, connected: false, logo: attioLogo },
      { id: "hubspot", name: "HubSpot", category: "crm", description: "HubSpot CRM — contacts, companies and lists via the v3 API.", featured: !reviewAllTools, methods: 1, connected: false, logo: hubspotLogo },
      {
        id: "zoominfo",
        name: "ZoomInfo",
        category: "enrichment",
        description: "ZoomInfo GTM intelligence, enrichment, Copilot, Studio, Marketing, Platform, and Agent APIs (84 endpoints).",
        featured: false,
        methods: 84,
        connected: state.credentials.some((credential) => credential.extensionId === "zoominfo"),
        logo: zoomInfoLogo,
      },
      {
        id: "surfe",
        name: "Surfe",
        category: "enrichment",
        description: "Surfe people and company search, enrichment, recommendations, credits, and filters (12 endpoints).",
        featured: false,
        methods: 12,
        connected: state.credentials.some((credential) => credential.extensionId === "surfe"),
        logo: surfeLogo,
      },
      {
        id: "linear",
        name: "Linear",
        category: "project-management",
        description: "Linear issues, projects, teams, cycles, customers, documents, integrations, and administration (516 active GraphQL operations).",
        featured: false,
        methods: 517,
        connected: state.credentials.some((credential) => credential.extensionId === "linear"),
        logo: linearLogo,
      },
      {
        id: "theirstack",
        name: "TheirStack",
        category: "enrichment",
        description: "TheirStack jobs, companies, technographics, buying intent, lists, datasets, catalogs, saved searches, and webhooks (51 active endpoints).",
        featured: false,
        methods: 51,
        connected: state.credentials.some((credential) => credential.extensionId === "theirstack"),
        logo: theirStackLogo,
      },
      {
        id: "peopledatalabs",
        name: "People Data Labs",
        category: "enrichment",
        description: "People Data Labs person, company, search, cleaning, job, changelog, and privacy APIs (27 production operations).",
        featured: false,
        methods: 27,
        connected: state.credentials.some((credential) => credential.extensionId === "peopledatalabs"),
        logo: peopleDataLabsLogo,
      },
      {
        id: "lemlist",
        name: "Lemlist",
        category: "sales-engagement",
        description: "Lemlist campaigns, leads, CRM, inbox, enrichment, deliverability, sequences, tasks, signals, and webhooks (140 operations).",
        featured: false,
        methods: 140,
        connected: state.credentials.some((credential) => credential.extensionId === "lemlist"),
        logo: lemlistLogo,
      },
      ...(reviewAllTools
        ? extensionManifests
            .filter((manifest) => !detailedMockExtensionIds.has(manifest.id))
            .map(manifestSummary)
        : []),
      // Slack: an OAUTH connector rather than an apiKey one — the panel must
      // render the OAuth card and NO api-key section.
      //
      // DERIVED from extensions/slack.json, not hand-written. The hand-written
      // copy had drifted from the manifest on description, featured AND logo
      // (and its detail on credits) within one PR of being added — a mock that
      // contradicts the manifest it stands in for tests nothing.
      { ...manifestSummary(slackManifest), connected: state.slackConnected },
  ];
}

// Validate the FIXTURE at startup, not per request: a duplicate id is a static
// mistake (a tool in the base list but missing from detailedMockExtensionIds),
// so it should stop the mock BEFORE any spec runs, with a message naming the
// fix. Throwing from the async request handler instead just killed the process
// mid-suite and surfaced as "connection refused" — loud, but about the wrong
// thing.
assertUniqueExtensionIds(extensionRows());

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
  if (pathname === "/api/functions") return sendJson(res, [zoomInfoFunction, surfeFunction, linearFunction, theirStackFunction, peopleDataLabsFunction, lemlistFunction]);
  if (pathname === "/api/extensions") return sendJson(res, extensionRows());
  if (pathname === "/api/extensions/zoominfo")
    return sendJson(res, {
      id: "zoominfo",
      name: "ZoomInfo",
      category: "enrichment",
      description: "ZoomInfo GTM intelligence, enrichment, Copilot, Studio, Marketing, Platform, and Agent APIs (84 endpoints).",
      version: "1.0.0",
      baseUrl: "https://api.zoominfo.com/gtm",
      logo: zoomInfoLogo,
      auth: {
        type: "apiKey",
        header: "Authorization",
        secretKey: "apiKey",
        credentialLabel: "OAuth access token",
      },
      connected: state.credentials.some((credential) => credential.extensionId === "zoominfo" && credential.scope !== "workspace"),
      connectedScopes: state.credentials
        .filter((credential) => credential.extensionId === "zoominfo" && credential.scope !== "workspace")
        .map((credential) => credential.scope),
      methods: zoomInfoMethods,
    });
  if (pathname === "/api/extensions/surfe")
    return sendJson(res, {
      id: "surfe",
      name: "Surfe",
      category: "enrichment",
      description: "Surfe people and company search, enrichment, recommendations, credits, and filters (12 endpoints).",
      version: "1.0.0",
      baseUrl: "https://api.surfe.com",
      logo: surfeLogo,
      auth: {
        type: "apiKey",
        header: "Authorization",
        secretKey: "apiKey",
        credentialLabel: "API key",
      },
      connected: state.credentials.some((credential) => credential.extensionId === "surfe" && credential.scope !== "workspace"),
      connectedScopes: state.credentials
        .filter((credential) => credential.extensionId === "surfe" && credential.scope !== "workspace")
        .map((credential) => credential.scope),
      methods: surfeMethods,
    });
  if (pathname === "/api/extensions/linear")
    return sendJson(res, {
      id: "linear",
      name: "Linear",
      category: "project-management",
      description: "Linear issues, projects, teams, cycles, customers, documents, integrations, and administration (516 active GraphQL operations).",
      version: "1.0.0",
      baseUrl: "https://api.linear.app",
      logo: linearLogo,
      auth: {
        type: "apiKey",
        header: "Authorization",
        secretKey: "apiKey",
        credentialLabel: "personal API key",
      },
      connected: state.credentials.some((credential) => credential.extensionId === "linear" && credential.scope !== "workspace"),
      connectedScopes: state.credentials
        .filter((credential) => credential.extensionId === "linear" && credential.scope !== "workspace")
        .map((credential) => credential.scope),
      methods: linearMethods,
    });
  if (pathname === "/api/extensions/theirstack")
    return sendJson(res, {
      id: "theirstack",
      name: "TheirStack",
      category: "enrichment",
      description: "TheirStack jobs, companies, technographics, buying intent, lists, datasets, catalogs, saved searches, and webhooks (51 active endpoints).",
      version: "1.0.0",
      baseUrl: "https://api.theirstack.com",
      logo: theirStackLogo,
      auth: {
        type: "apiKey",
        header: "Authorization",
        secretKey: "apiKey",
        credentialLabel: "API key",
      },
      connected: state.credentials.some((credential) => credential.extensionId === "theirstack" && credential.scope !== "workspace"),
      connectedScopes: state.credentials
        .filter((credential) => credential.extensionId === "theirstack" && credential.scope !== "workspace")
        .map((credential) => credential.scope),
      methods: theirStackMethods,
    });
  if (pathname === "/api/extensions/peopledatalabs")
    return sendJson(res, {
      id: "peopledatalabs",
      name: "People Data Labs",
      category: "enrichment",
      description: "People Data Labs person, company, search, cleaning, job, changelog, and privacy APIs (27 production operations).",
      version: "1.0.0",
      baseUrl: "https://api.peopledatalabs.com",
      logo: peopleDataLabsLogo,
      auth: {
        type: "apiKey",
        header: "X-Api-Key",
        secretKey: "apiKey",
        credentialLabel: "API key",
      },
      connected: state.credentials.some((credential) => credential.extensionId === "peopledatalabs" && credential.scope !== "workspace"),
      connectedScopes: state.credentials
        .filter((credential) => credential.extensionId === "peopledatalabs" && credential.scope !== "workspace")
        .map((credential) => credential.scope),
      methods: peopleDataLabsMethods,
    });
  if (pathname === "/api/extensions/lemlist")
    return sendJson(res, {
      id: "lemlist",
      name: "Lemlist",
      category: "sales-engagement",
      description: "Lemlist campaigns, leads, CRM, inbox, enrichment, deliverability, sequences, tasks, signals, and webhooks (140 operations).",
      version: "1.0.0",
      baseUrl: "https://api.lemlist.com/api",
      logo: lemlistLogo,
      auth: { type: "apiKey", header: "Authorization", secretKey: "apiKey", credentialLabel: "API key" },
      connected: state.credentials.some((credential) => credential.extensionId === "lemlist" && credential.scope !== "workspace"),
      connectedScopes: state.credentials
        .filter((credential) => credential.extensionId === "lemlist" && credential.scope !== "workspace")
        .map((credential) => credential.scope),
      methods: lemlistMethods,
    });
  if (pathname === "/api/extensions/slack")
    // Derived, so `auth: { type: "oauth" }` and every method's credits come from
    // extensions/slack.json rather than a copy that can disagree with it. The
    // copy DID disagree: it billed 1 credit per method where the manifest
    // declares 0.
    return sendJson(res, { ...manifestDetail(slackManifest), connected: state.slackConnected });
  if (pathname === "/api/extensions/attio")
    return sendJson(res, {
      id: "attio",
      name: "Attio",
      category: "crm",
      description: "Attio CRM — records, lists and webhooks via the v2 REST API.",
      version: "1.0.0",
      baseUrl: "https://api.attio.com",
      logo: attioLogo,
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
      logo: hubspotLogo,
      auth: { type: "apiKey", header: "Authorization", secretKey: "apiKey" },
      connected: false,
      connectedScopes: [],
      methods: [{ id: "objects.list", label: "List records", description: "GET /crm/v3/objects/{object}", credits: 1 }],
    });
  const genericExtensionMatch = reviewAllTools ? pathname.match(/^\/api\/extensions\/([^/]+)$/) : null;
  if (genericExtensionMatch) {
    const manifest = extensionManifestById.get(decodeURIComponent(genericExtensionMatch[1]));
    if (manifest) return sendJson(res, manifestDetail(manifest));
  }
  if (pathname === "/api/extensions/zoominfo/connect" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    state.credentials.push({
      workspaceId: state.workspaceId,
      extensionId: "zoominfo",
      scope: body.scope ?? "local",
      name: "default",
      secrets: body.secrets ?? {},
    });
    return sendJson(res, { ok: true });
  }
  if (pathname === "/api/extensions/surfe/connect" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    state.credentials.push({
      workspaceId: state.workspaceId,
      extensionId: "surfe",
      scope: body.scope ?? "local",
      name: "default",
      secrets: body.secrets ?? {},
    });
    return sendJson(res, { ok: true });
  }
  if (pathname === "/api/extensions/linear/connect" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    state.credentials.push({
      workspaceId: state.workspaceId,
      extensionId: "linear",
      scope: body.scope ?? "local",
      name: "default",
      secrets: body.secrets ?? {},
    });
    return sendJson(res, { ok: true });
  }
  if (pathname === "/api/extensions/theirstack/connect" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    state.credentials.push({
      workspaceId: state.workspaceId,
      extensionId: "theirstack",
      scope: body.scope ?? "local",
      name: "default",
      secrets: body.secrets ?? {},
    });
    return sendJson(res, { ok: true });
  }
  if (pathname === "/api/extensions/peopledatalabs/connect" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    state.credentials.push({
      workspaceId: state.workspaceId,
      extensionId: "peopledatalabs",
      scope: body.scope ?? "local",
      name: "default",
      secrets: body.secrets ?? {},
    });
    return sendJson(res, { ok: true });
  }
  if (pathname === "/api/extensions/lemlist/connect" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    state.credentials.push({
      workspaceId: state.workspaceId,
      extensionId: "lemlist",
      scope: body.scope ?? "local",
      name: "default",
      secrets: body.secrets ?? {},
    });
    return sendJson(res, { ok: true });
  }
  const genericConnectMatch = reviewAllTools && method === "POST" ? pathname.match(/^\/api\/extensions\/([^/]+)\/connect$/) : null;
  if (genericConnectMatch) {
    const extensionId = decodeURIComponent(genericConnectMatch[1]);
    if (extensionManifestById.has(extensionId)) {
      const body = JSON.parse(await readBody(req));
      state.credentials.push({
        workspaceId: state.workspaceId,
        extensionId,
        scope: body.scope ?? "local",
        name: "default",
        secrets: body.secrets ?? {},
      });
      return sendJson(res, { ok: true });
    }
  }
  if (pathname === "/api/cloud/columns/run" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const column = state.columns.find((item) => item._id === body.columnId && item.tableId === body.tableId);
    if (!column) return sendJson(res, { error: "Connector column not found" }, 404);
    if (column.provider === "lemlist") {
      const credential = state.credentials.find((item) => item.extensionId === "lemlist");
      const token = credential?.secrets?.apiKey;
      const rows = state.rows.filter((row) => row.tableId === body.tableId && (!body.rowIds || body.rowIds.includes(row._id)));
      const targetRows = body.force ? rows : rows.filter((row) => state.cells[row._id]?.[column._id]?.status !== "done");

      if (!token || token === "invalid-token") {
        for (const row of targetRows) {
          if (!state.cells[row._id]) state.cells[row._id] = {};
          state.cells[row._id][column._id] = {
            value: null,
            status: "error",
            error: "Lemlist API key invalid or expired (HTTP 401)",
          };
        }
        state.lemlistCalls.push({ provider: column.provider, method: column.method, auth: "rejected" });
        return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: targetRows.length });
      }

      for (const row of targetRows) {
        const input = template(column.params ?? {}, row, state);
        state.lemlistCalls.push({
          provider: column.provider,
          method: column.method,
          authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
          path: `/campaigns/${input.campaignId}`,
        });
        if (!state.cells[row._id]) state.cells[row._id] = {};
        state.cells[row._id][column._id] = {
          value: {
            _id: input.campaignId,
            name: row._id === "row_1" ? "Acme outbound" : "Globex expansion",
            status: "running",
            creator: { userEmail: "owner@example.com" },
            senders: [{ email: "sender@example.com" }],
          },
          status: "done",
          error: null,
        };
      }
      return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: 0 });
    }
    if (column.provider === "peopledatalabs") {
      const credential = state.credentials.find((item) => item.extensionId === "peopledatalabs");
      const token = credential?.secrets?.apiKey;
      const rows = state.rows.filter((row) => row.tableId === body.tableId && (!body.rowIds || body.rowIds.includes(row._id)));
      const targetRows = body.force ? rows : rows.filter((row) => state.cells[row._id]?.[column._id]?.status !== "done");

      if (!token || token === "invalid-token") {
        for (const row of targetRows) {
          if (!state.cells[row._id]) state.cells[row._id] = {};
          state.cells[row._id][column._id] = {
            value: null,
            status: "error",
            error: "People Data Labs API key invalid or expired (HTTP 401)",
          };
        }
        state.peopleDataLabsCalls.push({ provider: column.provider, method: column.method, auth: "rejected" });
        return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: targetRows.length });
      }

      for (const row of targetRows) {
        const input = template(column.params ?? {}, row, state);
        state.peopleDataLabsCalls.push({
          provider: column.provider,
          method: column.method,
          headers: { "X-Api-Key": token },
          query: input,
        });
        if (!state.cells[row._id]) state.cells[row._id] = {};
        state.cells[row._id][column._id] = {
          value: {
            status: 200,
            likelihood: 10,
            data: {
              id: `pdl_${row._id}`,
              full_name: row._id === "row_1" ? "Ada Lovelace" : "Grace Hopper",
              email: input.email,
              job_title: row._id === "row_1" ? "VP Engineering" : "VP Platform",
              job_company_name: row._id === "row_1" ? "Acme" : "Globex",
            },
          },
          status: "done",
          error: null,
        };
      }
      return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: 0 });
    }
    if (column.provider === "theirstack") {
      const credential = state.credentials.find((item) => item.extensionId === "theirstack");
      const token = credential?.secrets?.apiKey;
      const rows = state.rows.filter((row) => row.tableId === body.tableId && (!body.rowIds || body.rowIds.includes(row._id)));
      const targetRows = body.force ? rows : rows.filter((row) => state.cells[row._id]?.[column._id]?.status !== "done");

      if (!token || token === "invalid-token") {
        for (const row of targetRows) {
          if (!state.cells[row._id]) state.cells[row._id] = {};
          state.cells[row._id][column._id] = {
            value: null,
            status: "error",
            error: "TheirStack API key invalid or expired (HTTP 401)",
          };
        }
        state.theirStackCalls.push({ provider: column.provider, method: column.method, auth: "rejected" });
        return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: targetRows.length });
      }

      for (const row of targetRows) {
        const input = template(column.params ?? {}, row, state);
        state.theirStackCalls.push({
          provider: column.provider,
          method: column.method,
          authorization: `Bearer ${token}`,
          body: input,
        });
        if (!state.cells[row._id]) state.cells[row._id] = {};
        state.cells[row._id][column._id] = {
          value: {
            data: [{
              id: `their_job_${row._id}`,
              job_title: input.job_title_or?.[0] ?? "VP Sales",
              company: row._id === "row_1" ? "Acme" : "Globex",
              company_domain: input.company_domain_or?.[0],
              date_posted: "2026-07-15",
              remote: true,
            }],
            metadata: { total_results: 1 },
          },
          status: "done",
          error: null,
        };
      }
      return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: 0 });
    }
    if (column.provider === "linear") {
      const credential = state.credentials.find((item) => item.extensionId === "linear");
      const token = credential?.secrets?.apiKey;
      const rows = state.rows.filter((row) => row.tableId === body.tableId && (!body.rowIds || body.rowIds.includes(row._id)));
      const targetRows = body.force ? rows : rows.filter((row) => state.cells[row._id]?.[column._id]?.status !== "done");

      if (!token || token === "invalid-token") {
        for (const row of targetRows) {
          if (!state.cells[row._id]) state.cells[row._id] = {};
          state.cells[row._id][column._id] = {
            value: null,
            status: "error",
            error: "Linear personal API key invalid or expired (HTTP 401)",
          };
        }
        state.linearCalls.push({ provider: column.provider, method: column.method, auth: "rejected" });
        return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: targetRows.length });
      }

      for (const row of targetRows) {
        const input = template(column.params ?? {}, row, state);
        state.linearCalls.push({
          provider: column.provider,
          method: column.method,
          authorization: token,
          graphql: { field: "issues", variables: input },
        });
        if (!state.cells[row._id]) state.cells[row._id] = {};
        state.cells[row._id][column._id] = {
          value: {
            nodes: [{
              id: `linear_${row._id}`,
              identifier: row._id === "row_1" ? "ENG-101" : "ENG-102",
              title: `${input.filter?.title?.contains ?? "Issue"} launch follow-up`,
              url: `https://linear.app/acme/issue/${row._id === "row_1" ? "ENG-101" : "ENG-102"}`,
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          status: "done",
          error: null,
        };
      }
      return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: 0 });
    }
    if (column.provider === "surfe") {
      const credential = state.credentials.find((item) => item.extensionId === "surfe");
      const token = credential?.secrets?.apiKey;
      const rows = state.rows.filter((row) => row.tableId === body.tableId && (!body.rowIds || body.rowIds.includes(row._id)));
      const targetRows = body.force ? rows : rows.filter((row) => state.cells[row._id]?.[column._id]?.status !== "done");

      if (!token || token === "invalid-token") {
        for (const row of targetRows) {
          if (!state.cells[row._id]) state.cells[row._id] = {};
          state.cells[row._id][column._id] = {
            value: null,
            status: "error",
            error: "Surfe API key invalid or expired (HTTP 401)",
          };
        }
        state.surfeCalls.push({ provider: column.provider, method: column.method, auth: "rejected" });
        return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: targetRows.length });
      }

      for (const row of targetRows) {
        const input = template(column.params ?? {}, row, state);
        state.surfeCalls.push({
          provider: column.provider,
          method: column.method,
          authorization: `Bearer ${token}`,
          body: input,
        });
        if (!state.cells[row._id]) state.cells[row._id] = {};
        state.cells[row._id][column._id] = {
          value: {
            people: [{
              externalID: `surfe_${row._id}`,
              companyDomain: input.companies?.domains?.[0],
              firstName: row._id === "row_1" ? "Ada" : "Grace",
              lastName: row._id === "row_1" ? "Lovelace" : "Hopper",
              jobTitle: input.people?.jobTitles?.[0],
            }],
            nextPageToken: "",
            total: 1,
          },
          status: "done",
          error: null,
        };
      }
      return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: 0 });
    }
    if (column.provider !== "zoominfo") return sendJson(res, { error: "Connector column not found" }, 404);
    const credential = state.credentials.find((item) => item.extensionId === "zoominfo");
    const token = credential?.secrets?.apiKey;
    const rows = state.rows.filter((row) => row.tableId === body.tableId && (!body.rowIds || body.rowIds.includes(row._id)));
    const targetRows = body.force ? rows : rows.filter((row) => state.cells[row._id]?.[column._id]?.status !== "done");

    if (!token || token === "invalid-token") {
      for (const row of targetRows) {
        if (!state.cells[row._id]) state.cells[row._id] = {};
        state.cells[row._id][column._id] = {
          value: null,
          status: "error",
          error: "ZoomInfo OAuth access token invalid or expired (HTTP 401)",
        };
      }
      state.zoomInfoCalls.push({ provider: column.provider, method: column.method, auth: "rejected" });
      return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: targetRows.length });
    }

    for (const row of targetRows) {
      const input = template(column.params ?? {}, row, state);
      state.zoomInfoCalls.push({
        provider: column.provider,
        method: column.method,
        authorization: `Bearer ${token}`,
        query: { "page[size]": input["page[size]"] },
        body: { data: input.data },
      });
      if (!state.cells[row._id]) state.cells[row._id] = {};
      state.cells[row._id][column._id] = {
        value: { data: [{ id: `zi_${row._id}`, type: "Contact", attributes: { companyName: input.data?.attributes?.companyName } }] },
        status: "done",
        error: null,
      };
    }
    return sendJson(res, { ran: targetRows.length, skipped: rows.length - targetRows.length, errors: 0 });
  }
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
