/**
 * Event-driven lifecycle emails (#19 #20 #17 #10 #12 #13).
 *
 * These are the lifecycle sends that react to a DISCRETE thing happening — an
 * invite accepted, a subscription started, a charge declined, a function run
 * with no key, signals landing — as opposed to the scheduled/cron scans (trial
 * reminders, weekly digest, dormancy) which live in their own files. The
 * emission side is already wired elsewhere; this file only CONSUMES the events.
 *
 * Every send goes through {@link sendLifecycleEmail} (../../lifecycle-email/
 * send-guard), the single gate that owns the kill-switch, category opt-outs,
 * once-only idempotency (unique user+template+dedupeKey), the compliance
 * unsubscribe chrome and PostHog telemetry. We hand it a BUILDER (not a rendered
 * email) so it can inject the per-user unsubscribe link; the builder maps the
 * guard's `links`/`to` straight onto the template props. The guard resolves the
 * recipient by `userId`, so each function only needs to compute WHICH user + the
 * copy fields the template can't derive itself.
 *
 * Conventions shared with the other Inngest jobs here:
 *   - `@gtmgrid/db/client` is imported LAZILY inside the handler (never at module
 *     top) — it throws when DATABASE_URL is unset, which would crash Next's
 *     build-time page-data collection for the Inngest serve route.
 *   - Every send / DB read / re-check runs inside a `step.run` with a STABLE id,
 *     so an Inngest retry memoizes completed steps and never double-sends.
 *   - Step results are plain JSON (the guard's {@link LifecycleSendResult} and
 *     small projections), never Effect/Option/Date values.
 *
 * NB: registration in the Inngest serve route (route.ts) is done separately by
 * the lead — this file only defines and exports the functions.
 */

import { planName } from "@gtmgrid/cloud";
import { emailEnabled } from "@gtmgrid/email";
import {
  connectAiKeyEmail,
  paymentFailedEmail,
  runFinishedEmail,
  signalsWaitingEmail,
  subscriptionConfirmedEmail,
  teammateJoinedEmail,
} from "@gtmgrid/email/lifecycle";
import {
  appLayer,
  type AppServices,
  BillingService,
  CredentialRepo,
  LifecycleEmailRepo,
  WorkspaceRepo,
} from "@gtmgrid/services";
import { Effect, ManagedRuntime, Option } from "effect";
import { appOpenUrl } from "../../lifecycle-email/app-links";
import { sendLifecycleEmail } from "../../lifecycle-email/send-guard";
import { inngest } from "../client";
import { onFailure } from "../on-failure";

/** Absolute origin for CTA / deep-link URLs (marketing fallback in dev). */
const site = (): string => process.env.SITE_URL ?? "https://www.gtmgrid.dev";

/** Current billing window ("2026-07") for the monthly dedupe keys. */
const monthKey = (): string => new Date().toISOString().slice(0, 7);

/** Owner is considered "in the app" if seen within this window (skips presence-gated sends). */
export const PRESENCE_MS = 5 * 60 * 1000;

/** Narrow a loosely-typed event field to a non-empty string, else null. */
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// ---------------------------------------------------------------------------
// Decision helpers — pure, JSON-safe, no Effect/DB/env. Extracted from the
// handlers below so the branch/threshold logic can be pinned offline. Each
// handler resolves its inputs (recipient, creds, plan) and then calls these;
// the helpers never look at `process.env` or the clock themselves.
// ---------------------------------------------------------------------------

/**
 * Coerce a heartbeat to epoch-ms. `lastActiveAt` arrives as a `Date` inside the
 * Effect read, but a `step.run` result is serialized to JSON — a `Date` becomes
 * an ISO string on the way back — so this accepts `Date | string | number` and
 * returns null for absent/unparseable values (which the caller reads as "never
 * seen", i.e. NOT present).
 */
export function heartbeatMs(
  lastActiveAt: Date | string | number | null | undefined,
): number | null {
  if (lastActiveAt === null || lastActiveAt === undefined) return null;
  const ms =
    lastActiveAt instanceof Date
      ? lastActiveAt.getTime()
      : typeof lastActiveAt === "number"
        ? lastActiveAt
        : Date.parse(lastActiveAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Presence gate for #12/#13. The owner is "present" — so we send NOTHING, they
 * will see the signals live — only when a heartbeat exists AND is strictly
 * newer than {@link PRESENCE_MS}. A missing heartbeat (never heartbeated) is NOT
 * present ⇒ the email sends. Exactly at the boundary (`nowMs - lastActive ===
 * PRESENCE_MS`) is NOT present ⇒ the email sends.
 */
export function isPresent(
  lastActiveAt: Date | string | number | null | undefined,
  nowMs: number,
): boolean {
  const ms = heartbeatMs(lastActiveAt);
  if (ms === null) return false;
  return nowMs - ms < PRESENCE_MS;
}

/** Rows-added count at/above which #12 "run finished" wins over #13 "signals waiting". */
export const DEFAULT_RUN_EMAIL_ROW_THRESHOLD = 25;

/**
 * Resolve `RUN_EMAIL_ROW_THRESHOLD`. Unset OR non-numeric ("abc") falls back to
 * {@link DEFAULT_RUN_EMAIL_ROW_THRESHOLD}; a numeric string ("10") is used as-is
 * (including "0"). Guards against the old `Number(env ?? 25)` shape, where a
 * garbage value produced `NaN` and silently forced every landing down the
 * "signals waiting" path (`added >= NaN` is always false).
 */
export function runEmailRowThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUN_EMAIL_ROW_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RUN_EMAIL_ROW_THRESHOLD;
}

export interface SignalsRoute {
  readonly template: "run-finished" | "signals-waiting";
  readonly dedupeKey: string;
}

/**
 * #12 vs #13 routing + dedupe key in one place. `added >= threshold` →
 * "run-finished", deduped PER LANDING (`${bindingId}:${landedAt}`); below it →
 * "signals-waiting", deduped per binding per UTC DAY (`${bindingId}:${YYYY-MM-DD
 * of landedAt}`) so a chatty search nudges at most once a day. The boundary
 * (`added === threshold`) routes to "run-finished".
 */
export function routeSignals(args: {
  readonly bindingId: string;
  readonly added: number;
  readonly threshold: number;
  readonly landedAt: string | number;
}): SignalsRoute {
  const { bindingId, added, threshold, landedAt } = args;
  // BOTH templates dedupe per binding per DAY: hourly signal syncs can land
  // qualifying batches repeatedly, and one reward-loop email a day per binding
  // is the volume ceiling (a second same-day landing is deliberately dropped).
  const dateKey = new Date(landedAt).toISOString().slice(0, 10);
  if (added >= threshold) {
    return { template: "run-finished", dedupeKey: `${bindingId}:${dateKey}` };
  }
  return { template: "signals-waiting", dedupeKey: `${bindingId}:${dateKey}` };
}

/**
 * #17 dunning continuation. Each later send only fires while the re-synced plan
 * id is non-null; a null id means the sub is canceled/lapsed (entitlements are
 * already locked) so we STOP. This is a null check, NOT truthiness — an empty
 * string is treated as a live (non-null) plan id and dunning continues.
 */
export function dunningContinues(planId: string | null): boolean {
  return planId !== null;
}

/**
 * #10 skip predicate. A workspace already has an AI credential when any row's
 * `extensionId` begins with the `ai` connector id ("ai"). Prefix match, so
 * "ai-anthropic" counts; an empty list or only non-"ai" ids (e.g. "slack") does
 * not. NB: this is a raw `startsWith("ai")`, so a hypothetical future connector
 * id like "airtable" would also match — safe today (the only "ai*" connector id
 * is "ai") but a footgun if such an id is ever introduced.
 */
export function hasAiCredential(
  creds: ReadonlyArray<{ readonly extensionId: string }>,
): boolean {
  return creds.some((c) => c.extensionId.startsWith("ai"));
}

/**
 * Run an Effect against a fresh per-invocation runtime, disposing it after.
 * Mirrors the `send-workspace-welcome` pattern (lazy db import, ManagedRuntime
 * over `appLayer`) so every read here shares one wiring point.
 */
async function runProgram<A, E>(
  program: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    return await runtime.runPromise(program);
  } finally {
    await runtime.dispose();
  }
}

/** A workspace's owner id + display name, or null when the workspace is gone. */
const ownerOf = (workspaceId: string) =>
  Effect.flatMap(WorkspaceRepo, (r) =>
    Effect.map(r.findById(workspaceId), (ws) =>
      Option.match(ws, {
        onNone: () => null,
        onSome: (w) => ({ ownerId: w.ownerId, name: w.name }),
      }),
    ),
  );

/**
 * #19 — a teammate accepted an invite → email the INVITER.
 *
 * Recipient is the inviter (`invitedBy`); the joiner's name/email is copy for
 * the member card, resolved separately. Transactional, and deduped on the joiner
 * id so the inviter is told about a given teammate at most once, ever.
 */
export const lifecycleTeammateJoined = inngest.createFunction(
  {
    id: "lifecycle-teammate-joined",
    triggers: [{ event: "workspace/member.joined" }],
    retries: 3,
    onFailure,
  },
  async ({ event, step }) => {
    if (!emailEnabled()) return { sent: false, skipped: "email disabled" };
    const workspaceId = str(event.data?.workspaceId);
    const joinedUserId = str(event.data?.joinedUserId);
    const invitedBy = str(event.data?.invitedBy);
    if (!workspaceId || !joinedUserId || !invitedBy) {
      return { sent: false, skipped: "missing event data" };
    }

    // Copy fields the template needs but the guard's recipient lookup can't give:
    // the joiner's identity + the workspace name.
    const ctx = await step.run("load", () =>
      runProgram(
        Effect.gen(function* () {
          const owner = yield* ownerOf(workspaceId);
          const joiner = yield* Effect.flatMap(LifecycleEmailRepo, (r) =>
            r.getRecipient(joinedUserId),
          );
          return {
            workspace: owner?.name ?? null,
            teammateName: joiner?.name ?? null,
            teammateEmail: joiner?.email ?? null,
          };
        }),
      ),
    );

    return await step.run("send", () =>
      sendLifecycleEmail({
        userId: invitedBy,
        workspaceId,
        template: "teammate-joined",
        category: "transactional",
        dedupeKey: joinedUserId,
        build: async ({ to, links }) =>
          teammateJoinedEmail({
            to,
            teammateName: ctx.teammateName ?? ctx.teammateEmail ?? "A teammate",
            teammateEmail: ctx.teammateEmail ?? undefined,
            workspace: ctx.workspace ?? "your workspace",
            openWorkspaceUrl: appOpenUrl({ kind: "members" }),
            links,
          }),
      }),
    );
  },
);

/**
 * #20 — a first paid subscription started → email the workspace OWNER a receipt.
 *
 * Transactional. Deduped on `planId:YYYY-MM` so a re-emitted webhook in the same
 * month is a no-op, while a genuine plan change or a later month can still send.
 */
export const lifecycleSubscriptionConfirmed = inngest.createFunction(
  {
    id: "lifecycle-subscription-confirmed",
    triggers: [{ event: "billing/subscription.started" }],
    retries: 3,
    onFailure,
  },
  async ({ event, step }) => {
    if (!emailEnabled()) return { sent: false, skipped: "email disabled" };
    const workspaceId = str(event.data?.workspaceId);
    const planId = str(event.data?.planId);
    if (!workspaceId || !planId) {
      return { sent: false, skipped: "missing event data" };
    }

    const owner = await step.run("load-owner", () =>
      runProgram(ownerOf(workspaceId)),
    );
    if (!owner) return { sent: false, skipped: "no such workspace" };

    return await step.run("send", () =>
      sendLifecycleEmail({
        userId: owner.ownerId,
        workspaceId,
        template: "subscription-confirmed",
        category: "transactional",
        dedupeKey: `${planId}:${monthKey()}`,
        build: async ({ to, links }) =>
          subscriptionConfirmedEmail({
            to,
            plan: planName(planId),
            workspace: owner.name ?? "your workspace",
            // INVENTED — the event carries no billing detail. seats/amount are
            // required props; a receipt without a line total reads oddly, so the
            // real figures should be threaded onto the event (or looked up from
            // Autumn) before this ships. Placeholders keep the template valid.
            seats: 1,
            amount: "—",
            billingUrl: appOpenUrl({ kind: "billing" }),
            links,
          }),
      }),
    );
  },
);

/**
 * #17 — a charge was declined → dunning email to the OWNER on Day 0 → 3 → 7.
 *
 * A single durable function walks the escalation with `step.sleep`. Before each
 * later send it re-checks the live plan via `BillingService.syncPlanFromWebhook`:
 * once the sub is canceled/lapsed (`plan.id === null`) the entitlement layer
 * already locks cloud access, so there is nothing left to save and we STOP
 * (no "please pay" mail to someone who has already churned). The month window is
 * frozen at Day 0 so all three dedupe keys share one window even when the 7-day
 * escalation crosses a month boundary. Transactional.
 */
export const lifecyclePaymentFailed = inngest.createFunction(
  {
    id: "lifecycle-payment-failed",
    triggers: [{ event: "billing/payment.failed" }],
    retries: 3,
    onFailure,
  },
  async ({ event, step }) => {
    if (!emailEnabled()) return { sent: false, skipped: "email disabled" };
    const workspaceId = str(event.data?.workspaceId);
    if (!workspaceId) return { sent: false, skipped: "missing event data" };

    const owner = await step.run("load-owner", () =>
      runProgram(ownerOf(workspaceId)),
    );
    if (!owner) return { sent: false, skipped: "no such workspace" };

    const month = monthKey();
    const workspace = owner.name ?? "your workspace";
    const updatePaymentUrl = appOpenUrl({ kind: "billing" });

    const sendAttempt = (attempt: 0 | 3 | 7) =>
      sendLifecycleEmail({
        userId: owner.ownerId,
        workspaceId,
        template: "payment-failed",
        category: "transactional",
        dedupeKey: `${month}:day${attempt}`,
        build: async ({ to, links }) =>
          paymentFailedEmail({
            to,
            workspace,
            // INVENTED — the declined card's last four are not on the event; the
            // template shows "•••• 0000" until the real value is threaded through.
            cardLast4: "0000",
            attempt,
            updatePaymentUrl,
            links,
          }),
      });

    // Re-read the live plan id; null => canceled/lapsed (entitlements locked).
    const stillActive = () =>
      runProgram(
        Effect.map(
          Effect.flatMap(BillingService, (s) => s.syncPlanFromWebhook(workspaceId)),
          (p) => dunningContinues(p.id),
        ),
      );

    await step.run("send-day0", () => sendAttempt(0));

    await step.sleep("dunning-3d", "3d");
    if (!(await step.run("recheck-day3", stillActive))) {
      return { sent: true, stopped: "canceled-before-day3" };
    }
    await step.run("send-day3", () => sendAttempt(3));

    await step.sleep("dunning-7d", "4d");
    if (!(await step.run("recheck-day7", stillActive))) {
      return { sent: true, stopped: "canceled-before-day7" };
    }
    await step.run("send-day7", () => sendAttempt(7));

    return { sent: true };
  },
);

/**
 * #10 — a function ran with no AI credential → nudge the OWNER to connect a key.
 *
 * Skips when the workspace ALREADY has an AI credential (any `credentials` row
 * whose `extensionId` starts with "ai" — the `ai` connector's id), so a race
 * where the key lands between the failure and this job never nags. Activation
 * category (opt-outable) and deduped on the literal "once" — one nudge per user.
 */
export const lifecycleCredentialMissing = inngest.createFunction(
  {
    id: "lifecycle-credential-missing",
    triggers: [{ event: "lifecycle/credential.missing" }],
    retries: 3,
    onFailure,
  },
  async ({ event, step }) => {
    if (!emailEnabled()) return { sent: false, skipped: "email disabled" };
    const workspaceId = str(event.data?.workspaceId);
    if (!workspaceId) return { sent: false, skipped: "missing event data" };

    const ctx = await step.run("load", () =>
      runProgram(
        Effect.gen(function* () {
          const owner = yield* ownerOf(workspaceId);
          const creds = yield* Effect.flatMap(CredentialRepo, (r) =>
            r.listMetadata(workspaceId),
          );
          return {
            ownerId: owner?.ownerId ?? null,
            hasAiKey: hasAiCredential(creds),
          };
        }),
      ),
    );
    const ownerId = ctx.ownerId;
    if (!ownerId) return { sent: false, skipped: "no such workspace" };
    if (ctx.hasAiKey) {
      return { sent: false, skipped: "ai credential already connected" };
    }

    return await step.run("send", () =>
      sendLifecycleEmail({
        userId: ownerId,
        workspaceId,
        template: "connect-ai-key",
        category: "activation",
        dedupeKey: "once",
        build: async ({ to, firstName, links }) =>
          connectAiKeyEmail({
            to,
            firstName: firstName ?? undefined,
            ctaUrl: appOpenUrl({ kind: "ai-providers" }),
            links,
          }),
      }),
    );
  },
);

/**
 * #12 / #13 — new Social Signals landed while the app was closed → email the OWNER.
 *
 * PRESENCE GATE: if the owner's `last_active_at` is within the last 5 minutes
 * they're already in the app, so we send nothing (they'll see it live). Above the
 * `RUN_EMAIL_ROW_THRESHOLD` (default 25) rows it's a "run finished" summary
 * (#12); below it, a lighter "signals waiting" nudge (#13). Status category. The
 * run-finished send dedupes per landing (`bindingId:landedAt`); the waiting nudge
 * dedupes per binding per day so a chatty search sends at most one nudge a day.
 */
export const lifecycleSignalsLanded = inngest.createFunction(
  {
    id: "lifecycle-signals-landed",
    triggers: [{ event: "lifecycle/signals.landed" }],
    retries: 3,
    onFailure,
  },
  async ({ event, step }) => {
    if (!emailEnabled()) return { sent: false, skipped: "email disabled" };
    const workspaceId = str(event.data?.workspaceId);
    const bindingId = str(event.data?.bindingId);
    const added = Number(event.data?.added);
    if (!workspaceId || !bindingId || !Number.isFinite(added) || added <= 0) {
      return { sent: false, skipped: "missing event data" };
    }
    const tableId = str(event.data?.tableId);
    const landedAtRaw = event.data?.landedAt;
    const landedAt =
      typeof landedAtRaw === "string" || typeof landedAtRaw === "number"
        ? landedAtRaw
        : Date.now();

    // Presence gate: owner id + last heartbeat, in one read.
    const ctx = await step.run("load-owner", () =>
      runProgram(
        Effect.gen(function* () {
          const owner = yield* ownerOf(workspaceId);
          if (owner === null) return null;
          const recipient = yield* Effect.flatMap(LifecycleEmailRepo, (r) =>
            r.getRecipient(owner.ownerId),
          );
          return {
            ownerId: owner.ownerId,
            lastActiveMs: recipient?.lastActiveAt
              ? recipient.lastActiveAt.getTime()
              : null,
          };
        }),
      ),
    );
    if (ctx === null) return { sent: false, skipped: "no such workspace" };
    if (isPresent(ctx.lastActiveMs, Date.now())) {
      return { sent: false, skipped: "owner active in-app" };
    }

    const ownerId = ctx.ownerId;
    const threshold = runEmailRowThreshold(process.env.RUN_EMAIL_ROW_THRESHOLD);
    const viewUrl = tableId
      ? appOpenUrl({ kind: "table", tableId, workspaceId })
      : appOpenUrl();
    const route = routeSignals({ bindingId, added, threshold, landedAt });

    if (route.template === "run-finished") {
      return await step.run("send-run-finished", () =>
        sendLifecycleEmail({
          userId: ownerId,
          workspaceId,
          template: "run-finished",
          category: "status",
          dedupeKey: route.dedupeKey,
          build: async ({ to, links }) =>
            runFinishedEmail({
              to,
              doneCount: added,
              errorCount: 0,
              // INVENTED — the event has the count but not the run's shape. Table
              // name / duration / credits aren't carried, so we label it with the
              // Social Signals surface and leave duration/credits blank/zero.
              table: "Social Signals",
              fn: "trigify.signals",
              column: "Social Signals",
              duration: "—",
              creditsUsed: 0,
              sampleRows: [],
              viewUrl,
              links,
            }),
        }),
      );
    }

    return await step.run("send-signals-waiting", () =>
      sendLifecycleEmail({
        userId: ownerId,
        workspaceId,
        template: "signals-waiting",
        category: "status",
        dedupeKey: route.dedupeKey,
        build: async ({ to, links }) =>
          signalsWaitingEmail({
            to,
            n: added,
            // INVENTED — the matched saved-search name and per-signal scores
            // aren't on the event, so the preview list is empty and the search is
            // labelled generically; thread the real search + rows through to fill.
            search: "Social Signals",
            hotCount: 0,
            signals: [],
            viewUrl,
            links,
          }),
      }),
    );
  },
);
