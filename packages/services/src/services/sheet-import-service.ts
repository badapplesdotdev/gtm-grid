/**
 * `SheetImportService` — pull a Google Sheet's rows into a grid table, and keep
 * them in sync.
 *
 * This is the piece a connector CANNOT be. Connector methods run once per row
 * and can only write into the row they were called for; nothing in that model
 * can CREATE rows. So importing is modelled on `CrmSyncService` instead: a
 * binding, an identity map, a schedule, and a pause reason.
 *
 * Three decisions carry most of the weight:
 *
 * 1. **Identity comes from a KEY COLUMN when there is one, and the sheet row
 *    number otherwise.** Row numbers are stable only for append-only sheets — the
 *    moment a human sorts or deletes a row, every subsequent row's identity
 *    shifts and a re-sync rewrites the wrong grid rows. That is not a bug we can
 *    fix, it is an inherent property of "no key", so the mode exists but the UI
 *    steers away from it and this file says so loudly.
 *
 * 2. **A values hash short-circuits unchanged rows.** A daily sync of a
 *    1000-row, mostly-static sheet should cost one API read and zero cell
 *    writes, not 10,000 upserts.
 *
 * 3. **Rows are never deleted.** A row removed from the spreadsheet keeps its
 *    grid row and everything enriched onto it. Deleting would silently destroy
 *    work the user paid for, to mirror an edit someone made in a spreadsheet.
 */

import { MembershipService } from "@gtmgrid/cloud";
import { createHash } from "node:crypto";
import { Data, Effect, Option } from "effect";
import { CrmAuthRevoked } from "../crm/errors.js";
import { type SheetBinding, type SheetBindingColumn, SheetRepo } from "../repositories/sheet-repo.js";
import { WebhookRepo } from "../repositories/webhook-repo.js";
import { GOOGLE_CONNECTION_SLOT } from "./google-auth.js";
import { OAuthCredentialService } from "./oauth-credential-service.js";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CryptoService } from "./crypto-service.js";
import { parseConnection } from "./google-connection-service.js";

/** Raised for Sheets API failures and malformed sheets. */
export class SheetImportError extends Data.TaggedError("SheetImportError")<{
  readonly message: string;
  readonly cause?: unknown;
  /** HTTP status when the failure came from a Sheets call (0 = network). */
  readonly status?: number;
}> {}

/**
 * How many source rows one sync ingests.
 *
 * A ceiling rather than pagination: the Sheets API returns a whole range in one
 * response, so the risk is not round trips but a 100k-row sheet becoming 100k
 * grid rows and a multi-minute transaction inside a worker step. Exceeding it is
 * LOGGED and surfaced on the binding, never silent — a truncated import that
 * looks complete is worse than one that says it stopped.
 */
export const MAX_ROWS_PER_SYNC = 5000;

/** Sample rows shown in the import preview. Enough to recognise the data, not to load it. */
export const PREVIEW_ROWS = 5;

/** Sheets API base. Reads only — imports never write back to the spreadsheet. */
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** A sync worth retrying: 429, any 5xx, or a network error (status 0). */
export const isTransientImportError = (e: SheetImportError): boolean =>
  e.status !== undefined && (e.status === 0 || e.status === 429 || e.status >= 500);

/**
 * Normalise a header for matching.
 *
 * Humans retype headers with different case and stray spaces, and a mapping that
 * broke because someone typed "Email " would present as "the import stopped
 * filling that column" with nothing in the UI to explain it.
 */
export const normalizeHeader = (h: string): string => h.trim().toLowerCase();

/** Stable hash of the mapped values, for the unchanged-row short circuit. */
export const valuesHashOf = (values: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);

/** A1 range covering the whole tab from the header row down. */
export const rangeFor = (binding: Pick<SheetBinding, "sheetTitle" | "headerRow">): string =>
  // Quote the tab name: real sheets are called "Q3 Leads" and "Won/Lost", and an
  // unquoted space or slash makes Google parse the range as something else
  // entirely. Internal single quotes double, per A1 notation.
  `'${binding.sheetTitle.replace(/'/g, "''")}'!A${binding.headerRow}:ZZ`;

/** One source row, already aligned to the binding's mapped columns. */
export interface MappedRow {
  readonly externalKey: string;
  /** Values in the same order as `binding.columns`. */
  readonly values: readonly string[];
}

/**
 * Turn the raw `values` grid into mapped rows.
 *
 * Pure and exported so the alignment rules are testable without HTTP — they are
 * where the subtle failures live:
 * - Google OMITS trailing empty cells, so rows are ragged and every index must
 *   be defensive.
 * - A header the binding maps but the sheet no longer has resolves to "" rather
 *   than throwing: a renamed column should blank a field, not fail the import.
 * - Rows whose key is empty are SKIPPED, not given a synthetic key. A blank key
 *   usually means a spacer row or a stray formula, and inventing identity for it
 *   creates a phantom grid row that reappears on every sync.
 */
export const mapRows = (
  grid: readonly (readonly string[])[],
  columns: readonly SheetBindingColumn[],
  keyHeader: string | null,
): { readonly rows: readonly MappedRow[]; readonly missingHeaders: readonly string[] } => {
  const header = grid[0] ?? [];
  const indexByHeader = new Map<string, number>();
  header.forEach((h, i) => {
    const key = normalizeHeader(String(h));
    // FIRST occurrence wins: duplicate headers are common in exported sheets,
    // and silently taking the last one moves data between columns.
    if (key !== "" && !indexByHeader.has(key)) indexByHeader.set(key, i);
  });

  const missingHeaders = columns
    .filter((c) => !indexByHeader.has(normalizeHeader(c.header)))
    .map((c) => c.header);

  const keyIndex = keyHeader === null ? null : indexByHeader.get(normalizeHeader(keyHeader)) ?? null;

  const rows: MappedRow[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const raw = grid[i] ?? [];
    const values = columns.map((c) => {
      const at = indexByHeader.get(normalizeHeader(c.header));
      return at === undefined ? "" : String(raw[at] ?? "");
    });
    // A wholly blank line is a spacer, not a record.
    if (values.every((v) => v === "")) continue;

    const externalKey =
      keyIndex === null
        ? // No key column: identity is the SHEET ROW NUMBER (1-based, offset by
          // the header row). Correct for append-only sheets, wrong after a sort.
          String(i + 1)
        : String(raw[keyIndex] ?? "").trim();
    if (externalKey === "") continue;
    rows.push({ externalKey, values });
  }
  return { rows, missingHeaders };
};

/** Map a Sheets HTTP failure onto a pause reason, or null when it is transient. */
export const pauseReasonFor = (status: number): string | null => {
  // 404 under `drive.file` is ambiguous by construction: the file may be
  // deleted, OR it may simply never have been picked. Both need the same human
  // action (re-pick or re-connect), so they share a reason.
  if (status === 404) return "file_gone";
  if (status === 401 || status === 403) return "auth_revoked";
  return null;
};

/** User-facing copy for a pause reason. Rendered directly; never a raw status. */
export const pauseCopy = (reason: string): string => {
  switch (reason) {
    case "auth_revoked":
      return "Google access was revoked. Reconnect Google to resume syncing.";
    case "file_gone":
      return "This spreadsheet is no longer reachable. It may have been deleted, or it was never selected — open Google settings and select it again.";
    case "sheet_gone":
      return "That tab no longer exists in the spreadsheet. Re-import to pick a different tab.";
    default:
      return "Syncing is paused and needs attention.";
  }
};

export class SheetImportService extends Effect.Service<SheetImportService>()("SheetImportService", {
  effect: Effect.gen(function* () {
    const repo = yield* SheetRepo;
    const grid = yield* WebhookRepo;
    const membership = yield* MembershipService;
    const credentials = yield* CredentialRepo;
    const crypto = yield* CryptoService;
    const oauth = yield* OAuthCredentialService;

    /**
     * A live Google access token for a workspace.
     *
     * Reads the shared row directly and refreshes through
     * `OAuthCredentialService`, matching the worker credential path — this runs
     * with no session (the cron's trust boundary is its own secret), so a
     * member-gated read would fail on the primary path.
     */
    const accessToken = (workspaceId: string) =>
      Effect.gen(function* () {
        const row = yield* credentials.findSharedForWorker({
          workspaceId,
          extensionId: GOOGLE_CONNECTION_SLOT,
        });
        if (Option.isNone(row)) {
          return yield* Effect.fail(
            new CrmAuthRevoked({ provider: "Google", detail: "no Google connection" }),
          );
        }
        const stored = yield* crypto.decrypt(workspaceId, row.value.secretsEnc);
        const fresh = yield* oauth
          .freshSecrets(workspaceId, GOOGLE_CONNECTION_SLOT, stored)
          .pipe(Effect.orElseSucceed(() => stored));
        const connection = parseConnection(fresh);
        if (connection === null) {
          return yield* Effect.fail(
            new CrmAuthRevoked({ provider: "Google", detail: "connection carries no token" }),
          );
        }
        return connection.tokens.accessToken;
      });

    /** Read a range from the Sheets API. */
    const readRange = (token: string, spreadsheetId: string, range: string) =>
      Effect.tryPromise({
        try: async () => {
          const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
          const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) {
            throw new SheetImportError({
              message: `Google Sheets returned ${res.status}`,
              status: res.status,
            });
          }
          const body: unknown = await res.json();
          const values = typeof body === "object" && body !== null ? Reflect.get(body, "values") : undefined;
          if (!Array.isArray(values)) return [] as readonly (readonly string[])[];
          return values.map((r: unknown) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : []));
        },
        // status 0 marks a network failure, which the retry policy treats as
        // transient — distinct from a 4xx, which never succeeds on retry.
        catch: (cause) =>
          cause instanceof SheetImportError
            ? cause
            : new SheetImportError({ message: "Could not reach Google Sheets", cause, status: 0 }),
      });

    /**
     * The sync itself. No membership check — the worker's own trust boundary
     * (its shared secret) governs the caller, exactly as `SignalService`'s
     * worker method does.
     */
    const syncForWorker = (bindingId: string) =>
      Effect.gen(function* () {
        const found = yield* repo.findById(bindingId);
        if (Option.isNone(found)) {
          return { rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 0, truncated: false };
        }
        const binding = found.value;

        const token = yield* accessToken(binding.workspaceId).pipe(
          // A dead grant is a USER-resolvable halt, not a retry loop: pause the
          // binding so the cron stops re-attempting and the app can show a
          // reconnect banner.
          Effect.catchTag("CrmAuthRevoked", (e) =>
            repo
              .patch(bindingId, { pausedReason: "auth_revoked", lastError: pauseCopy("auth_revoked") })
              .pipe(Effect.andThen(Effect.fail(new SheetImportError({ message: e.detail ?? "auth revoked" })))),
          ),
        );

        const raw = yield* readRange(token, binding.spreadsheetId, rangeFor(binding)).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              const reason = e.status === undefined ? null : pauseReasonFor(e.status);
              if (reason !== null) {
                yield* repo.patch(bindingId, { pausedReason: reason, lastError: pauseCopy(reason) });
              } else {
                yield* repo.patch(bindingId, { lastError: "Could not read the spreadsheet. Will retry." });
              }
            }),
          ),
        );

        const { rows: allRows, missingHeaders } = mapRows(raw, binding.columns, binding.keyHeader);
        const truncated = allRows.length > MAX_ROWS_PER_SYNC;
        const rows = truncated ? allRows.slice(0, MAX_ROWS_PER_SYNC) : allRows;
        if (truncated) {
          yield* Effect.logWarning(
            `sheet import ${bindingId}: ${allRows.length} rows exceeds the ${MAX_ROWS_PER_SYNC} cap; ingesting the first ${MAX_ROWS_PER_SYNC}`,
          );
        }

        // Existing identities, so we know insert-vs-update before writing.
        const existing = yield* repo.findSyncedByKeys(bindingId, rows.map((r) => r.externalKey));
        const byKey = new Map(existing.map((e) => [e.externalKey, e]));

        const now = Date.now();
        const toInsert = rows.filter((r) => !byKey.has(r.externalKey));
        const toUpdate = rows.filter((r) => {
          const hit = byKey.get(r.externalKey);
          // The short circuit: an unchanged hash means every mapped cell already
          // holds this value, so the write is pure cost.
          return hit !== undefined && hit.valuesHash !== valuesHashOf(r.values);
        });

        let insertedIds: readonly string[] = [];
        if (toInsert.length > 0) {
          const base = yield* grid.maxRowPosition(binding.tableId);
          insertedIds = yield* grid.insertRowsWithCellsBulk(
            toInsert.map((_r, i) => ({
              workspaceId: binding.workspaceId,
              tableId: binding.tableId,
              position: base + i + 1,
              createdAt: now,
            })),
            (rowIds) =>
              toInsert.flatMap((r, i) => {
                const rowId = rowIds[i];
                if (rowId === undefined) return [];
                return binding.columns.flatMap((col, ci) => {
                  const value = r.values[ci] ?? "";
                  if (value === "") return [];
                  return [
                    {
                      workspaceId: binding.workspaceId,
                      tableId: binding.tableId,
                      rowId,
                      columnId: col.columnId,
                      cell: { value, status: "done", error: null, updatedAt: now },
                    },
                  ];
                });
              }),
          );
        }

        // Updates go through upsertCell so a cell the user has since cleared is
        // restored, and so metering stays consistent with every other write path.
        for (const r of toUpdate) {
          const hit = byKey.get(r.externalKey);
          if (hit === undefined) continue;
          for (const [ci, col] of binding.columns.entries()) {
            yield* grid.upsertCell({
              workspaceId: binding.workspaceId,
              tableId: binding.tableId,
              rowId: hit.rowId,
              columnId: col.columnId,
              // `hasValue: true` is load-bearing, not boilerplate. It is what
              // tells the merge to OVERWRITE rather than COALESCE — so when a
              // user clears a cell in the spreadsheet, the sync clears the grid
              // cell too. Omitting it keeps the stale value forever, and the
              // sheet and the grid silently disagree with no error anywhere.
              patch: { hasValue: true, value: r.values[ci] ?? "", status: "done", error: null },
              // Imported cells are not user actions; metering them would bill a
              // workspace for someone else editing a spreadsheet.
              meter: false,
              updatedAt: now,
            });
          }
        }

        yield* repo.upsertSynced(bindingId, [
          ...toInsert.flatMap((r, i) => {
            const rowId = insertedIds[i];
            return rowId === undefined
              ? []
              : [{ rowId, externalKey: r.externalKey, valuesHash: valuesHashOf(r.values), createdAt: now }];
          }),
          ...toUpdate.flatMap((r) => {
            const hit = byKey.get(r.externalKey);
            return hit === undefined
              ? []
              : [
                  {
                    rowId: hit.rowId,
                    externalKey: r.externalKey,
                    valuesHash: valuesHashOf(r.values),
                    createdAt: now,
                  },
                ];
          }),
        ]);

        // A mapped header that vanished upstream is a WARNING, not a failure: the
        // rest of the import is still correct and useful, and failing outright
        // would strand the table on a column someone renamed.
        const warning =
          missingHeaders.length > 0
            ? `Columns not found in the sheet: ${missingHeaders.join(", ")}`
            : truncated
              ? `Only the first ${MAX_ROWS_PER_SYNC} rows were imported.`
              : null;

        yield* repo.patch(bindingId, {
          lastSyncedAt: now,
          lastError: warning,
          rowsSynced: rows.length,
          pausedReason: null,
        });

        return {
          rowsCreated: insertedIds.length,
          rowsUpdated: toUpdate.length,
          rowsSkipped: rows.length - insertedIds.length - toUpdate.length,
          truncated,
        };
      });

    return {
      syncForWorker,

      /**
       * The tabs in a spreadsheet, for the import picker.
       *
       * Member-gated and read-only. Fails loudly rather than returning an empty
       * list on a 404: "no tabs" and "you never picked this file" look identical
       * in a dropdown, and the second is by far the more likely.
       */
      listTabs: (args: { readonly workspaceId: string; readonly spreadsheetId: string }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          const token = yield* accessToken(args.workspaceId);
          const titles = yield* Effect.tryPromise({
            try: async () => {
              const url = `${SHEETS_BASE}/${encodeURIComponent(args.spreadsheetId)}?fields=properties.title,sheets.properties.title`;
              const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
              if (!res.ok) {
                throw new SheetImportError({
                  message:
                    res.status === 404
                      ? "That spreadsheet isn't available. Select it in Google settings first."
                      : `Google Sheets returned ${res.status}`,
                  status: res.status,
                });
              }
              const body: unknown = await res.json();
              const sheets = typeof body === "object" && body !== null ? Reflect.get(body, "sheets") : undefined;
              const props = typeof body === "object" && body !== null ? Reflect.get(body, "properties") : undefined;
              const name =
                typeof props === "object" && props !== null ? String(Reflect.get(props, "title") ?? "") : "";
              const tabs = Array.isArray(sheets)
                ? sheets.flatMap((s: unknown) => {
                    const p = typeof s === "object" && s !== null ? Reflect.get(s, "properties") : undefined;
                    const title = typeof p === "object" && p !== null ? Reflect.get(p, "title") : undefined;
                    return typeof title === "string" && title !== "" ? [title] : [];
                  })
                : [];
              return { name, tabs };
            },
            catch: (cause) =>
              cause instanceof SheetImportError
                ? cause
                : new SheetImportError({ message: "Could not reach Google Sheets", cause, status: 0 }),
          });
          return titles;
        }),

      /**
       * Headers plus a few sample rows, so the import UI can map columns against
       * real data rather than asking the user to remember their own spreadsheet.
       *
       * Reads a bounded window (`A{headerRow}:ZZ{headerRow + PREVIEW_ROWS}`) —
       * a preview must never pull a 50k-row sheet just to show five lines.
       */
      preview: (args: {
        readonly workspaceId: string;
        readonly spreadsheetId: string;
        readonly sheetTitle: string;
        readonly headerRow: number;
      }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          const token = yield* accessToken(args.workspaceId);
          const quoted = args.sheetTitle.replace(/'/g, "''");
          const range = `'${quoted}'!A${args.headerRow}:ZZ${args.headerRow + PREVIEW_ROWS}`;
          const grid = yield* readRange(token, args.spreadsheetId, range);
          const headers = (grid[0] ?? []).map((h) => String(h ?? ""));
          return {
            headers,
            // Sample rows are padded to the header width so the UI can render a
            // rectangular table — Google omits trailing empties, so raw rows are
            // ragged and would misalign under the wrong headers.
            rows: grid.slice(1).map((r) => headers.map((_h, i) => String(r[i] ?? ""))),
          };
        }),

      /** Member-gated manual sync ("Sync now"). */
      syncNow: (args: { readonly workspaceId: string; readonly bindingId: string }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          return yield* syncForWorker(args.bindingId);
        }),

      listForTable: (args: { readonly workspaceId: string; readonly tableId: string }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          return yield* repo.listByTable(args.tableId);
        }),

      create: (args: {
        readonly workspaceId: string;
        readonly tableId: string;
        readonly spreadsheetId: string;
        readonly spreadsheetName: string;
        readonly sheetTitle: string;
        readonly headerRow: number;
        readonly columns: readonly SheetBindingColumn[];
        readonly keyHeader: string | null;
        readonly schedule: string;
      }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          return yield* repo.insert({ ...args, enabled: true, createdAt: Date.now() });
        }),

      update: (args: {
        readonly workspaceId: string;
        readonly bindingId: string;
        readonly schedule?: string;
        readonly enabled?: boolean;
        readonly keyHeader?: string | null;
      }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          yield* repo.patch(args.bindingId, {
            ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.keyHeader !== undefined ? { keyHeader: args.keyHeader } : {}),
            // Any deliberate edit clears a pause: the user has just told us they
            // believe it is fixed, and the next run is how they find out.
            pausedReason: null,
          });
        }),

      remove: (args: { readonly workspaceId: string; readonly bindingId: string }) =>
        Effect.gen(function* () {
          yield* membership.requireMember(args.workspaceId);
          yield* repo.remove(args.bindingId);
        }),

      /** One keyset page of due bindings, for the cron. */
      listDueForWorker: (args: {
        readonly now: number;
        readonly limit: number;
        readonly cursor: { readonly createdAt: number; readonly id: string } | null;
      }) => repo.listDuePage(args),
    } as const;
  }),
  dependencies: [],
}) {}
