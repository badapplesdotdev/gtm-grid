/**
 * `LifecycleEmailRepo` — the Effect <-> Drizzle adapter behind the lifecycle
 * email system (#8–#20): recipient/preference lookups, the once-only send log
 * (`lifecycle_email_sends`), and the `users.last_active_at` presence signal.
 *
 * Owns exactly the four seams the Inngest send-guard + lifecycle crons need:
 *   - {@link LifecycleEmailRepo.getRecipient} — email/name/category prefs for a user.
 *   - {@link LifecycleEmailRepo.recordSendOnce} — atomically claim a
 *     (user, template, dedupeKey) send slot via `ON CONFLICT DO NOTHING`; the
 *     boolean result is the idempotency gate (false = already sent, skip).
 *   - {@link LifecycleEmailRepo.releaseSend} — roll a claim back when the Resend
 *     call fails, so the next retry can claim it again (claim-then-send gives
 *     at-most-once delivery, never duplicates).
 *   - {@link LifecycleEmailRepo.setEmailPref} / {@link LifecycleEmailRepo.touchLastActive}
 *     — the unsubscribe route + desktop heartbeat writes.
 *
 * Two Layers, per the {@link WorkspaceRepo} worked example: Drizzle-backed
 * {@link LifecycleEmailRepoLive} and the in-memory {@link lifecycleEmailRepoLayer}
 * for offline tests.
 */

import { schema } from "@gtmgrid/db";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { DbClient } from "../db-client.js";

/** Lifecycle email categories a user can opt out of (transactional cannot be). */
export type LifecycleCategory = "activation" | "status" | "digest";

/** Recipient projection for a send: address, display name, opt-outs, presence. */
export interface LifecycleRecipient {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  /** Category opt-outs; absent key = subscribed. */
  readonly emailPrefs: Readonly<Record<string, boolean>>;
  /** Last heartbeat, or null when the user has never reported activity. */
  readonly lastActiveAt: Date | null;
}

/** One claimed/delivered send row (insert shape). */
export interface LifecycleSendClaim {
  readonly userId: string;
  readonly workspaceId: string | null;
  /** Template slug, e.g. "run-finished". */
  readonly template: string;
  /** Idempotency scope within (user, template): window or entity key. */
  readonly dedupeKey: string;
}

/** Raised when a lifecycle-email read/write fails (DB/transport error). */
export class LifecycleEmailRepoError extends Data.TaggedError(
  "LifecycleEmailRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LifecycleEmailRepo extends Context.Tag("LifecycleEmailRepo")<
  LifecycleEmailRepo,
  {
    /** Load a user's send profile, or null when the user does not exist. */
    readonly getRecipient: (
      userId: string,
    ) => Effect.Effect<LifecycleRecipient | null, LifecycleEmailRepoError>;
    /**
     * Claim the (user, template, dedupeKey) slot. True = this call inserted the
     * row and the caller may send; false = a prior run already claimed it.
     */
    readonly recordSendOnce: (
      claim: LifecycleSendClaim,
    ) => Effect.Effect<boolean, LifecycleEmailRepoError>;
    /** Release a claim after a FAILED send so a retry can claim it again. */
    readonly releaseSend: (
      claim: Pick<LifecycleSendClaim, "userId" | "template" | "dedupeKey">,
    ) => Effect.Effect<void, LifecycleEmailRepoError>;
    /** Set one category's opt-in state (merges into `users.email_prefs`). */
    readonly setEmailPref: (
      userId: string,
      category: LifecycleCategory,
      enabled: boolean,
    ) => Effect.Effect<void, LifecycleEmailRepoError>;
    /** Bump `users.last_active_at` to now (desktop heartbeat / realtime connect). */
    readonly touchLastActive: (
      userId: string,
    ) => Effect.Effect<void, LifecycleEmailRepoError>;
  }
>() {}

const fail = (message: string) => (cause: unknown) =>
  new LifecycleEmailRepoError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  });

/** The Drizzle-backed Layer. */
export const LifecycleEmailRepoLive: Layer.Layer<
  LifecycleEmailRepo,
  never,
  DbClient
> = Layer.effect(
  LifecycleEmailRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return {
      getRecipient: (userId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                id: schema.users.id,
                email: schema.users.email,
                name: schema.users.name,
                emailPrefs: schema.users.emailPrefs,
                lastActiveAt: schema.users.lastActiveAt,
              })
              .from(schema.users)
              .where(eq(schema.users.id, userId))
              .limit(1);
            const r = rows[0];
            if (r === undefined) return null;
            return {
              id: r.id,
              email: r.email,
              name: r.name,
              emailPrefs: r.emailPrefs ?? {},
              lastActiveAt: r.lastActiveAt,
            };
          },
          catch: fail("recipient lookup failed"),
        }),

      recordSendOnce: (claim) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .insert(schema.lifecycleEmailSends)
              .values({
                userId: claim.userId,
                workspaceId: claim.workspaceId,
                template: claim.template,
                dedupeKey: claim.dedupeKey,
              })
              .onConflictDoNothing()
              .returning({ id: schema.lifecycleEmailSends.id });
            return rows.length > 0;
          },
          catch: fail("send claim failed"),
        }),

      releaseSend: (claim) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .delete(schema.lifecycleEmailSends)
              .where(
                and(
                  eq(schema.lifecycleEmailSends.userId, claim.userId),
                  eq(schema.lifecycleEmailSends.template, claim.template),
                  eq(schema.lifecycleEmailSends.dedupeKey, claim.dedupeKey),
                ),
              );
          },
          catch: fail("send release failed"),
        }),

      setEmailPref: (userId, category, enabled) =>
        Effect.tryPromise({
          try: async () => {
            // Read-modify-write is fine: prefs writes are rare (unsubscribe
            // clicks), and last-write-wins per category is the intended UX.
            const rows = await db
              .select({ emailPrefs: schema.users.emailPrefs })
              .from(schema.users)
              .where(eq(schema.users.id, userId))
              .limit(1);
            const prev = rows[0]?.emailPrefs ?? {};
            await db
              .update(schema.users)
              .set({ emailPrefs: { ...prev, [category]: enabled } })
              .where(eq(schema.users.id, userId));
          },
          catch: fail("email pref update failed"),
        }),

      touchLastActive: (userId) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(schema.users)
              .set({ lastActiveAt: new Date() })
              .where(eq(schema.users.id, userId));
          },
          catch: fail("last-active touch failed"),
        }),
    };
  }),
);

/**
 * In-memory Test Layer: a user map + send set, mirroring Live semantics
 * (including the once-only claim) with NO database.
 */
export const lifecycleEmailRepoLayer = (seed?: {
  readonly users?: readonly {
    readonly id: string;
    readonly email: string;
    readonly name?: string | null;
    readonly emailPrefs?: Record<string, boolean>;
    readonly lastActiveAt?: Date | null;
  }[];
}): Layer.Layer<LifecycleEmailRepo> =>
  Layer.sync(LifecycleEmailRepo, () => {
    const users = new Map(
      (seed?.users ?? []).map((u) => [
        u.id,
        {
          id: u.id,
          email: u.email,
          name: u.name ?? null,
          emailPrefs: { ...(u.emailPrefs ?? {}) } as Record<string, boolean>,
          lastActiveAt: u.lastActiveAt ?? null,
        },
      ]),
    );
    const sends = new Set<string>();
    const key = (c: Pick<LifecycleSendClaim, "userId" | "template" | "dedupeKey">) =>
      `${c.userId} ${c.template} ${c.dedupeKey}`;
    return {
      getRecipient: (userId) => {
        const u = users.get(userId);
        return Effect.succeed(
          u === undefined
            ? null
            : {
                id: u.id,
                email: u.email,
                name: u.name,
                emailPrefs: { ...u.emailPrefs },
                lastActiveAt: u.lastActiveAt,
              },
        );
      },
      recordSendOnce: (claim) => {
        const k = key(claim);
        if (sends.has(k)) return Effect.succeed(false);
        sends.add(k);
        return Effect.succeed(true);
      },
      releaseSend: (claim) => {
        sends.delete(key(claim));
        return Effect.void;
      },
      setEmailPref: (userId, category, enabled) => {
        const u = users.get(userId);
        if (u) u.emailPrefs[category] = enabled;
        return Effect.void;
      },
      touchLastActive: (userId) => {
        const u = users.get(userId);
        if (u) u.lastActiveAt = new Date();
        return Effect.void;
      },
    };
  });
