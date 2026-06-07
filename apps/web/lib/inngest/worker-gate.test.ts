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
 * Run OFFLINE: the reject + bad-body paths never reach the dynamic
 * `@gtmgrid/db/client` import (which happens only after a valid body), so NO
 * DATABASE_URL / live database is required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runWorker } from "../../app/api/worker/_lib";

const SECRET = "whk_secret_value";

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
    const res = await runWorker(workerRequest({ auth: null }), succeedBuild);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a WRONG bearer secret (401)", async () => {
    const res = await runWorker(
      workerRequest({ auth: "Bearer not-the-secret" }),
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer (Basic) Authorization scheme (401)", async () => {
    const res = await runWorker(
      workerRequest({ auth: `Basic ${SECRET}` }),
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when WEBHOOK_WORKER_SECRET is UNSET (401 even with a bearer)", async () => {
    process.env.WEBHOOK_WORKER_SECRET = "";
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}` }),
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });

  it("ACCEPTS the correct bearer: passes the gate, then 400 on an invalid body (no DB opened)", async () => {
    const res = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: "{ not json" }),
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
      succeedBuild,
    );
    const withoutMember = await runWorker(
      workerRequest({ auth: `Bearer ${SECRET}`, body: "{ not json" }),
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
      succeedBuild,
    );
    expect(res.status).toBe(401);
  });
});
