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
import { and, eq, isNull } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
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
 * An in-memory `CredentialRepo` Layer backed by a mutable copy of the given
 * rows. `upsert` mutates the copy so a save-then-read in one test sees the write,
 * exactly like the Drizzle path — exercised with NO live database.
 */
export const credentialRepoLayer = (
  seed: readonly CredentialRow[] = [],
): Layer.Layer<CredentialRepo> =>
  Layer.sync(CredentialRepo, () => {
    const rows: CredentialRow[] = seed.map((r) => ({ ...r }));

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
    };
  });
