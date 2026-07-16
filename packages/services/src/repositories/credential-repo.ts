/**
 * `CredentialRepo` — the Effect <-> Drizzle adapter for the `credentials` table.
 *
 * Owns the reads/writes the credential domain service needs, exposed as
 * `Effect.Effect<…, CredentialRepoError>` methods behind a `Context.Tag` so it
 * can be backed two ways (the repo pattern from packages/services/README.md):
 *
 *   - {@link CredentialRepoLive} — Drizzle over `@gtmgrid/db`, depends on
 *     {@link DbClient}. Every query is wrapped in `Effect.tryPromise` so a
 *     transport failure surfaces as the typed {@link CredentialRepoError}.
 *   - {@link credentialRepoLayer} — in-memory, backed by a fixed array. Tests use
 *     this so the repo (and the domain rules over it) run with NO live database.
 *
 * Ports the data access in convex/credentialsData.ts:
 *   - `listMetadata`  ← `listCredentials` (:110) — METADATA ONLY, never secretsEnc.
 *   - `findForAccess` ← the `by_workspace_extension_owner` lookups in
 *     `getCredentialEnc` (:205) / `storeCredential` (:146) — returns the row
 *     INCLUDING `secretsEnc` + `ownerUserId` for the trusted decrypt-for-run /
 *     rotate paths (callers gate access via CredentialOwnershipService first).
 *   - `findSharedForWorker` ← `getCredentialEncForWorker` (:253) — the shared-only
 *     (`ownerUserId === null`) ciphertext fetch the secret-gated worker uses.
 *   - `upsert`        ← `storeCredential` (:146) — insert or rotate in place on
 *     (workspaceId, extensionId, scope, ownerUserId).
 */

import { schema } from "@gtmgrid/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Context, Data, Effect, Exit, Layer, Option, Runtime } from "effect";
import { DbClient } from "../db-client.js";

/** A credential scope. Mirrors the `credential_scope` pgEnum (schema.ts:74). */
export type CredentialScope = "workspace" | "personal";

/**
 * The METADATA projection `listMetadata` returns — deliberately WITHOUT
 * `secretsEnc`, so the ciphertext can never cross the list boundary to a client.
 * Mirrors the projection in `listCredentials` (convex/credentialsData.ts:129).
 */
export interface CredentialMetadata {
  readonly id: string;
  readonly extensionId: string;
  readonly scope: CredentialScope;
  readonly name: string;
  /** Owning member for a `personal` row; `null` for a shared `workspace` row. */
  readonly ownerUserId: string | null;
  readonly createdAt: number;
}

/**
 * A full credential row INCLUDING the ciphertext + owner binding. Returned only
 * by the trusted access paths ({@link CredentialRepo.findForAccess} /
 * {@link CredentialRepo.findSharedForWorker}) whose callers gate ownership before
 * decrypting. NEVER returned by {@link CredentialRepo.listMetadata}.
 */
export interface CredentialRow extends CredentialMetadata {
  /** The workspace this credential belongs to. */
  readonly workspaceId: string;
  /** Envelope-encrypted ciphertext of the secret map. */
  readonly secretsEnc: string;
}

/** Raised when a credential read/write fails (DB/transport error). */
export class CredentialRepoError extends Data.TaggedError(
  "CredentialRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The owner-binding key a lookup/upsert targets for a given scope. */
export interface OwnerKey {
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly scope: CredentialScope;
  /** `personal` rows bind to a user id; `workspace` rows key on `null`. */
  readonly ownerUserId: string | null;
}

/** The fields an upsert writes (the ciphertext is produced by CryptoService). */
export interface CredentialUpsert extends OwnerKey {
  readonly name: string;
  readonly secretsEnc: string;
}

/** Postgres uuid shape — `credentials.workspaceId` is a uuid column. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads/writes the `credentials` table. Backed by Drizzle in production
 * ({@link CredentialRepoLive}); by an in-memory list in tests
 * ({@link credentialRepoLayer}).
 */
export class CredentialRepo extends Context.Tag("CredentialRepo")<
  CredentialRepo,
  {
    /**
     * All credentials for a workspace as METADATA ONLY (never `secretsEnc`).
     * Returns every row for the workspace; the caller filters personal rows to
     * the requesting member. Mirrors the collect in `listCredentials` (:116).
     */
    readonly listMetadata: (
      workspaceId: string,
    ) => Effect.Effect<readonly CredentialMetadata[], CredentialRepoError>;
    /**
     * The single row matching the (workspace, extension, scope, owner) key,
     * INCLUDING its ciphertext + owner binding, or `None`. The trusted lookup
     * `getCredentialEnc` / `storeCredential` use before decrypt / rotate.
     */
    readonly findForAccess: (
      key: OwnerKey,
    ) => Effect.Effect<Option.Option<CredentialRow>, CredentialRepoError>;
    /**
     * The single SHARED (`ownerUserId === null`) workspace-scope row for a
     * connector, INCLUDING its ciphertext, or `None`. The shared-only fetch the
     * secret-gated worker uses (`getCredentialEncForWorker`, :253) — it can never
     * reach a member's personal key.
     */
    readonly findSharedForWorker: (args: {
      readonly workspaceId: string;
      readonly extensionId: string;
    }) => Effect.Effect<Option.Option<CredentialRow>, CredentialRepoError>;
    /**
     * Insert or rotate a credential in place on (workspace, extension, scope,
     * owner). Returns the row id. Ports the upsert in `storeCredential` (:146).
     */
    readonly upsert: (
      input: CredentialUpsert,
    ) => Effect.Effect<string, CredentialRepoError>;
    /**
     * Delete the credential on the (workspace, extension, scope, owner) key.
     * Returns true when a row was removed. Powers explicit disconnects (e.g.
     * removing a CRM OAuth connection); no-op when nothing matches.
     */
    readonly remove: (key: OwnerKey) => Effect.Effect<boolean, CredentialRepoError>;
    /**
     * Run `onAcquired` holding an exclusive cross-instance lock on `lockKey`, or
     * `onBusy` if another instance already holds it. NEVER blocks.
     *
     * This exists for OAuth providers whose refresh tokens are SINGLE-USE
     * (`RefreshPolicy.Rotating`, i.e. Slack): two concurrent column runs that
     * both refresh will revoke each other's live token mid-run, so the refresh
     * CALL itself — not just the write — must be mutually exclusive. A
     * compare-and-swap after the fact cannot help; the damage is the HTTP call.
     *
     * `pg_try_advisory_xact_lock`, deliberately, on two counts:
     *
     * 1. TRY, not blocking. An xact lock is only released at COMMIT, so a
     *    blocking `pg_advisory_xact_lock` would pin a pooled connection for the
     *    holder AND one per waiter across a network call. The pool is `max: 2`
     *    per instance (Supavisor transaction mode — see `@gtmgrid/db/client`),
     *    so two waiters would stall the entire instance until `connect_timeout`.
     *    Non-blocking means the loser proceeds immediately on its stored token,
     *    which is still valid for the whole skew window — the skew IS the grace
     *    period.
     * 2. XACT, not session. In transaction-mode pooling a session-level lock is
     *    unsound: `pg_advisory_lock` and `pg_advisory_unlock` can land on
     *    different backends, leaking the lock forever. Transaction scope ties
     *    the lock's lifetime to a single backend and releases it on commit
     *    OR crash.
     *
     * Callers MUST re-read state inside `onAcquired`: winning the lock says
     * nothing about whether the work still needs doing.
     */
    readonly withTryRefreshLock: <A, E, R>(args: {
      readonly lockKey: string;
      readonly onAcquired: Effect.Effect<A, E, R>;
      readonly onBusy: Effect.Effect<A, E, R>;
    }) => Effect.Effect<A, E | CredentialRepoError, R>;
  }
>() {}

/** Shape of a full `select()` row from the `credentials` table. */
interface DbCredentialRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly scope: CredentialScope;
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly secretsEnc: string;
  readonly createdAt: number;
}

/** The Drizzle-backed `CredentialRepo` Layer. Depends on {@link DbClient}. */
export const CredentialRepoLive: Layer.Layer<
  CredentialRepo,
  never,
  DbClient
> = Layer.effect(
  CredentialRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;

    const fail = (message: string) => (cause: unknown) =>
      new CredentialRepoError({
        message: cause instanceof Error ? cause.message : message,
        cause,
      });

    /** AND-predicate for an owner key; `null` owner uses `IS NULL`. */
    const ownerKeyWhere = (key: OwnerKey) =>
      and(
        eq(schema.credentials.workspaceId, key.workspaceId),
        eq(schema.credentials.extensionId, key.extensionId),
        eq(schema.credentials.scope, key.scope),
        key.ownerUserId === null
          ? isNull(schema.credentials.ownerUserId)
          : eq(schema.credentials.ownerUserId, key.ownerUserId),
      );

    return {
      listMetadata: (workspaceId) =>
        UUID_RE.test(workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({
                    id: schema.credentials.id,
                    extensionId: schema.credentials.extensionId,
                    scope: schema.credentials.scope,
                    name: schema.credentials.name,
                    ownerUserId: schema.credentials.ownerUserId,
                    createdAt: schema.credentials.createdAt,
                  })
                  .from(schema.credentials)
                  .where(eq(schema.credentials.workspaceId, workspaceId));
                return rows satisfies readonly CredentialMetadata[];
              },
              catch: fail("credential list failed"),
            })
          : Effect.succeed([] as readonly CredentialMetadata[]),

      findForAccess: (key) =>
        UUID_RE.test(key.workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(schema.credentials)
                  .where(ownerKeyWhere(key))
                  .limit(1);
                return rowToOption(rows[0]);
              },
              catch: fail("credential lookup failed"),
            })
          : Effect.succeed(Option.none<CredentialRow>()),

      findSharedForWorker: ({ workspaceId, extensionId }) =>
        UUID_RE.test(workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(schema.credentials)
                  .where(
                    and(
                      eq(schema.credentials.workspaceId, workspaceId),
                      eq(schema.credentials.extensionId, extensionId),
                      eq(schema.credentials.scope, "workspace"),
                      isNull(schema.credentials.ownerUserId),
                    ),
                  )
                  .limit(1);
                return rowToOption(rows[0]);
              },
              catch: fail("worker credential lookup failed"),
            })
          : Effect.succeed(Option.none<CredentialRow>()),

      upsert: (input) =>
        UUID_RE.test(input.workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const existing = await db
                  .select({ id: schema.credentials.id })
                  .from(schema.credentials)
                  .where(ownerKeyWhere(input))
                  .limit(1);
                const found = existing[0];
                if (found !== undefined) {
                  await db
                    .update(schema.credentials)
                    .set({ name: input.name, secretsEnc: input.secretsEnc })
                    .where(eq(schema.credentials.id, found.id));
                  return found.id;
                }
                const inserted = await db
                  .insert(schema.credentials)
                  .values({
                    workspaceId: input.workspaceId,
                    extensionId: input.extensionId,
                    scope: input.scope,
                    ownerUserId: input.ownerUserId,
                    name: input.name,
                    secretsEnc: input.secretsEnc,
                    createdAt: Date.now(),
                  })
                  .returning({ id: schema.credentials.id });
                return inserted[0].id;
              },
              catch: fail("credential upsert failed"),
            })
          : Effect.fail(
              new CredentialRepoError({
                message: `Invalid workspace id: ${input.workspaceId}`,
              }),
            ),

      remove: (key) =>
        UUID_RE.test(key.workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const deleted = await db
                  .delete(schema.credentials)
                  .where(
                    and(
                      eq(schema.credentials.workspaceId, key.workspaceId),
                      eq(schema.credentials.extensionId, key.extensionId),
                      eq(schema.credentials.scope, key.scope),
                      key.ownerUserId === null
                        ? isNull(schema.credentials.ownerUserId)
                        : eq(schema.credentials.ownerUserId, key.ownerUserId),
                    ),
                  )
                  .returning({ id: schema.credentials.id });
                return deleted.length > 0;
              },
              catch: fail("credential delete failed"),
            })
          : Effect.succeed(false),
      withTryRefreshLock: <A, E, R>(args: {
        readonly lockKey: string;
        readonly onAcquired: Effect.Effect<A, E, R>;
        readonly onBusy: Effect.Effect<A, E, R>;
      }): Effect.Effect<A, E | CredentialRepoError, R> =>
        Effect.gen(function* () {
          // Capture the caller's runtime so the inner Effect keeps its context
          // (CryptoService et al.) across the Drizzle transaction boundary.
          const runtime = yield* Effect.runtime<R>();
          // Captured out of the transaction rather than returned through it, so
          // the typing never depends on the driver's `transaction` return type.
          // Seeded with a defect: if the body somehow never runs, that is a bug
          // and must surface as one, not as a silent success.
          let captured: Exit.Exit<A, E> = Exit.die(
            new Error("withTryRefreshLock: transaction body did not run"),
          );
          yield* Effect.tryPromise({
            try: () =>
              db.transaction(async (tx) => {
                const rows = await tx.execute(LOCK_SQL(args.lockKey));
                const acquired = readAcquired(rows);
                // runPromiseEXIT, not runPromise: a rejected promise would be
                // caught below and flattened into CredentialRepoError, erasing
                // the inner effect's typed failures. The Exit is re-raised
                // as-is, so E survives the round trip.
                captured = await Runtime.runPromiseExit(runtime)(
                  acquired ? args.onAcquired : args.onBusy,
                );
              }),
            catch: fail("Could not acquire the credential refresh lock"),
          });
          // `Exit` IS an `Effect`, so this re-raises the inner typed failure.
          return yield* captured;
        }),

    };
  }),
);

/** Map a raw Drizzle row (or undefined) into an `Option<CredentialRow>`. */
const rowToOption = (
  row: DbCredentialRow | undefined,
): Option.Option<CredentialRow> =>
  row === undefined
    ? Option.none<CredentialRow>()
    : Option.some({
        id: row.id,
        workspaceId: row.workspaceId,
        extensionId: row.extensionId,
        scope: row.scope,
        name: row.name,
        ownerUserId: row.ownerUserId,
        secretsEnc: row.secretsEnc,
        createdAt: row.createdAt,
      });

/**
 * Hash `lockKey` to the bigint `pg_try_advisory_xact_lock` wants.
 * `hashtextextended` is a stable Postgres builtin, so every instance maps a key
 * to the same lock id. Collisions across DIFFERENT keys are possible but benign:
 * the worst case is two unrelated connections briefly serialising.
 */
const LOCK_SQL = (lockKey: string) =>
  sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) as acquired`;

/**
 * Read the boolean out of the lock query's result, totally.
 *
 * TWO SHAPES, deliberately. Drizzle's `execute()` return differs by driver:
 *   - `drizzle-orm/postgres-js` (production) yields an ARRAY-like result:
 *     `[{ acquired: true }]`
 *   - `drizzle-orm/pglite` (the .pg.test suites) yields
 *     `{ rows: [{ acquired: true }], fields, affectedRows }`
 * Handling only the first is what production happens to need — but it fails
 * CLOSED and SILENTLY against anything else: an unrecognised shape reads as
 * "someone else holds the lock", so the refresh never runs, forever, with no
 * error anywhere. A driver swap would surface months later as "Slack keeps
 * disconnecting". Accepting both shapes costs three lines and removes that trap.
 *
 * Failing closed on a genuinely unknown shape is still the right default: a
 * false negative skips one refresh of a token that is still inside its skew
 * window, whereas a false positive lets two instances refresh at once — exactly
 * the single-use-token trampling this lock exists to prevent.
 */
const readAcquired = (raw: unknown): boolean => {
  const rows = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray(Reflect.get(raw, "rows"))
      ? Reflect.get(raw, "rows")
      : null;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null) return false;
  return Reflect.get(first, "acquired") === true;
};

/**
 * An in-memory `CredentialRepo` Layer backed by a mutable copy of the given
 * rows. `upsert` mutates the copy so a save-then-read in one test sees the write,
 * exactly like the Drizzle path — exercised with NO live database.
 */
export const credentialRepoLayer = (
  seed: readonly CredentialRow[] = [],
): Layer.Layer<CredentialRepo> =>
  Layer.sync(CredentialRepo, () => {
    const rows: CredentialRow[] = seed.map((r) => ({ ...r }));
    /** Held lock keys, so the in-memory layer can exercise the busy branch. */
    const heldLocks = new Set<string>();

    const matchesKey = (r: CredentialRow, key: OwnerKey): boolean =>
      r.workspaceId === key.workspaceId &&
      r.extensionId === key.extensionId &&
      r.scope === key.scope &&
      r.ownerUserId === key.ownerUserId;

    return {
      listMetadata: (workspaceId) =>
        Effect.succeed(
          rows
            .filter((r) => r.workspaceId === workspaceId)
            .map(
              ({ id, extensionId, scope, name, ownerUserId, createdAt }) => ({
                id,
                extensionId,
                scope,
                name,
                ownerUserId,
                createdAt,
              }),
            ),
        ),
      findForAccess: (key) =>
        Effect.succeed(
          Option.fromNullable(rows.find((r) => matchesKey(r, key)) ?? null),
        ),
      findSharedForWorker: ({ workspaceId, extensionId }) =>
        Effect.succeed(
          Option.fromNullable(
            rows.find(
              (r) =>
                r.workspaceId === workspaceId &&
                r.extensionId === extensionId &&
                r.scope === "workspace" &&
                r.ownerUserId === null,
            ) ?? null,
          ),
        ),
      upsert: (input) =>
        Effect.sync(() => {
          const index = rows.findIndex((r) => matchesKey(r, input));
          if (index !== -1) {
            const existing = rows[index];
            // Rebuild the row (its fields are readonly) so rotation is in place.
            rows[index] = {
              ...existing,
              name: input.name,
              secretsEnc: input.secretsEnc,
            };
            return existing.id;
          }
          const id = `cred_${rows.length + 1}`;
          rows.push({
            id,
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
            ownerUserId: input.ownerUserId,
            name: input.name,
            secretsEnc: input.secretsEnc,
            createdAt: Date.now(),
          });
          return id;
        }),

      remove: (key) =>
        Effect.sync(() => {
          const index = rows.findIndex((r) => matchesKey(r, key));
          if (index === -1) return false;
          rows.splice(index, 1);
          return true;
        }),
      /**
       * In-process mutex. Enough to exercise BOTH branches in a unit test, but
       * it proves nothing about `pg_try_advisory_xact_lock` — a fake cannot,
       * because the lock exists to coordinate across instances/processes. The
       * real proof is the integration test against live Postgres.
       */
      withTryRefreshLock: <A, E, R>(args: {
        readonly lockKey: string;
        readonly onAcquired: Effect.Effect<A, E, R>;
        readonly onBusy: Effect.Effect<A, E, R>;
      }): Effect.Effect<A, E | CredentialRepoError, R> =>
        Effect.suspend(() => {
          if (heldLocks.has(args.lockKey)) return args.onBusy;
          heldLocks.add(args.lockKey);
          return Effect.ensuring(
            args.onAcquired,
            Effect.sync(() => {
              heldLocks.delete(args.lockKey);
            }),
          );
        }),

    };
  });
