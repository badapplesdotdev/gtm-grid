/**
 * `SheetImportService.syncForWorker` end to end, against a stubbed Sheets API.
 *
 * The mapping tests next door cover the pure alignment rules; this covers the
 * part that actually touches the grid, which is where the expensive failures
 * live — duplicate rows on every sync, cells that never clear, a revoked grant
 * retried hourly forever.
 *
 * Everything except Google's HTTP runs for real in-memory: credential decrypt,
 * the identity map, row/cell inserts, and the binding's own bookkeeping.
 */

import { CredentialCryptoService } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialCryptoTest } from "../credential-crypto-test.js";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { GridTable } from "../repositories/webhook-repo.js";
import type { SheetBinding } from "../repositories/sheet-repo.js";
import { SheetRepo } from "../repositories/sheet-repo.js";
import { WebhookRepo } from "../repositories/webhook-repo.js";
import { SheetImportService } from "./sheet-import-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const TABLE = "22222222-2222-2222-2222-222222222222";
const BINDING = "sheet-1";
const COL_COMPANY = "col-company";
const COL_DOMAIN = "col-domain";

const table = (): GridTable => ({
  id: TABLE,
  workspaceId: WS,
  projectId: "proj-1",
  name: "Leads",
  position: 0,
  createdAt: 1,
});

const binding = (over: Partial<SheetBinding> = {}): SheetBinding => ({
  id: BINDING,
  workspaceId: WS,
  tableId: TABLE,
  spreadsheetId: "sheet_abc",
  spreadsheetName: "Q3 Leads",
  sheetTitle: "Leads",
  headerRow: 1,
  columns: [
    { header: "Company", columnId: COL_COMPANY },
    { header: "Domain", columnId: COL_DOMAIN },
  ],
  keyHeader: "Domain",
  schedule: "daily",
  enabled: true,
  pausedReason: null,
  lastSyncedAt: null,
  lastError: null,
  rowsSynced: 0,
  createdAt: 1,
  ...over,
});

/** Encrypt a Google connection with the SAME test crypto the TestLayer uses. */
const encryptedGoogle = (workspaceId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* CredentialCryptoService;
      return yield* c.encrypt(workspaceId, {
        accessToken: "ya29.live",
        refreshToken: "1//rt",
        googleEmail: "morgan@trigify.io",
        pickedFiles: JSON.stringify([{ id: "sheet_abc", name: "Q3 Leads" }]),
      });
    }).pipe(Effect.provide(credentialCryptoTest())),
  );

/** Stub the Sheets values endpoint with a raw grid, or a status code. */
const stubSheets = (grid: readonly (readonly string[])[] | number) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      typeof grid === "number"
        ? new Response(JSON.stringify({ error: { code: grid } }), { status: grid })
        : new Response(JSON.stringify({ values: grid }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    ),
  );

const fixturesWith = async (bindings: SheetBinding[]): Promise<TestLayerFixtures> => ({
  // The cron runtime has NO member identity — this is the path that matters.
  currentUserId: null,
  workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
  memberships: [],
  users: [],
  gridTables: [table()],
  sheetBindings: bindings,
  credentials: [
    {
      id: "cred-google",
      workspaceId: WS,
      extensionId: "google",
      scope: "workspace",
      name: "Google",
      ownerUserId: null,
      secretsEnc: await encryptedGoogle(WS),
      createdAt: 1,
    },
  ],
});

/** Run a program against a TestLayer, returning the layer's own repos too. */
const runWith = <A, E>(
  fixtures: TestLayerFixtures,
  program: (svc: typeof SheetImportService.Service, repos: {
    readonly sheets: typeof SheetRepo.Service;
    readonly grid: typeof WebhookRepo.Service;
  }) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* SheetImportService;
      const sheets = yield* SheetRepo;
      const grid = yield* WebhookRepo;
      return yield* program(svc, { sheets, grid });
    }).pipe(Effect.provide(TestLayer(fixtures))),
  );

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    throw new Error(
      `expected success, got: ${Option.isSome(failure) ? JSON.stringify(failure.value) : "defect"}`,
    );
  }
  return exit.value;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("syncForWorker — first import", () => {
  it("creates one grid row per sheet row, with cells on the mapped columns", async () => {
    stubSheets([
      ["Company", "Domain"],
      ["Acme", "acme.com"],
      ["Beta", "beta.com"],
    ]);
    const fixtures = await fixturesWith([binding()]);

    const out = value(
      await runWith(fixtures, (svc, { grid }) =>
        Effect.gen(function* () {
          const result = yield* svc.syncForWorker(BINDING);
          const rows = yield* grid.listRows(TABLE);
          const cells = yield* grid.listCellsByTable(TABLE);
          return { result, rowCount: rows.length, cells };
        }),
      ),
    );

    expect(out.result.rowsCreated).toBe(2);
    expect(out.result.rowsUpdated).toBe(0);
    expect(out.rowCount).toBe(2);
    // Two rows × two mapped columns.
    expect(out.cells).toHaveLength(4);
    expect(out.cells.map((c) => c.value).sort()).toEqual(["Acme", "Beta", "acme.com", "beta.com"]);
  });

  it("records the binding's bookkeeping and clears any pause", async () => {
    stubSheets([
      ["Company", "Domain"],
      ["Acme", "acme.com"],
    ]);
    const fixtures = await fixturesWith([binding({ pausedReason: "auth_revoked" })]);

    const after = value(
      await runWith(fixtures, (svc, { sheets }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING);
          return yield* sheets.findById(BINDING);
        }),
      ),
    );

    expect(Option.isSome(after)).toBe(true);
    if (Option.isSome(after)) {
      expect(after.value.rowsSynced).toBe(1);
      expect(after.value.lastSyncedAt).not.toBeNull();
      // A successful sync proves the grant works, so the pause must lift.
      expect(after.value.pausedReason).toBeNull();
    }
  });
});

describe("syncForWorker — re-sync", () => {
  it("does NOT duplicate rows when the sheet is unchanged", async () => {
    // The single most important property of the identity map.
    const grid = [
      ["Company", "Domain"],
      ["Acme", "acme.com"],
      ["Beta", "beta.com"],
    ];
    stubSheets(grid);
    const fixtures = await fixturesWith([binding()]);

    const out = value(
      await runWith(fixtures, (svc, { grid: g }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING);
          const second = yield* svc.syncForWorker(BINDING);
          const rows = yield* g.listRows(TABLE);
          return { second, rowCount: rows.length };
        }),
      ),
    );

    expect(out.rowCount).toBe(2);
    expect(out.second.rowsCreated).toBe(0);
    // Unchanged hash ⇒ the cell writes are skipped entirely, not rewritten.
    expect(out.second.rowsUpdated).toBe(0);
  });

  it("UPDATES the existing row when a value changes upstream", async () => {
    const fixtures = await fixturesWith([binding()]);

    const out = value(
      await runWith(fixtures, (svc, { grid }) =>
        Effect.gen(function* () {
          stubSheets([
            ["Company", "Domain"],
            ["Acme", "acme.com"],
          ]);
          yield* svc.syncForWorker(BINDING);

          // Same key, renamed company.
          stubSheets([
            ["Company", "Domain"],
            ["Acme Corp", "acme.com"],
          ]);
          const second = yield* svc.syncForWorker(BINDING);

          const rows = yield* grid.listRows(TABLE);
          const cells = yield* grid.listCellsByTable(TABLE);
          return { second, rowCount: rows.length, cells };
        }),
      ),
    );

    expect(out.rowCount).toBe(1);
    expect(out.second.rowsCreated).toBe(0);
    expect(out.second.rowsUpdated).toBe(1);
    expect(out.cells.map((c) => c.value)).toContain("Acme Corp");
    expect(out.cells.map((c) => c.value)).not.toContain("Acme");
  });

  it("CLEARS a grid cell when the sheet cell is emptied", async () => {
    // This is what `hasValue: true` buys. Without it the merge COALESCEs and the
    // stale value survives forever, so the sheet and the grid silently disagree.
    const fixtures = await fixturesWith([binding()]);

    const cells = value(
      await runWith(fixtures, (svc, { grid }) =>
        Effect.gen(function* () {
          stubSheets([
            ["Company", "Domain"],
            ["Acme", "acme.com"],
          ]);
          yield* svc.syncForWorker(BINDING);

          stubSheets([
            ["Company", "Domain"],
            ["", "acme.com"],
          ]);
          yield* svc.syncForWorker(BINDING);

          return yield* grid.listCellsByTable(TABLE);
        }),
      ),
    );

    const company = cells.find((c) => c.columnId === COL_COMPANY);
    expect(company?.value).toBe("");
  });

  it("keeps a grid row whose source row VANISHED from the sheet", async () => {
    // Deleting would destroy enrichment the user paid for, to mirror someone
    // tidying a spreadsheet.
    const fixtures = await fixturesWith([binding()]);

    const rowCount = value(
      await runWith(fixtures, (svc, { grid }) =>
        Effect.gen(function* () {
          stubSheets([
            ["Company", "Domain"],
            ["Acme", "acme.com"],
            ["Beta", "beta.com"],
          ]);
          yield* svc.syncForWorker(BINDING);

          stubSheets([
            ["Company", "Domain"],
            ["Acme", "acme.com"],
          ]);
          yield* svc.syncForWorker(BINDING);

          const rows = yield* grid.listRows(TABLE);
          return rows.length;
        }),
      ),
    );

    expect(rowCount).toBe(2);
  });
});

describe("syncForWorker — failure handling", () => {
  it("PAUSES the binding on 404 (deleted, or never picked)", async () => {
    stubSheets(404);
    const fixtures = await fixturesWith([binding()]);

    const after = value(
      await runWith(fixtures, (svc, { sheets }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING).pipe(Effect.ignore);
          return yield* sheets.findById(BINDING);
        }),
      ),
    );

    expect(Option.isSome(after) && after.value.pausedReason).toBe("file_gone");
    // The copy must name the never-picked case — it is the likelier cause.
    expect(Option.isSome(after) && after.value.lastError).toMatch(/never selected/i);
  });

  it("PAUSES on 403, so a revoked grant is not retried hourly forever", async () => {
    stubSheets(403);
    const fixtures = await fixturesWith([binding()]);

    const after = value(
      await runWith(fixtures, (svc, { sheets }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING).pipe(Effect.ignore);
          return yield* sheets.findById(BINDING);
        }),
      ),
    );

    expect(Option.isSome(after) && after.value.pausedReason).toBe("auth_revoked");
  });

  it("does NOT pause on a transient 500 — that must retry", async () => {
    stubSheets(500);
    const fixtures = await fixturesWith([binding()]);

    const after = value(
      await runWith(fixtures, (svc, { sheets }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING).pipe(Effect.ignore);
          return yield* sheets.findById(BINDING);
        }),
      ),
    );

    expect(Option.isSome(after) && after.value.pausedReason).toBeNull();
  });

  it("pauses when the workspace has NO Google connection at all", async () => {
    stubSheets([["Company", "Domain"]]);
    const fixtures = { ...(await fixturesWith([binding()])), credentials: [] };

    const after = value(
      await runWith(fixtures, (svc, { sheets }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING).pipe(Effect.ignore);
          return yield* sheets.findById(BINDING);
        }),
      ),
    );

    expect(Option.isSome(after) && after.value.pausedReason).toBe("auth_revoked");
  });

  it("is a no-op for a binding that no longer exists", async () => {
    stubSheets([["Company", "Domain"]]);
    const fixtures = await fixturesWith([]);
    const result = value(await runWith(fixtures, (svc) => svc.syncForWorker("gone")));
    expect(result).toEqual({ rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, truncated: false });
  });
});

describe("syncForWorker — no key column (row-number identity)", () => {
  it("still dedupes on re-sync when the sheet is untouched", async () => {
    const grid = [
      ["Company", "Domain"],
      ["Acme", "acme.com"],
      ["Beta", "beta.com"],
    ];
    stubSheets(grid);
    const fixtures = await fixturesWith([binding({ keyHeader: null })]);

    const out = value(
      await runWith(fixtures, (svc, { grid: g }) =>
        Effect.gen(function* () {
          yield* svc.syncForWorker(BINDING);
          const second = yield* svc.syncForWorker(BINDING);
          const rows = yield* g.listRows(TABLE);
          return { second, rowCount: rows.length };
        }),
      ),
    );

    expect(out.rowCount).toBe(2);
    expect(out.second.rowsCreated).toBe(0);
  });
});
