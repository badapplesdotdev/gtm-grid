/**
 * `InviteEmailPort` — the injectable seam for sending the workspace-invite email.
 *
 * `InvitationService` sends the accept-link email through this port instead of
 * importing `@gtmgrid/email` directly, so:
 *
 *   - PRODUCTION provides {@link InviteEmailPortLive}, which renders the branded
 *     {@link inviteEmail} template and sends it via {@link sendEmail} (Resend).
 *     Sending is BEST-EFFORT: a delivery failure (or no `AUTH_RESEND_KEY`) must
 *     not fail the invite — the row already exists and the accept link is
 *     returned for copying — so `send` resolves to `false` on any error rather
 *     than failing the Effect, mirroring the Convex try/catch
 *     (convex/invitations.ts:241).
 *   - TESTS provide an in-memory port (recording the calls) so the invite flow is
 *     exercised with NO outbound email.
 *
 * `send` returns whether the email was actually delivered (the `emailSent` flag
 * the UI uses to decide whether to surface the copyable-link fallback).
 */

import { inviteEmail, sendEmail } from "@gtmgrid/email";
import { Context, Effect, Layer } from "effect";
import { ErrorReporter } from "./error-reporter.js";

/** The arguments for one invite email. */
export interface InviteEmailArgs {
  readonly to: string;
  readonly workspaceName: string;
  readonly inviterName: string | null;
  readonly inviterEmail: string | null;
  readonly acceptUrl: string;
}

/**
 * Sends the workspace-invite email. `send` never fails — it resolves to `true`
 * when delivery succeeded and `false` when it was skipped/failed (best-effort),
 * so a Resend outage cannot break the invite.
 */
export class InviteEmailPort extends Context.Tag("InviteEmailPort")<
  InviteEmailPort,
  {
    readonly send: (args: InviteEmailArgs) => Effect.Effect<boolean>;
  }
>() {}

/**
 * The live `InviteEmailPort` — renders + sends via `@gtmgrid/email`. Best-effort:
 * any failure (including an unset Resend key, which `sendEmail` no-ops) resolves
 * to `false` instead of failing.
 */
export const InviteEmailPortLive: Layer.Layer<InviteEmailPort, never, ErrorReporter> =
  Layer.effect(
    InviteEmailPort,
    Effect.gen(function* () {
      // Captured at layer build so the `send` signature stays requirement-free.
      const reporter = yield* ErrorReporter;
      return {
        send: (args) =>
          Effect.tryPromise(() =>
            sendEmail(
              inviteEmail({
                to: args.to,
                workspaceName: args.workspaceName,
                inviterName: args.inviterName,
                inviterEmail: args.inviterEmail,
                acceptUrl: args.acceptUrl,
              }),
            ),
          ).pipe(
            Effect.as(true),
            // Best-effort: a delivery failure must NOT fail the invite, but it's a
            // real failure worth seeing — report it to Error Tracking, then fold to
            // `false` (the UI surfaces the copyable-link fallback).
            Effect.catchAll((cause) =>
              reporter
                .report(cause, { source: "invite-email", to: args.to })
                .pipe(Effect.as(false)),
            ),
          ),
      };
    }),
  );

/**
 * An in-memory `InviteEmailPort` for tests. Records each call into `sent` and
 * reports `delivered` (default `true`) as the result, so a test asserts the
 * invite email's arguments without sending one.
 */
export const inviteEmailPortLayer = (params: {
  readonly sent: InviteEmailArgs[];
  readonly delivered?: boolean;
}): Layer.Layer<InviteEmailPort> =>
  Layer.succeed(InviteEmailPort, {
    send: (args) =>
      Effect.sync(() => {
        params.sent.push(args);
        return params.delivered ?? true;
      }),
  });
