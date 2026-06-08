/**
 * Scheduled trial-ending reminders.
 *
 * Runs daily and emails the owner of each workspace whose Team trial is about to
 * end, so they add a card BEFORE the cloud tier hard-locks. Two milestones:
 *   - "soon"  — the trial ends in ~2 days, and
 *   - "last"  — the trial ends within ~24h.
 *
 * Idempotency without a DB marker: each milestone uses a DISJOINT, one-day-wide
 * scan window, and the job runs daily, so a given trial falls into each window on
 * exactly one run (no duplicate emails). Per-email `step.run` memoization makes a
 * mid-run retry safe. A no-op when email (`AUTH_RESEND_KEY`) is unconfigured.
 */

import { emailEnabled, sendEmail, trialEndingEmail } from "@gtmgrid/email";
import { appLayer, WorkspaceRepo } from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import { inngest } from "../client";

// NB: `@gtmgrid/db/client` is imported LAZILY inside the handler (not at module
// top). It throws "DATABASE_URL is not set" on import, which would crash Next's
// build-time page-data collection for the Inngest serve route. Same pattern as
// the tRPC context.

const DAY_MS = 86_400_000;

interface DueReminder {
  readonly id: string;
  readonly name: string;
  readonly ownerEmail: string;
  readonly daysLeft: number;
  readonly bucket: "soon" | "last";
}

export const sendTrialReminders = inngest.createFunction(
  // Daily at 14:00 UTC.
  { id: "send-trial-reminders", triggers: [{ cron: "0 14 * * *" }] },
  async ({ step }) => {
    if (!emailEnabled()) return { sent: 0, skipped: "email disabled" };

    // Scan both disjoint windows in one step; returns the JSON-serializable list.
    const due = await step.run("scan-trials", async (): Promise<DueReminder[]> => {
      const { db } = await import("@gtmgrid/db/client");
      const now = Date.now();
      const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
      try {
        const windows = [
          { bucket: "last" as const, from: now + 1, to: now + DAY_MS },
          { bucket: "soon" as const, from: now + DAY_MS + 1, to: now + 2 * DAY_MS },
        ];
        const out: DueReminder[] = [];
        for (const w of windows) {
          const trials = await runtime.runPromise(
            Effect.flatMap(WorkspaceRepo, (r) =>
              r.findTrialsEndingBetween(w.from, w.to),
            ),
          );
          for (const t of trials) {
            out.push({
              id: t.id,
              name: t.name,
              ownerEmail: t.ownerEmail,
              daysLeft: Math.max(0, Math.ceil((t.trialEndsAt - now) / DAY_MS)),
              bucket: w.bucket,
            });
          }
        }
        return out;
      } finally {
        await runtime.dispose();
      }
    });

    const appUrl = process.env.SITE_URL ?? "https://www.gtmgrid.dev";
    for (const r of due) {
      // Per-(workspace, milestone) step id → memoized, so a retry never double-sends.
      await step.run(`remind-${r.id}-${r.bucket}`, async () => {
        await sendEmail(
          trialEndingEmail({
            to: r.ownerEmail,
            workspaceName: r.name,
            daysLeft: r.daysLeft,
            appUrl,
          }),
        );
      });
    }

    return { sent: due.length };
  },
);
