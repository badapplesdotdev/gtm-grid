/**
 * `invitations` router — the workspace-invitation API surface.
 *
 * The tRPC port of `convex/invitations.ts`, built on the W1 Effect-DI seam: each
 * procedure resolves {@link InvitationService} from the request runtime and runs
 * an Effect via {@link runEffect}, so the SAME procedures run against the live
 * Drizzle `appLayer` in production and a `TestLayer` under `createCaller` in
 * tests. The Convex action/mutation splits are collapsed into single procedures.
 *
 * Auth model:
 *   - `getInvitationByToken` is PUBLIC (no auth) — the token IS the capability,
 *     so the accept screen / web landing can preview an invite before sign-in.
 *   - `inviteByEmail` / `listInvitations` are workspace-scoped (the membership is
 *     asserted by `workspaceProcedure`; the service additionally enforces the
 *     owner/admin role on invite).
 *   - `revokeInvitation`, `myPendingInvitations`, `acceptInvitation` are
 *     authenticated (`protectedProcedure`); the service resolves the workspace /
 *     caller email from the invite + session.
 */

import { InvitationService } from "@gtmgrid/services";
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

/**
 * The roles an invite may grant. `owner` is accepted by the schema but rejected
 * by the service (`InvalidInviteRoleError` -> BAD_REQUEST) rather than dropped
 * here, so an older client that still sends it gets the explanation — invite as
 * admin, then transfer ownership — instead of an opaque validation failure.
 */
const roleInput = z.enum(["owner", "admin", "member"]);

export const invitationsRouter = router({
  /**
   * Invite a user by email (owner/admin only). Seat-gated via Autumn: over the
   * limit returns a checkout URL and creates no invite. Existing member ->
   * `already_member`. Otherwise upserts a pending invite + sends the email.
   */
  invite: workspaceProcedure
    .input(z.object({ email: z.string().min(1), role: roleInput }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* InvitationService;
          return yield* svc.inviteByEmail({
            workspaceId: input.workspaceId,
            email: input.email,
            role: input.role,
          });
        }),
      ),
    ),

  /** The pending invitations for a workspace (any member). */
  list: workspaceProcedure.query(({ ctx, input }) =>
    runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* InvitationService;
        return yield* svc.listInvitations(input.workspaceId);
      }),
    ),
  ),

  /** Revoke a pending invitation (owner/admin). The token stops working. */
  revoke: protectedProcedure
    .input(z.object({ invitationId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* InvitationService;
          yield* svc.revokeInvitation(input.invitationId);
          return null;
        }),
      ),
    ),

  /** Invitations waiting for the signed-in user (the in-app banner). */
  myPending: protectedProcedure.query(({ ctx }) =>
    runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* InvitationService;
        return yield* svc.myPendingInvitations();
      }),
    ),
  ),

  /**
   * PUBLIC preview of an invite token (no auth — the token is the capability).
   * Returns `{ valid: false }` for an unknown / non-pending / expired token.
   */
  getByToken: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* InvitationService;
          return yield* svc.getInvitationByToken(input.token);
        }),
      ),
    ),

  /**
   * Accept a pending invitation as the signed-in user. Validates the token is
   * live + issued to the caller's email, re-checks seats, inserts the membership
   * transactionally (the ceiling is re-enforced) and marks the invite accepted.
   */
  accept: protectedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* InvitationService;
          const result = yield* svc.acceptInvitation(input.token);
          // Notify the inviter out of band (best-effort): the teammate-joined
          // email (#19) rides an Inngest event so a queue hiccup never fails the
          // accept. Only on a genuinely NEW membership — re-accepts stay silent.
          if (result.status === "accepted" && result.newMember) {
            yield* Effect.tryPromise(() =>
              inngest.send({
                name: "workspace/member.joined",
                data: {
                  workspaceId: result.workspaceId,
                  joinedUserId: ctx.userId,
                  invitedBy: result.invitedBy,
                },
              }),
            ).pipe(Effect.ignore);
          }
          return result;
        }),
      ),
    ),
});
