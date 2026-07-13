/**
 * Cross-cutting regression test for the WORKER-ENDPOINT shared-secret GATE
 * (TRI-3258 follow-up). The pure `isAuthorizedWorker` is unit-tested in
 * `@gtmgrid/services` (`worker-secret.test.ts`); this proves the gate as wired
 * into the actual route boundary helper `runWorker` (apps/web/app/api/worker/
 * _lib.ts) — the trust boundary every `/api/worker/*` route shares:
 *
 *   - REJECT (401) a missing / wrong / malformed bearer BEFORE any service or DB
 *     access runs (fail-closed when WEBHOOK_WORKER_SECRET is unset).
 *   - ACCEPT the correct bearer: the request passes the gate and proceeds to body
 *     parsing (here an invalid body yields 400 — reached only AFTER auth passed,
 *     so this asserts the gate let the caller THROUGH without opening a DB).
 *   - The `X-Gtmgrid-Member` header (forwarded by packages/server/src/cloud-run.ts
 *     line 113) is NOT consulted by the gate or by `runWorker`: an authorized
 *     request behaves identically with a bogus member header. The header is a
 *     NOTED FOLLOW-UP — these routes run `appLayer({ userId: null })`, so the
 *     worker has no member identity and the secret (not membership) is the trust
 *     boundary. This test pins that current behaviour.
 *
 * Also covers the zod body-validation gate added with `runWorker(req, schema,
 * build)`: a valid bearer + valid-JSON-but-wrong-SHAPE body is rejected 400 by
 * the schema BEFORE any service/DB access — the new input-validation boundary.
 *
 * Run OFFLINE: the reject + bad-body paths never reach the dynamic
 * `@gtmgrid/db/client` import (which happens only after a valid body), so NO
 * DATABASE_URL / live database is required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { z } from "zod";
import { runWorker, runWorkerSecretOrMember } from "../../app/api/worker/_lib";
import { GetTableSchema } from "../../app/api/worker/_schemas";

const SECRET = "whk_secret_value";

/** A passthrough schema for the auth-gate tests (body shape is not the subject). */
const anySchema = z.unknown();

/** Build a worker POST Request with optional Authorization + member header. */
function workerRequest(opts: {
  auth?: string | null;
  member?: string;
  body?: string;
}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth != null) headers.Authorization = opts.auth;
  if (opts.member !== undefined) headers["X-Gtmgrid-Member"] = opts.member;
  return new Request("https://app.gtmgrid.test/api/worker/getTable", {
    method: "POST",
    headers,
    body: opts.body ?? "{}",
  });
}

// A build callback that must NEVER run on the reject paths. If the gate is
// broken and lets an unauthorized caller through, this would execute and the
// status assertions would fail loudly.
const succeedBuild = () => Effect.succeed({ ok: true });

beforeEach(() => {
  process.env.WEBHOOK_WORKER_SECRET = SECRET;
});

afterEach(() => {
  process.env.WEBHOOK_WORKER_SECRET = SECRET;
});

describe("worker shared-secret gate (runWorker)", () => {
  it("rejects a request with NO Authorization header (401)", async () => {
    const res = await runWorker(workerRequest({ auth: null }), anySchema, succeedBuild);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a WRONG bearer secret (401)", async () => {
    const res = await runWorker(
      workerRequest({ auth: "Bearer not-the-secret" }),
      anySchema,
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer (Basic) Authorization scheme (401)", async () => {
    const res = await runWorker(
      workerRequest({ auth: `Basic ${SECRET}` }),
      anySchema,
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when WEBHOOK_WORKER_SECRET is UNSET (401 even with a bearer)", async () => {
    process.env.WEBHOOK_WORKER_SECRET = "";
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}` }),
      anySchema,
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });

  it("ACCEPTS the correct bearer: passes the gate, then 400 on an invalid body (no DB opened)", async () => {
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: "{ not json" }),
      anySchema,
      succeedBuild,
    );
    // 400 (not 401) proves the gate let the authorized caller THROUGH; the
    // bad-body branch returns BEFORE the dynamic @gtmgrid/db/client import.
    expect(res.status).toBe(400);
  });

  it("IGNORES the X-Gtmgrid-Member header: an authorized request is unaffected by a bogus member (noted follow-up)", async () => {
    const withMember = await runWorker(
      workerRequest({
        auth: `Bearer ${SECRET}`,
        member: "spoofed-member-token",
        body: "{ not json",
      }),
      anySchema,
      succeedBuild,
    );
    const withoutMember = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: "{ not json" }),
      anySchema,
      succeedBuild,
    );
    // Same outcome with or without the member header — runWorker never reads it
    // (the worker runs userId:null; the secret is the only trust boundary).
    expect(withMember.status).toBe(withoutMember.status);
    expect(withMember.status).toBe(400);
  });

  it("a bogus X-Gtmgrid-Member does NOT bypass the secret gate (401)", async () => {
    const res = await runWorker(
      workerRequest({ auth: null, member: "spoofed-member-token" }),
      anySchema,
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });
});

describe("worker dual-auth boundary (runWorkerSecretOrMember)", () => {
  it("HEADLESS path: a valid worker secret passes the gate, then 400 on bad body (no DB / no member resolve)", async () => {
    const res = await runWorkerSecretOrMember(
      workerRequest({ auth: `Bearer ${SECRET}`, body: "{ not json" }),
      anySchema,
      succeedBuild,
    );
    // Secret authorized → headless path → body parse runs BEFORE any member
    // resolution or the dynamic @gtmgrid/db/client import, so this is a clean 400.
    expect(res.status).toBe(400);
  });

  it("MEMBER path: NO worker secret AND NO member token → 401 (fail-closed before Better Auth / DB)", async () => {
    // No Authorization (so not the headless path) and no X-Gtmgrid-Member, so
    // resolveMemberUserId returns null WITHOUT calling Better Auth → 401 here,
    // before the service ever runs. This is the path the prod desktop must NOT
    // hit: it always forwards a member token.
    const res = await runWorkerSecretOrMember(
      workerRequest({ auth: null }),
      anySchema,
      succeedBuild,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("MEMBER path: a wrong worker secret is NOT headless — falls through, and with no member token → 401", async () => {
    const res = await runWorkerSecretOrMember(
      workerRequest({ auth: "Bearer not-the-secret" }),
      anySchema,
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });
});

describe("worker body validation (zod schema gate)", () => {
  it("rejects valid JSON that FAILS the schema with 400 BEFORE any service/DB (missing required field)", async () => {
    // Authorized + well-formed JSON, but missing the required `tableId`. The zod
    // gate returns 400 before workerRuntime()/the db import, so this runs offline.
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: JSON.stringify({}) }),
      GetTableSchema,
      succeedBuild,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid request body/);
    expect(body.error).toMatch(/tableId/);
  });

  it("rejects an empty-string id (min(1)) with 400", async () => {
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: JSON.stringify({ tableId: "" }) }),
      GetTableSchema,
      succeedBuild,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Invalid request body/);
  });

  it("rejects a wrong-typed field with 400", async () => {
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: JSON.stringify({ tableId: 123 }) }),
      GetTableSchema,
      succeedBuild,
    );
    expect(res.status).toBe(400);
  });
});
