/**
 * Trial-welcome email on workspace creation.
 *
 * When a workspace is created its owner is put on a 7-day Team trial
 * (`WorkspaceService.createWorkspace`). The tRPC `createWorkspace` mutation emits
 * a `workspace/created` event (best-effort) after the workspace exists; this
 * function reacts to it and emails the owner the branded {@link trialWelcomeEmail}
 * so they know the cloud tier is unlocked and for how long.
 *
 * Decoupled from the core Effect service on purpose: the send runs in the
 * background (a Resend hiccup never affects workspace creation), and all the
 * delivery plumbing stays in the Inngest layer alongside the other email jobs.
 * A no-op when email (`AUTH_RESEND_KEY`) is unconfigured. `step.run` memoization
 * makes a retry safe (Resend itself is the only non-idempotent part).
 */

import { TRIAL_DURATION_DAYS } from "@gtmgrid/cloud";
import { emailEnabled, sendEmail, trialWelcomeEmail } from "@gtmgrid/email";
import { appLayer, WorkspaceRepo } from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import { inngest } from "../client";
import { onFailure } from "../on-failure";

// NB: `@gtmgrid/db/client` is imported LAZILY inside the handler — it throws when
// `DATABASE_URL` is unset, which would crash Next's build-time page-data
// collection for the Inngest serve route. Same pattern as send-trial-reminders.

export const sendWorkspaceWelcome = inngest.createFunction(
  { id: "send-workspace-welcome", triggers: [{ event: "workspace/created" }], onFailure },
  async ({ event, step }) => {
    if (!emailEnabled()) return { sent: 0, skipped: "email disabled" };
    const workspaceId =
      typeof event.data?.workspaceId === "string" ? event.data.workspaceId : null;
    if (workspaceId === null) return { sent: 0, skipped: "no workspaceId" };

    // Resolve the owner email + workspace name (the same profile Autumn uses).
    const profile = await step.run("load-customer", async () => {
      const { db } = await import("@gtmgrid/db/client");
      const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
      try {
        return await runtime.runPromise(
          Effect.flatMap(WorkspaceRepo, (r) => r.findCustomerData(workspaceId)),
        );
      } finally {
        await runtime.dispose();
      }
    });

    if (!profile.email) return { sent: 0, skipped: "no owner email" };

    const appUrl = process.env.SITE_URL ?? "https://www.gtmgrid.dev";
    await step.run(`welcome-${workspaceId}`, async () => {
      await sendEmail(
        trialWelcomeEmail({
          to: profile.email as string,
          workspaceName: profile.name ?? "your workspace",
          appUrl,
          trialDays: TRIAL_DURATION_DAYS,
        }),
      );
    });

    return { sent: 1 };
  },
);
