import { createHash } from "node:crypto";
import { inngest } from "../../../../lib/inngest/client";
import { signatureCheckPasses } from "../../../../lib/webhook-signature";

/**
 * The public webhook receiver. A third party POSTs JSON to
 * `/api/webhooks/<token>`; this route:
 *
 *  1. Resolves the token via the worker endpoint `/api/worker/resolveToken`
 *     (secret-gated with `WEBHOOK_WORKER_SECRET`). Unknown OR disabled tokens
 *     resolve to `null` and are rejected with 404 WITHOUT leaking which (no
 *     per-reason message).
 *  2. When the webhook has OPTED IN to signature auth (a `signingSecret` is
 *     set), verifies the `X-GTMGrid-Signature` header —
 *     `hex(HMAC-SHA256(signingSecret, rawBody))` — in constant time; a
 *     missing/invalid signature → 401. Without a secret the endpoint accepts
 *     unsigned posts: the unguessable token IS the credential, which is what
 *     most third-party senders (no custom HMAC support) can work with.
 *  3. Applies the stored field mapping (`[{ path, columnId }]`) to the parsed
 *     JSON, producing a `{ columnId: value }` map.
 *  4. Computes an idempotent `recordId` (an inbound idempotency header, else
 *     `sha256(token + ':' + stableStringify(body))`) and enqueues
 *     `webhook/record.received` with `id: recordId` so retries / duplicate posts
 *     don't double-insert.
 *  5. Returns 202 Accepted (the row insert + enrichment happen durably in the
 *     Inngest worker).
 *
 * Node runtime: uses `node:crypto` for HMAC verification + hashing.
 */
export const runtime = "nodejs";

/** A single field-mapping entry: a JSON path → the target column id. */
interface MappingEntry {
  readonly path: string;
  readonly columnId: string;
}

/** The resolved webhook config the worker route returns (or `null`). */
interface ResolvedWebhook {
  readonly webhookId: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly mapping: readonly MappingEntry[];
  readonly signingSecret: string | null;
  readonly autoRun: boolean;
  readonly mode: "create" | "upsert";
  readonly upsertKey: string | null;
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Resolve the base URL of the apps/web deployment serving the worker endpoints. */
function workerBaseUrl(): string {
  const url = process.env.SITE_URL;
  if (url === undefined || url === "") {
    throw new Error("SITE_URL is not configured");
  }
  return url.replace(/\/$/, "");
}

/** Resolve the shared worker bearer secret, failing closed when unset. */
function workerSecret(): string {
  const secret = process.env.WEBHOOK_WORKER_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("WEBHOOK_WORKER_SECRET is not configured");
  }
  return secret;
}

/** Resolve a token to its webhook config (or `null`) via the secret-gated endpoint. */
async function resolveToken(token: string): Promise<ResolvedWebhook | null> {
  const res = await fetch(`${workerBaseUrl()}/api/worker/resolveToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerSecret()}`,
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    throw new Error(`resolveToken failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (text === "") return null;
  const parsed = JSON.parse(text);
  return parsed === null ? null : (parsed as ResolvedWebhook);
}

/**
 * Read a value out of `body` at a dotted/bracketed `path` (e.g. `a.b[0].c` or
 * `payload.email`). Returns `undefined` when any segment is missing.
 */
function valueAtPath(body: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .filter((s) => s.length > 0);
  let current: unknown = body;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Apply the stored mapping to the body → `{ columnId: value }` (skip missing). */
function applyMapping(
  body: unknown,
  mapping: readonly MappingEntry[],
): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (const entry of mapping) {
    const value = valueAtPath(body, entry.path);
    if (value === undefined) continue;
    cells[entry.columnId] = value;
  }
  return cells;
}

/**
 * Deterministic JSON stringify with sorted object keys, so two semantically
 * equal payloads (key order aside) hash to the same `recordId`.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * The idempotency key for a record: a caller-supplied idempotency header when
 * present, else `sha256(token + ':' + stableStringify(body))`.
 */
function computeRecordId(
  token: string,
  body: unknown,
  idempotencyHeader: string | null,
): string {
  if (idempotencyHeader !== null && idempotencyHeader !== "") {
    return createHash("sha256")
      .update(`${token}:${idempotencyHeader}`)
      .digest("hex");
  }
  return createHash("sha256")
    .update(`${token}:${stableStringify(body)}`)
    .digest("hex");
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  // Read the RAW body once — HMAC is computed over the exact bytes received.
  const rawBody = await req.text();

  const webhook = await resolveToken(token);
  // Unknown OR disabled → 404 with no per-reason detail (no information leak).
  if (webhook === null) {
    return json({ error: "Not found" }, 404);
  }

  // Auth gate BEFORE parsing/acting on the body: signature auth is OPT-IN —
  // enforced only for webhooks that have a signing secret set.
  const signature = req.headers.get("X-GTMGrid-Signature");
  if (!signatureCheckPasses(rawBody, signature, webhook.signingSecret)) {
    return json({ error: "Invalid signature" }, 401);
  }

  let body: unknown;
  try {
    body = rawBody === "" ? {} : JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const mappedCells = applyMapping(body, webhook.mapping);

  const idempotencyHeader =
    req.headers.get("Idempotency-Key") ?? req.headers.get("X-Idempotency-Key");
  const recordId = computeRecordId(token, body, idempotencyHeader);

  await inngest.send({
    id: recordId,
    name: "webhook/record.received",
    data: {
      webhookId: webhook.webhookId,
      tableId: webhook.tableId,
      workspaceId: webhook.workspaceId,
      mappedCells,
      autoRun: webhook.autoRun,
      mode: webhook.mode,
      upsertKey: webhook.upsertKey,
      recordId,
    },
  });

  return json({ accepted: true, recordId }, 202);
}
