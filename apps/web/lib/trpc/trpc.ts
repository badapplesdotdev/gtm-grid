/**
 * tRPC initialization + the Effect execution seam.
 *
 * Exposes:
 *   - `publicProcedure` — no auth.
 *   - `protectedProcedure` — requires a Better Auth session; narrows `userId` to
 *     a non-null string in the context.
 *   - `workspaceProcedure` — takes a `workspaceId` input and asserts the caller
 *     is a MEMBER of it by running `MembershipService.requireMember` (the Effect
 *     port of `requireMember`, convex/model/auth.ts:162). Non-members are
 *     rejected with `FORBIDDEN` before the procedure body runs.
 *   - `runEffect` — runs an Effect program against the request's services
 *     runtime, translating the typed error channel into `TRPCError` codes so the
 *     same program works in production and under `createCaller` in tests.
 */

import { type AppServices, MembershipService } from "@gtmgrid/services";
import { initTRPC, TRPCError } from "@trpc/server";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import type { ServicesRuntime, TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Base procedure — open to anyone. */
export const publicProcedure = t.procedure;

/** Maps a typed Effect failure (`Data.TaggedError`) to a `TRPCError` code. */
function toTrpcError(tag: string | undefined, message: string): TRPCError {
  switch (tag) {
    case "UnauthenticatedError":
      return new TRPCError({ code: "UNAUTHORIZED", message });
    case "NotAMemberError":
    case "InsufficientRoleError":
    case "CredentialOwnershipError":
      return new TRPCError({ code: "FORBIDDEN", message });
    case "WorkspaceNotFoundError":
    case "WebhookNotFoundError":
      return new TRPCError({ code: "NOT_FOUND", message });
    // Billing/seats domain (W2): a forged/unknown plan is a bad request; a
    // reached seat cap is a precondition failure; a misconfigured plan with no
    // checkout URL and an Autumn transport error are server-side.
    case "UnknownPlanError":
      return new TRPCError({ code: "BAD_REQUEST", message });
    case "SeatLimitExceededError":
      return new TRPCError({ code: "PRECONDITION_FAILED", message });
    case "NoCheckoutUrlError":
    case "AutumnError":
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
    // Invitations domain (W2): an unknown/expired token is not found; a
    // malformed email is a bad request.
    case "InvalidInvitationError":
      return new TRPCError({ code: "NOT_FOUND", message });
    case "InvalidEmailError":
    // Webhooks domain (W2): malformed mapping/config/cell values are bad requests.
    case "InvalidMappingError":
    case "InvalidConfigError":
    case "InvalidCellError":
      return new TRPCError({ code: "BAD_REQUEST", message });
    // Webhooks domain (W2): exceeding the cloud-actions cap is a forbidden op.
    case "CloudActionsLimitError":
      return new TRPCError({ code: "FORBIDDEN", message });
    default:
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
  }
}

/**
 * Run an Effect program against the request's services runtime. On a typed
 * failure, throw the mapped `TRPCError`; on a defect (non-typed crash), rethrow
 * for the server to log. This is THE helper procedures use to execute Effects.
 */
export async function runEffect<A, E>(
  runtime: ServicesRuntime,
  program: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    const err = failure.value as { _tag?: string; message?: string };
    throw toTrpcError(err._tag, err.message ?? "Request failed.");
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: Cause.pretty(exit.cause),
  });
}

/**
 * Requires an authenticated session. Narrows `ctx.userId` to a non-null string
 * so downstream procedures/queries can rely on the caller id.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.userId === null) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not authenticated.",
    });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

/** Every workspace-scoped procedure carries a `workspaceId` input. */
const workspaceInput = z.object({ workspaceId: z.string().min(1) });

/**
 * Authenticated AND a member of `input.workspaceId`. Runs
 * `MembershipService.requireMember` through {@link runEffect}; the typed authz
 * failures become `UNAUTHORIZED` / `FORBIDDEN`. The asserted membership (with
 * role) is attached to `ctx.membership` for the procedure body.
 */
export const workspaceProcedure = protectedProcedure
  .input(workspaceInput)
  .use(async ({ ctx, input, next }) => {
    const membership = await runEffect(
      ctx.runtime,
      Effect.gen(function* () {
        const svc = yield* MembershipService;
        return yield* svc.requireMember(input.workspaceId);
      }),
    );
    return next({ ctx: { ...ctx, membership } });
  });
