/**
 * `ShareService` — the domain service behind the "share a cloud table via URL"
 * feature. Composes {@link ShareRepo} with the existing {@link GridService}
 * (reused verbatim for both the read that produces a snapshot and the writes
 * that rebuild one) behind the {@link MembershipService} authz gate.
 *
 *   - createShare   — freeze a table into a secret-free snapshot + mint a token
 *                     (member + cloud-access gated via `GridService.getTable`).
 *                     NOT metered (the share row is metadata, like a webhook).
 *   - getShareByToken — PUBLIC read by token (the token IS the capability): a
 *                     revoked / expired / missing share returns `{ valid:false }`
 *                     and leaks nothing.
 *   - listShares    — a table's shares (member-gated), minus the heavy snapshot.
 *   - revokeShare   — disable a share (member-gated).
 *   - cloneFromSnapshot — rebuild a snapshot into the recipient's project via the
 *                     existing `createTable`/`addColumn`/`addRowsWithCells`
 *                     paths, so authz + cloud-actions metering happen in the
 *                     RECIPIENT's workspace exactly like a normal table build.
 *
 * The snapshot never carries credentials (see share-snapshot.ts); function
 * columns are recreated with their provider/method/code/params intact but stay
 * empty until the recipient connects their OWN connector credentials and runs
 * them — {@link CloneResult.referencedProviders} surfaces which connectors to
 * wire up.
 */

import { Identity, MembershipService } from "@gtmgrid/cloud";
import { Data, Effect, Option } from "effect";
import { GridService } from "./grid-service.js";
import { ShareRepo, type ShareRepoError } from "../repositories/share-repo.js";
import { mintToken } from "../webhook-mint.js";
import {
  SHARE_SNAPSHOT_MAX_BYTES,
  SHARE_SNAPSHOT_VERSION,
  referencedProviders,
  snapshotFromFullGrid,
  type TableShareSnapshot,
  validateSnapshot,
} from "../share-snapshot.js";

/** Raised when a referenced share (or its source table) does not exist. */
export class ShareNotFoundError extends Data.TaggedError("ShareNotFoundError")<{
  readonly message: string;
}> {}

/** Raised when a table's snapshot exceeds the inline size cap. */
export class ShareTooLargeError extends Data.TaggedError("ShareTooLargeError")<{
  readonly message: string;
}> {}

/** Raised when a snapshot being cloned fails validation. */
export class InvalidShareSnapshotError extends Data.TaggedError(
  "InvalidShareSnapshotError",
)<{
  readonly message: string;
}> {}

/** The PUBLIC preview a `/share/<token>` page renders. */
export type SharePreview =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly name: string | null;
      readonly snapshot: TableShareSnapshot;
    };

/** A lightweight share row for the management list (no snapshot payload). */
export interface ShareSummary {
  readonly id: string;
  readonly token: string;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly shareUrl: string;
}

/** The result of minting a share. */
export interface CreateShareResult {
  readonly id: string;
  readonly token: string;
  readonly shareUrl: string;
}

/** The result of cloning a snapshot into a project. */
export interface CloneResult {
  readonly tableId: string;
  /** Connectors the cloned function columns reference (wire up credentials). */
  readonly referencedProviders: readonly string[];
}

/** The public base URL share links live on (Vercel `SITE_URL`). */
const siteBaseUrl = (): string =>
  (
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://gtmgrid.com"
  ).replace(/\/+$/, "");

/** Build the public share URL for a token: `${SITE_URL}/share/<token>`. */
export const shareUrlFor = (token: string): string =>
  `${siteBaseUrl()}/share/${encodeURIComponent(token)}`;

/**
 * Share domain service (the `Effect.Service` pattern). The composed `appLayer`
 * wires the live repo + GridService; tests provide the in-memory Layers and get
 * the same service with deterministic behaviour.
 */
export class ShareService extends Effect.Service<ShareService>()(
  "ShareService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* ShareRepo;
      const grid = yield* GridService;
      const membership = yield* MembershipService;
      const identity = yield* Identity;

      /** Resolve a table's workspace or fail typed (used for the membership gate). */
      const resolveWorkspace = (
        tableId: string,
      ): Effect.Effect<string, ShareRepoError | ShareNotFoundError> =>
        Effect.gen(function* () {
          const ws = yield* repo.tableWorkspace(tableId);
          if (ws._tag === "None") {
            return yield* Effect.fail(
              new ShareNotFoundError({ message: `Table ${tableId} not found.` }),
            );
          }
          return ws.value;
        });

      /**
       * Freeze a table into a snapshot + mint a public token.
       * `GridService.getTable` is the authz gate (cloud member) AND the data
       * source, so a non-member or lapsed-plan caller is rejected before any
       * snapshot is built.
       */
      const createShare = (args: {
        readonly tableId: string;
        readonly name?: string | null;
        readonly expiresAt?: number | null;
      }) =>
        Effect.gen(function* () {
          const full = yield* grid.getTable(args.tableId);
          const workspaceId = yield* resolveWorkspace(args.tableId);
          const userId = yield* identity.currentUserId;
          const snapshot = snapshotFromFullGrid(full);
          const size = JSON.stringify(snapshot).length;
          if (size > SHARE_SNAPSHOT_MAX_BYTES) {
            return yield* Effect.fail(
              new ShareTooLargeError({
                message:
                  "This table is too large to share as a single link. Share fewer rows or split the table.",
              }),
            );
          }
          const token = mintToken();
          const row = yield* repo.insert({
            workspaceId,
            tableId: args.tableId,
            token,
            name: args.name ?? full.table.name,
            snapshot,
            snapshotVersion: SHARE_SNAPSHOT_VERSION,
            enabled: true,
            expiresAt: args.expiresAt ?? null,
            createdBy: Option.getOrNull(userId),
            createdAt: Date.now(),
          });
          return {
            id: row.id,
            token: row.token,
            shareUrl: shareUrlFor(row.token),
          } satisfies CreateShareResult;
        });

      /**
       * PUBLIC: resolve a token to its snapshot. A missing / disabled / expired
       * share returns `{ valid:false }` (no detail leaks); a stored snapshot that
       * fails validation is likewise treated as invalid.
       */
      const getShareByToken = (
        token: string,
      ): Effect.Effect<SharePreview, ShareRepoError> =>
        Effect.gen(function* () {
          const found = yield* repo.findByToken(token);
          if (found._tag === "None") return { valid: false } as const;
          const s = found.value;
          if (!s.enabled) return { valid: false } as const;
          if (s.expiresAt !== null && s.expiresAt <= Date.now()) {
            return { valid: false } as const;
          }
          const parsed = validateSnapshot(s.snapshot);
          if (!parsed.ok) return { valid: false } as const;
          return { valid: true, name: s.name, snapshot: parsed.value } as const;
        });

      /** A table's shares (member-gated), without the heavy snapshot payload. */
      const listShares = (tableId: string) =>
        Effect.gen(function* () {
          const workspaceId = yield* resolveWorkspace(tableId);
          yield* membership.requireMember(workspaceId);
          const rows = yield* repo.listByTable(tableId);
          return rows.map(
            (s) =>
              ({
                id: s.id,
                token: s.token,
                name: s.name,
                enabled: s.enabled,
                expiresAt: s.expiresAt,
                createdAt: s.createdAt,
                revokedAt: s.revokedAt,
                shareUrl: shareUrlFor(s.token),
              }) satisfies ShareSummary,
          );
        });

      /** Disable a share (member-gated). */
      const revokeShare = (shareId: string) =>
        Effect.gen(function* () {
          const found = yield* repo.findById(shareId);
          if (found._tag === "None") {
            return yield* Effect.fail(
              new ShareNotFoundError({ message: `Share ${shareId} not found.` }),
            );
          }
          yield* membership.requireMember(found.value.workspaceId);
          yield* repo.revoke(shareId, Date.now());
        });

      /**
       * Rebuild a snapshot into `targetProjectId`. `GridService.createTable`
       * authorizes the TARGET workspace (cloud member) and meters the build in
       * the recipient's workspace. Function columns are recreated with their
       * config intact; cloud `addColumn` does not validate the provider, so a
       * missing connector never fails the clone (the column stays empty until
       * run with the recipient's own credential).
       */
      const cloneFromSnapshot = (args: {
        readonly snapshot: unknown;
        readonly targetProjectId: string;
        readonly includeData: boolean;
      }) =>
        Effect.gen(function* () {
          const parsed = validateSnapshot(args.snapshot);
          if (!parsed.ok) {
            return yield* Effect.fail(
              new InvalidShareSnapshotError({
                message: `Invalid share snapshot: ${parsed.error}`,
              }),
            );
          }
          const snap = parsed.value;
          const tableId = yield* grid.createTable({
            projectId: args.targetProjectId,
            name: snap.table.name,
          });
          const columnIds: string[] = [];
          for (const c of snap.columns) {
            const id = yield* grid.addColumn({
              tableId,
              name: c.name,
              type: c.type,
              kind: c.kind,
              provider: c.provider,
              method: c.method,
              code: c.code,
              params: c.params,
            });
            columnIds.push(id);
          }
          if (args.includeData && snap.rows > 0) {
            const rows: Record<string, unknown>[] = Array.from(
              { length: snap.rows },
              () => ({}),
            );
            for (const cell of snap.cells) {
              const colId = columnIds[cell.column];
              if (colId === undefined) continue;
              if (cell.row < 0 || cell.row >= rows.length) continue;
              rows[cell.row][colId] = cell.value;
            }
            yield* grid.addRowsWithCells({ tableId, rows });
          }
          return {
            tableId,
            referencedProviders: referencedProviders(snap),
          } satisfies CloneResult;
        });

      return {
        createShare,
        getShareByToken,
        listShares,
        revokeShare,
        cloneFromSnapshot,
      } as const;
    }),
    dependencies: [],
  },
) {}
