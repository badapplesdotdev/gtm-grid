/**
 * Live (Drizzle-backed) `MemberRepo` Layer.
 *
 * `MemberRepo` itself is defined in `@gtmgrid/cloud` (the pure authz domain);
 * this module is the Effect <-> Drizzle ADAPTER that backs it for the Postgres
 * tier — the direct port of the Convex `memberRepoLayer` (convex/model/auth.ts:82)
 * which queried `ctx.db.query("members").withIndex("by_workspace_user", …)`.
 *
 * Here the same lookup is a Drizzle select against the `members` table's
 * (workspaceId, userId) pair (the `members_by_workspace_user` unique index,
 * packages/db/src/schema.ts:260). The workspace id arrives as a plain string;
 * an id that is not a valid uuid (or simply unknown) returns `None` =
 * "no membership", matching the Convex `normalizeId` -> null behaviour.
 *
 * Tests use the in-memory `memberRepoLayer` from `@gtmgrid/cloud` instead, so the
 * authz rules are exercised with no live database.
 */

import { type Membership, MemberRepo, MemberRepoError } from "@gtmgrid/cloud";
import { schema } from "@gtmgrid/db";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/** Postgres uuid shape — `members.workspaceId` is a uuid column. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Drizzle-backed `MemberRepo` Layer. Depends on {@link DbClient}. Looks up
 * the single membership row for (workspaceId, userId); a non-uuid workspace id
 * short-circuits to `None` (the Postgres driver would otherwise reject the
 * predicate), so "unknown workspace" reads as "not a member" rather than an
 * error.
 */
export const MemberRepoLive: Layer.Layer<MemberRepo, never, DbClient> =
  Layer.effect(
    MemberRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      return {
        findMembership: (workspaceId, userId) =>
          UUID_RE.test(workspaceId)
            ? Effect.tryPromise({
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
                    rows[0] === undefined
                      ? null
                      : ({
                          workspaceId: rows[0].workspaceId,
                          userId: rows[0].userId,
                          role: rows[0].role,
                        } satisfies Membership),
                  );
                },
                catch: (cause) =>
                  new MemberRepoError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "membership lookup failed",
                    cause,
                  }),
              })
            : Effect.succeed(Option.none<Membership>()),
      };
    }),
  );
