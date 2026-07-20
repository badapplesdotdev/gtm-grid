/**
 * The `workspaces` tRPC router — the W2 port of convex/workspaces.ts.
 *
 * Every procedure resolves a service from the request runtime and runs an Effect
 * via `runEffect`, so the SAME procedures run against the live Drizzle Layer in
 * production and a `TestLayer` under `createCaller` in tests (no live DB).
 *
 *   - `me`              — the current user + their workspaces + seat/cloud-actions/
 *     plan usage (workspaces.ts:48). Returns `null` when signed out so the desktop
 *     `useMe` (cloud/auth.ts:142) renders the local/sign-in state. Shape matches
 *     `Me` (auth.ts:75) exactly.
 *   - `listMembers`     — a workspace roster + seat usage (workspaces.ts:136);
 *     `workspaceProcedure` asserts membership first.
 *   - `createWorkspace` — create a workspace with the owner membership in one op
 *     (workspaces.ts:178); `protectedProcedure` requires auth.
 *
 * The Convex action/mutation splits (`inviteMember`/`insertMember`,
 * `countMembers`, `workspaceCustomerData`) collapse into the WorkspaceService
 * methods these procedures call — one procedure per operation.
 */

import { type Me, WorkspaceService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { inngest } from "../../inngest/client";
import {
  protectedProcedure,
  publicProcedure,
  router,
  runEffect,
  workspaceProcedure,
} from "../trpc";

export const workspacesRouter = router({
  /**
   * The current user + their workspaces, or `null` when signed out. A PUBLIC
   * procedure (not protected) because the Convex `me` returns `null` for a
   * signed-out caller rather than erroring — the desktop `useMe`
   * (cloud/auth.ts:142) renders the local/sign-in state from that `null`. The
   * service's `UnauthenticatedError` is caught and mapped to `null` here (NOT a
   * 401), preserving that contract.
   */
  me: publicProcedure.query(({ ctx }): Promise<Me | null> =>
    runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        return yield* svc.me();
      }).pipe(
        Effect.catchTag("UnauthenticatedError", () =>
          Effect.succeed(null as Me | null),
        ),
      ),
    ),
  ),

  /** A workspace's roster + seat usage. Membership asserted by the procedure. */
  listMembers: workspaceProcedure.query(({ ctx, input }) =>
    runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* WorkspaceService;
        return yield* svc.listMembers(input.workspaceId);
      }),
    ),
  ),

  /** Create a workspace owned by the caller (with the owner membership). */
  createWorkspace: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WorkspaceService;
          // `protectedProcedure` already rejected signed-out callers, so this
          // never actually fails with UnauthenticatedError at runtime; the type
          // is satisfied by the service's declared channel.
          const workspaceId = yield* svc.createWorkspace(input.name);
          // Fire the trial-welcome email out of band (best-effort): a delivery /
          // queue hiccup must never fail workspace creation. The worker resolves
          // the owner email + sends `trialWelcomeEmail` (send-workspace-welcome).
          // `tryPromise` routes a rejected send (e.g. no INNGEST_EVENT_KEY in
          // dev/tests) into the error channel so `ignore` can swallow it — a bare
          // `Effect.promise` would surface the rejection as an uncatchable defect.
          yield* Effect.tryPromise(() =>
            inngest.send({ name: "workspace/created", data: { workspaceId } }),
          ).pipe(Effect.ignore);
          return workspaceId;
        }),
      ),
    ),

  /**
   * Permanently delete a workspace and ALL its data (members, projects,
   * tables, credentials, shares), cancelling its Autumn/Stripe subscription
   * first. Owner-only (enforced in the service); always allowed even on a
   * lapsed trial.
   */
  deleteWorkspace: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WorkspaceService;
          yield* svc.deleteWorkspace(input.workspaceId);
          return { ok: true as const };
        }),
      ),
    ),
});
