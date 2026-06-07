/**
 * `InvitationRepo` — the Effect <-> Drizzle adapter for the `invitations` flow.
 *
 * The direct port of `convex/invitations.ts`'s data access. Like every repo in
 * this package it is a `Context.Tag` with two Layers:
 *
 *   - {@link InvitationRepoLive} — Drizzle-backed over `@gtmgrid/db`, depends on
 *     {@link DbClient}. Every query is wrapped in `Effect.tryPromise` so a
 *     transport failure surfaces as the typed {@link InvitationRepoError}.
 *   - {@link invitationRepoLayer} — in-memory, backed by mutable arrays so the
 *     full invite -> accept lifecycle (including the TRANSACTIONAL accept-insert)
 *     is exercised with NO live database.
 *
 * One detail goes beyond a single table: {@link InvitationRepo.acceptInsert} is
 * the port of `acceptInvitationInsert` (convex/invitations.ts:487) — it must
 * re-read the live `members` count, enforce the seat ceiling, insert the member,
 * and mark the invite accepted ATOMICALLY, so it owns a small cross-table
 * transaction (invitations + members). The seat-ceiling comparison mirrors
 * `SeatsService.enforceSeatCeiling` (@gtmgrid/cloud, packages/cloud/src/seats.ts)
 * and fails with that package's {@link SeatLimitExceededError} so the rule has a
 * single definition across the Convex and Postgres tiers.
 */

import {
  type Membership,
  type MemberRole,
  SeatLimitExceededError,
} from "@gtmgrid/cloud";
import { schema } from "@gtmgrid/db";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/** The invitation lifecycle status. Mirrors `invitationStatus` (db schema). */
export type InvitationStatus = "pending" | "accepted" | "revoked";

/**
 * An invitation row projection the domain needs. Mirrors the `invitations` table
 * (packages/db/src/schema.ts:265).
 */
export interface Invitation {
  readonly id: string;
  readonly workspaceId: string;
  /** Invitee email, normalized to lowercase on write. */
  readonly email: string;
  readonly role: MemberRole;
  readonly token: string;
  readonly status: InvitationStatus;
  /** Better Auth user id of the inviting owner/admin. */
  readonly invitedBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly acceptedBy: string | null;
  readonly acceptedAt: number | null;
}

/** Fields needed to insert/refresh a pending invite. */
export interface UpsertInviteInput {
  readonly workspaceId: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly token: string;
  readonly invitedBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Arguments to the transactional {@link InvitationRepo.acceptInsert}. */
export interface AcceptInsertInput {
  readonly invitationId: string;
  readonly userId: string;
  /** Caller's normalized email; re-checked against the invite inside the tx. */
  readonly email: string;
  /** Absolute member ceiling, or `null` for an unlimited plan. */
  readonly seatCeiling: number | null;
  /** When the member row is inserted (epoch ms). */
  readonly now: number;
}

/** Result of {@link InvitationRepo.acceptInsert}. */
export interface AcceptInsertResult {
  readonly alreadyMember: boolean;
  readonly workspaceId: string;
}

/** The workspace's display name + owner email (Autumn customer profile). */
export interface WorkspaceCustomerData {
  readonly name: string | null;
  readonly email: string | null;
}

/** A user's display name + email (the inviter, for the invite email). */
export interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
}

/** Raised when an invitation read/write fails (DB/transport error). */
export class InvitationRepoError extends Data.TaggedError(
  "InvitationRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when the transactional accept re-validation fails — the invite is no
 * longer pending/live or its email no longer matches the caller (a revoke /
 * expiry / mismatch racing the action's read). Ports the in-transaction
 * `ConvexError("InvalidInvitation")` (convex/invitations.ts:515).
 */
export class InvalidInvitationError extends Data.TaggedError(
  "InvalidInvitationError",
)<{
  readonly message: string;
}> {}

/** Postgres uuid shape — invitation/workspace ids are uuid columns. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads + writes the invitation flow. Backed by Drizzle in production
 * ({@link InvitationRepoLive}); by mutable in-memory arrays in tests
 * ({@link invitationRepoLayer}).
 */
export class InvitationRepo extends Context.Tag("InvitationRepo")<
  InvitationRepo,
  {
    /** The invitation for `token`, or `None`. */
    readonly findByToken: (
      token: string,
    ) => Effect.Effect<Option.Option<Invitation>, InvitationRepoError>;
    /** Pending invitations for a workspace, newest first. */
    readonly listPendingByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<readonly Invitation[], InvitationRepoError>;
    /** Pending, unexpired invitations addressed to `email`. */
    readonly listPendingByEmail: (
      email: string,
    ) => Effect.Effect<readonly Invitation[], InvitationRepoError>;
    /** The invitation by id, or `None`. */
    readonly findById: (
      invitationId: string,
    ) => Effect.Effect<Option.Option<Invitation>, InvitationRepoError>;
    /**
     * The membership for (workspaceId, userId), or `None`. Used by
     * `myPendingInvitations` to hide invites the caller already accepted.
     */
    readonly findMembership: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<Option.Option<Membership>, InvitationRepoError>;
    /**
     * Whether `email` already belongs to a member of `workspaceId` (resolved
     * via the `users` table). `true` short-circuits an invite as already_member.
     */
    readonly emailIsMember: (
      workspaceId: string,
      email: string,
    ) => Effect.Effect<boolean, InvitationRepoError>;
    /** The live member count for a workspace (to derive the seat ceiling). */
    readonly countMembers: (
      workspaceId: string,
    ) => Effect.Effect<number, InvitationRepoError>;
    /** The workspace name + owner email for the Autumn customer profile. */
    readonly workspaceCustomerData: (
      workspaceId: string,
    ) => Effect.Effect<WorkspaceCustomerData, InvitationRepoError>;
    /** The display name of a workspace (or `null` if missing). */
    readonly workspaceName: (
      workspaceId: string,
    ) => Effect.Effect<string | null, InvitationRepoError>;
    /** A user's display name + email (the inviter), or nulls if missing. */
    readonly userInfo: (
      userId: string,
    ) => Effect.Effect<UserInfo, InvitationRepoError>;
    /**
     * Insert a new pending invite OR refresh the existing pending invite for the
     * same (workspace, email). Returns the resulting row.
     */
    readonly upsertPending: (
      input: UpsertInviteInput,
    ) => Effect.Effect<Invitation, InvitationRepoError>;
    /** Mark a pending invitation revoked (idempotent on non-pending rows). */
    readonly revoke: (
      invitationId: string,
    ) => Effect.Effect<void, InvitationRepoError>;
    /**
     * Atomically (invitations + members): re-validate the invite, enforce the
     * seat ceiling against the live member count, insert the membership, and mark
     * the invite accepted. The port of `acceptInvitationInsert`
     * (convex/invitations.ts:487).
     */
    readonly acceptInsert: (
      input: AcceptInsertInput,
    ) => Effect.Effect<
      AcceptInsertResult,
      InvitationRepoError | InvalidInvitationError | SeatLimitExceededError
    >;
  }
>() {}

/** Map a Drizzle invitations row to the {@link Invitation} projection. */
type InvitationRow = {
  id: string;
  workspaceId: string;
  email: string;
  role: MemberRole;
  token: string;
  status: InvitationStatus;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedBy: string | null;
  acceptedAt: number | null;
};

const toInvitation = (r: InvitationRow): Invitation => ({
  id: r.id,
  workspaceId: r.workspaceId,
  email: r.email,
  role: r.role,
  token: r.token,
  status: r.status,
  invitedBy: r.invitedBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  acceptedBy: r.acceptedBy,
  acceptedAt: r.acceptedAt,
});

const INVITATION_COLUMNS = {
  id: schema.invitations.id,
  workspaceId: schema.invitations.workspaceId,
  email: schema.invitations.email,
  role: schema.invitations.role,
  token: schema.invitations.token,
  status: schema.invitations.status,
  invitedBy: schema.invitations.invitedBy,
  createdAt: schema.invitations.createdAt,
  expiresAt: schema.invitations.expiresAt,
  acceptedBy: schema.invitations.acceptedBy,
  acceptedAt: schema.invitations.acceptedAt,
} as const;

/** The seat-ceiling guard, mirroring `SeatsService.enforceSeatCeiling`. */
const enforceCeiling = (
  currentCount: number,
  ceiling: number | null,
): Effect.Effect<void, SeatLimitExceededError> =>
  ceiling === null || currentCount < ceiling
    ? Effect.void
    : Effect.fail(
        new SeatLimitExceededError({
          message:
            `Adding a member would exceed the seat limit ` +
            `(${currentCount}/${ceiling}).`,
          currentCount,
          ceiling,
        }),
      );

/**
 * The Drizzle-backed `InvitationRepo` Layer. Depends on {@link DbClient}. Every
 * call is wrapped so a transport failure becomes a typed
 * {@link InvitationRepoError}; the accept path runs inside a single
 * `db.transaction` so the seat ceiling cannot be overshot by a concurrent
 * accept.
 */
export const InvitationRepoLive: Layer.Layer<InvitationRepo, never, DbClient> =
  Layer.effect(
    InvitationRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;

      const fail = (message: string) => (cause: unknown) =>
        new InvitationRepoError({
          message: cause instanceof Error ? cause.message : message,
          cause,
        });

      const findByToken: InvitationRepo["Type"]["findByToken"] = (token) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select(INVITATION_COLUMNS)
              .from(schema.invitations)
              .where(eq(schema.invitations.token, token))
              .limit(1);
            return Option.fromNullable(
              rows[0] === undefined ? null : toInvitation(rows[0]),
            );
          },
          catch: fail("invitation lookup failed"),
        });

      const listPendingByWorkspace: InvitationRepo["Type"]["listPendingByWorkspace"] =
        (workspaceId) =>
          !UUID_RE.test(workspaceId)
            ? Effect.succeed([])
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select(INVITATION_COLUMNS)
                    .from(schema.invitations)
                    .where(eq(schema.invitations.workspaceId, workspaceId));
                  return rows
                    .map(toInvitation)
                    .filter((r) => r.status === "pending")
                    .sort((a, b) => b.createdAt - a.createdAt);
                },
                catch: fail("invitation list failed"),
              });

      const listPendingByEmail: InvitationRepo["Type"]["listPendingByEmail"] = (
        email,
      ) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select(INVITATION_COLUMNS)
              .from(schema.invitations)
              .where(eq(schema.invitations.email, email));
            return rows.map(toInvitation).filter((r) => r.status === "pending");
          },
          catch: fail("invitation list failed"),
        });

      const findById: InvitationRepo["Type"]["findById"] = (invitationId) =>
        !UUID_RE.test(invitationId)
          ? Effect.succeed(Option.none())
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select(INVITATION_COLUMNS)
                  .from(schema.invitations)
                  .where(eq(schema.invitations.id, invitationId))
                  .limit(1);
                return Option.fromNullable(
                  rows[0] === undefined ? null : toInvitation(rows[0]),
                );
              },
              catch: fail("invitation lookup failed"),
            });

      const findMembership: InvitationRepo["Type"]["findMembership"] = (
        workspaceId,
        userId,
      ) =>
        !UUID_RE.test(workspaceId)
          ? Effect.succeed(Option.none())
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({
                    workspaceId: schema.members.workspaceId,
                    userId: schema.members.userId,
                    role: schema.members.role,
                  })
                  .from(schema.members)
                  .where(
                    and(
                      eq(schema.members.workspaceId, workspaceId),
                      eq(schema.members.userId, userId),
                    ),
                  )
                  .limit(1);
                return Option.fromNullable(
                  rows[0] === undefined ? null : (rows[0] satisfies Membership),
                );
              },
              catch: fail("membership lookup failed"),
            });

      const emailIsMember: InvitationRepo["Type"]["emailIsMember"] = (
        workspaceId,
        email,
      ) =>
        !UUID_RE.test(workspaceId)
          ? Effect.succeed(false)
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({ userId: schema.members.userId })
                  .from(schema.members)
                  .innerJoin(
                    schema.users,
                    eq(schema.members.userId, schema.users.id),
                  )
                  .where(
                    and(
                      eq(schema.members.workspaceId, workspaceId),
                      eq(schema.users.email, email),
                    ),
                  )
                  .limit(1);
                return rows.length > 0;
              },
              catch: fail("membership lookup failed"),
            });

      const countMembers: InvitationRepo["Type"]["countMembers"] = (
        workspaceId,
      ) =>
        !UUID_RE.test(workspaceId)
          ? Effect.succeed(0)
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({ userId: schema.members.userId })
                  .from(schema.members)
                  .where(eq(schema.members.workspaceId, workspaceId));
                return rows.length;
              },
              catch: fail("member count failed"),
            });

      const workspaceCustomerData: InvitationRepo["Type"]["workspaceCustomerData"] =
        (workspaceId) =>
          !UUID_RE.test(workspaceId)
            ? Effect.succeed({ name: null, email: null })
            : Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select({
                      name: schema.workspaces.name,
                      email: schema.users.email,
                    })
                    .from(schema.workspaces)
                    .leftJoin(
                      schema.users,
                      eq(schema.workspaces.ownerId, schema.users.id),
                    )
                    .where(eq(schema.workspaces.id, workspaceId))
                    .limit(1);
                  const row = rows[0];
                  return row === undefined
                    ? { name: null, email: null }
                    : { name: row.name, email: row.email ?? null };
                },
                catch: fail("workspace lookup failed"),
              });

      const workspaceName: InvitationRepo["Type"]["workspaceName"] = (
        workspaceId,
      ) =>
        !UUID_RE.test(workspaceId)
          ? Effect.succeed(null)
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({ name: schema.workspaces.name })
                  .from(schema.workspaces)
                  .where(eq(schema.workspaces.id, workspaceId))
                  .limit(1);
                return rows[0]?.name ?? null;
              },
              catch: fail("workspace lookup failed"),
            });

      const userInfo: InvitationRepo["Type"]["userInfo"] = (userId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({ name: schema.users.name, email: schema.users.email })
              .from(schema.users)
              .where(eq(schema.users.id, userId))
              .limit(1);
            const row = rows[0];
            return row === undefined
              ? { name: null, email: null }
              : { name: row.name ?? null, email: row.email };
          },
          catch: fail("user lookup failed"),
        });

      const upsertPending: InvitationRepo["Type"]["upsertPending"] = (input) =>
        Effect.tryPromise({
          try: async () => {
            const existing = await db
              .select(INVITATION_COLUMNS)
              .from(schema.invitations)
              .where(
                and(
                  eq(schema.invitations.workspaceId, input.workspaceId),
                  eq(schema.invitations.email, input.email),
                ),
              );
            const pending = existing
              .map(toInvitation)
              .find((i) => i.status === "pending");
            if (pending !== undefined) {
              const updated = await db
                .update(schema.invitations)
                .set({
                  role: input.role,
                  token: input.token,
                  expiresAt: input.expiresAt,
                  invitedBy: input.invitedBy,
                  createdAt: input.createdAt,
                })
                .where(eq(schema.invitations.id, pending.id))
                .returning(INVITATION_COLUMNS);
              return toInvitation(updated[0]);
            }
            const inserted = await db
              .insert(schema.invitations)
              .values({
                workspaceId: input.workspaceId,
                email: input.email,
                role: input.role,
                token: input.token,
                status: "pending",
                invitedBy: input.invitedBy,
                createdAt: input.createdAt,
                expiresAt: input.expiresAt,
              })
              .returning(INVITATION_COLUMNS);
            return toInvitation(inserted[0]);
          },
          catch: fail("invitation upsert failed"),
        });

      const revoke: InvitationRepo["Type"]["revoke"] = (invitationId) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(schema.invitations)
              .set({ status: "revoked" })
              .where(
                and(
                  eq(schema.invitations.id, invitationId),
                  eq(schema.invitations.status, "pending"),
                ),
              );
          },
          catch: fail("invitation revoke failed"),
        });

      const acceptInsert: InvitationRepo["Type"]["acceptInsert"] = (input) =>
        Effect.gen(function* () {
          // Re-read the invite, count members, enforce the ceiling, insert the
          // member and mark accepted — all in one transaction so the ceiling is
          // atomic. The result is unwrapped from a typed-union value the tx
          // returns, so a domain failure inside the tx surfaces as the right
          // typed error after the transport boundary.
          const result = yield* Effect.tryPromise({
            try: () =>
              db.transaction(async (tx) => {
                const invRows = await tx
                  .select(INVITATION_COLUMNS)
                  .from(schema.invitations)
                  .where(eq(schema.invitations.id, input.invitationId))
                  .limit(1);
                const inv =
                  invRows[0] === undefined ? null : toInvitation(invRows[0]);
                if (inv === null) {
                  return { kind: "invalid" as const, message: "Invitation gone." };
                }
                const { workspaceId } = inv;

                const live =
                  inv.status === "pending" &&
                  inv.expiresAt > input.now &&
                  inv.email === input.email;
                if (!live) {
                  if (
                    inv.status === "accepted" &&
                    inv.acceptedBy === input.userId
                  ) {
                    return {
                      kind: "ok" as const,
                      alreadyMember: true,
                      workspaceId,
                    };
                  }
                  return {
                    kind: "invalid" as const,
                    message: "This invitation is no longer valid.",
                  };
                }

                const members = await tx
                  .select({ userId: schema.members.userId })
                  .from(schema.members)
                  .where(eq(schema.members.workspaceId, workspaceId));
                const already = members.some((m) => m.userId === input.userId);
                if (already) {
                  await tx
                    .update(schema.invitations)
                    .set({
                      status: "accepted",
                      acceptedBy: input.userId,
                      acceptedAt: input.now,
                    })
                    .where(eq(schema.invitations.id, input.invitationId));
                  return {
                    kind: "ok" as const,
                    alreadyMember: true,
                    workspaceId,
                  };
                }

                if (
                  input.seatCeiling !== null &&
                  members.length >= input.seatCeiling
                ) {
                  return {
                    kind: "seat_limit" as const,
                    currentCount: members.length,
                    ceiling: input.seatCeiling,
                  };
                }

                await tx.insert(schema.members).values({
                  workspaceId,
                  userId: input.userId,
                  role: inv.role,
                  createdAt: input.now,
                });
                await tx
                  .update(schema.invitations)
                  .set({
                    status: "accepted",
                    acceptedBy: input.userId,
                    acceptedAt: input.now,
                  })
                  .where(eq(schema.invitations.id, input.invitationId));
                return {
                  kind: "ok" as const,
                  alreadyMember: false,
                  workspaceId,
                };
              }),
            catch: fail("invitation accept failed"),
          });

          if (result.kind === "invalid") {
            return yield* Effect.fail(
              new InvalidInvitationError({ message: result.message }),
            );
          }
          if (result.kind === "seat_limit") {
            // The ceiling guard always fails here (the tx only returns this when
            // over the limit); reuse the shared comparison for the typed error.
            return yield* enforceCeiling(
              result.currentCount,
              result.ceiling,
            ).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new InvalidInvitationError({
                    message: "Seat ceiling reached.",
                  }),
                ),
              ),
            );
          }
          return {
            alreadyMember: result.alreadyMember,
            workspaceId: result.workspaceId,
          };
        });

      return {
        findByToken,
        listPendingByWorkspace,
        listPendingByEmail,
        findById,
        findMembership,
        emailIsMember,
        countMembers,
        workspaceCustomerData,
        workspaceName,
        userInfo,
        upsertPending,
        revoke,
        acceptInsert,
      };
    }),
  );

/** A workspace projection the in-memory repo needs (name + owner). */
export interface InMemoryWorkspace {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
}

/** A user projection the in-memory repo needs (id + name + email). */
export interface InMemoryUser {
  readonly id: string;
  readonly name?: string | null;
  readonly email: string;
}

/** Fixtures for the in-memory {@link invitationRepoLayer}. */
export interface InvitationRepoFixtures {
  readonly invitations?: readonly Invitation[];
  readonly members?: readonly Membership[];
  readonly workspaces?: readonly InMemoryWorkspace[];
  readonly users?: readonly InMemoryUser[];
}

/**
 * An in-memory `InvitationRepo` Layer backed by MUTABLE copies of the fixtures,
 * so the full invite -> accept lifecycle (upsert, revoke, the transactional
 * accept-insert) is exercised exactly like the Drizzle Layer but with NO live
 * database. The accept-insert mirrors the Live transaction's re-validation +
 * seat-ceiling guard.
 */
export const invitationRepoLayer = (
  fixtures: InvitationRepoFixtures = {},
): Layer.Layer<InvitationRepo> => {
  const invitations: Invitation[] = [...(fixtures.invitations ?? [])];
  const members: Membership[] = [...(fixtures.members ?? [])];
  const workspaces = fixtures.workspaces ?? [];
  const users = fixtures.users ?? [];

  return Layer.succeed(InvitationRepo, {
    findByToken: (token) =>
      Effect.succeed(
        Option.fromNullable(invitations.find((i) => i.token === token)),
      ),
    listPendingByWorkspace: (workspaceId) =>
      Effect.succeed(
        invitations
          .filter((i) => i.workspaceId === workspaceId && i.status === "pending")
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    listPendingByEmail: (email) =>
      Effect.succeed(
        invitations.filter((i) => i.email === email && i.status === "pending"),
      ),
    findById: (invitationId) =>
      Effect.succeed(
        Option.fromNullable(invitations.find((i) => i.id === invitationId)),
      ),
    findMembership: (workspaceId, userId) =>
      Effect.succeed(
        Option.fromNullable(
          members.find(
            (m) => m.workspaceId === workspaceId && m.userId === userId,
          ),
        ),
      ),
    emailIsMember: (workspaceId, email) =>
      Effect.succeed(
        members.some((m) => {
          if (m.workspaceId !== workspaceId) return false;
          const u = users.find((x) => x.id === m.userId);
          return u !== undefined && u.email === email;
        }),
      ),
    countMembers: (workspaceId) =>
      Effect.succeed(
        members.filter((m) => m.workspaceId === workspaceId).length,
      ),
    workspaceCustomerData: (workspaceId) =>
      Effect.succeed(
        (() => {
          const ws = workspaces.find((w) => w.id === workspaceId);
          if (ws === undefined) return { name: null, email: null };
          const owner = users.find((u) => u.id === ws.ownerId);
          return { name: ws.name, email: owner?.email ?? null };
        })(),
      ),
    workspaceName: (workspaceId) =>
      Effect.succeed(workspaces.find((w) => w.id === workspaceId)?.name ?? null),
    userInfo: (userId) =>
      Effect.succeed(
        (() => {
          const u = users.find((x) => x.id === userId);
          return u === undefined
            ? { name: null, email: null }
            : { name: u.name ?? null, email: u.email };
        })(),
      ),
    upsertPending: (input) =>
      Effect.sync(() => {
        const pending = invitations.find(
          (i) =>
            i.workspaceId === input.workspaceId &&
            i.email === input.email &&
            i.status === "pending",
        );
        if (pending !== undefined) {
          const refreshed: Invitation = {
            ...pending,
            role: input.role,
            token: input.token,
            expiresAt: input.expiresAt,
            invitedBy: input.invitedBy,
            createdAt: input.createdAt,
          };
          const idx = invitations.indexOf(pending);
          invitations[idx] = refreshed;
          return refreshed;
        }
        const created: Invitation = {
          id: `inv_${invitations.length + 1}_${input.token.slice(0, 8)}`,
          workspaceId: input.workspaceId,
          email: input.email,
          role: input.role,
          token: input.token,
          status: "pending",
          invitedBy: input.invitedBy,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          acceptedBy: null,
          acceptedAt: null,
        };
        invitations.push(created);
        return created;
      }),
    revoke: (invitationId) =>
      Effect.sync(() => {
        const idx = invitations.findIndex((i) => i.id === invitationId);
        if (idx >= 0 && invitations[idx].status === "pending") {
          invitations[idx] = { ...invitations[idx], status: "revoked" };
        }
      }),
    acceptInsert: (input) =>
      Effect.gen(function* () {
        const idx = invitations.findIndex((i) => i.id === input.invitationId);
        const inv = idx >= 0 ? invitations[idx] : null;
        if (inv === null) {
          return yield* Effect.fail(
            new InvalidInvitationError({ message: "Invitation gone." }),
          );
        }
        const { workspaceId } = inv;
        const live =
          inv.status === "pending" &&
          inv.expiresAt > input.now &&
          inv.email === input.email;
        if (!live) {
          if (inv.status === "accepted" && inv.acceptedBy === input.userId) {
            return { alreadyMember: true, workspaceId };
          }
          return yield* Effect.fail(
            new InvalidInvitationError({
              message: "This invitation is no longer valid.",
            }),
          );
        }

        const live_members = members.filter(
          (m) => m.workspaceId === workspaceId,
        );
        if (live_members.some((m) => m.userId === input.userId)) {
          invitations[idx] = {
            ...inv,
            status: "accepted",
            acceptedBy: input.userId,
            acceptedAt: input.now,
          };
          return { alreadyMember: true, workspaceId };
        }

        yield* enforceCeiling(live_members.length, input.seatCeiling);

        members.push({ workspaceId, userId: input.userId, role: inv.role });
        invitations[idx] = {
          ...inv,
          status: "accepted",
          acceptedBy: input.userId,
          acceptedAt: input.now,
        };
        return { alreadyMember: false, workspaceId };
      }),
  });
};
