/**
 * Cron-driven lifecycle emails (#8, #9, #11, #14, #16, #17, #18).
 *
 * Four scheduled Inngest functions that scan Postgres for who to nudge and hand
 * each recipient to {@link sendLifecycleEmail} — the single guard that enforces
 * the kill-switch, category opt-outs, unsubscribe chrome, PostHog telemetry, and
 * (crucially) the unique (user, template, dedupeKey) idempotency claim.
 *
 * Because the guard's claim is what prevents duplicates, these scans do NOT need
 * disjoint windows: they scan generously and the guard drops anything already
 * sent. Every per-recipient send runs in its own `step.run` with a stable id, so
 * an Inngest retry re-executes the loop safely (memoized steps + guard dedupe).
 * Each function early-outs when email is unconfigured.
 *
 * The DB scans go through {@link LifecycleCronRepo} (packages/services); the
 * `@gtmgrid/db/client` import is LAZY inside each handler for the same reason as
 * the other Inngest jobs — it throws when `DATABASE_URL` is unset, which would
 * crash Next's build-time page-data collection for the serve route.
 */

import { emailEnabled } from "@gtmgrid/email";
import {
  columnsAreFunctionsEmail,
  creditWarningEmail,
  dormantEmail,
  firstTableEmail,
  inviteTeamEmail,
  trialWinbackEmail,
  weeklyDigestEmail,
} from "@gtmgrid/email/lifecycle";
import { appLayer, LifecycleCronRepo } from "@gtmgrid/services";
import { Context, Effect, ManagedRuntime } from "effect";
import { sendLifecycleEmail } from "../../lifecycle-email/send-guard";
import { inngest } from "../client";
import { onFailure } from "../on-failure";

const DAY_MS = 86_400_000;
/** Max rows a single scan bucket fans out over (a bad day can't go unbounded). */
const SCAN_LIMIT = 500;
/**
 * INVENTED: open seats to advertise in the invite-team nudge. There is no
 * seat-cap column in the schema (seats are enforced by the billing plan, which
 * the cron does not resolve), so we advertise a plausible small number.
 */
const INVITE_OPEN_SEATS = 4;

/** Deploy origin for CTA deep links (trailing slash trimmed). */
function siteOrigin(): string {
  return (process.env.SITE_URL ?? "https://www.gtmgrid.dev").replace(/\/+$/, "");
}

/**
 * Run one repo scan against a fresh ManagedRuntime (lazy DB import + dispose).
 * The scan result is plain JSON, so the caller memoizes it inside a `step.run`.
 */
async function scan<A, E>(
  op: (repo: Context.Tag.Service<typeof LifecycleCronRepo>) => Effect.Effect<A, E>,
): Promise<A> {
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    return await runtime.runPromise(Effect.flatMap(LifecycleCronRepo, op));
  } finally {
    await runtime.dispose();
  }
}

/** ISO-8601 week string, e.g. "2026-W27" — the weekly-digest dedupe key. */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // to the week's Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / DAY_MS -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Header-right label for the digest, e.g. "Mar 3 – Mar 9". */
const weekRangeLabel = (fromMs: number, toMs: number): string =>
  `${shortDate(fromMs)} – ${shortDate(toMs)}`;

// ---------------------------------------------------------------------------
// Decision helpers — pure, JSON-safe, no Effect/DB/env. The scan WINDOWS and
// DEDUPE KEYS below are the actual policy each cron enforces; extracting them
// lets the exact arithmetic (and its boundaries) be pinned offline. `nowMs` is
// injected so nothing here reads the clock.
// ---------------------------------------------------------------------------

/** A closed scan window `[fromMs, toMs]` handed to a repo range query. */
export interface ScanWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** #8 first-table: workspaces created 24h–7d ago (older than a day, younger than a week). */
export function firstTableWindow(nowMs: number): ScanWindow {
  return { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs - DAY_MS };
}

/** #9 columns-are-functions cutoff: created on/before this instant (≥48h old). */
export function columnsAreFunctionsCutoff(nowMs: number): number {
  return nowMs - 2 * DAY_MS;
}

/** #11 invite-team cutoff: created on/before this instant (≥3d old). */
export function inviteTeamCutoff(nowMs: number): number {
  return nowMs - 3 * DAY_MS;
}

/** #16 dormant: users whose lastActiveAt lands 7–8d ago (a one-day window). */
export function dormantWindow(nowMs: number): ScanWindow {
  return { fromMs: nowMs - 8 * DAY_MS, toMs: nowMs - 7 * DAY_MS };
}

/** #17 win-back @7d: trial ended 7–8d ago (a one-day window). */
export function winback7dWindow(nowMs: number): ScanWindow {
  return { fromMs: nowMs - 8 * DAY_MS, toMs: nowMs - 7 * DAY_MS };
}

/** #17 win-back @30d: trial ended 30–31d ago (a one-day window). */
export function winback30dWindow(nowMs: number): ScanWindow {
  return { fromMs: nowMs - 31 * DAY_MS, toMs: nowMs - 30 * DAY_MS };
}

/**
 * #18 crossing rule. A workspace crosses the credit-warning line at ≥80% of a
 * POSITIVE cap. A null or ≤0 cap never warns (an unmetered / zero-cap workspace
 * has no bar to fill); missing usage counts as 0. Boundary: `used === 0.8 *
 * limit` warns. NB: the SQL scan (`findCreditWarningCandidates`) guards a null
 * cap but NOT a zero cap — `coalesce(used,0) >= 0.8 * 0` is `>= 0`, always true —
 * so a `limit = 0` workspace would slip through and get a spurious "0% used"
 * warning; the handler now re-checks with this helper to close that hole.
 */
export function creditWarningCrosses(
  used: number | null,
  limit: number | null,
): boolean {
  if (limit === null || limit <= 0) return false;
  return (used ?? 0) >= 0.8 * limit;
}

/** #18 usage bar: whole-percent used, clamped 0–100; a null/≤0 cap reads 0%. */
export function creditUsagePercent(
  used: number | null,
  limit: number | null,
): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(100, Math.round(((used ?? 0) / limit) * 100));
}

/**
 * #14 digest gate. A digest only makes sense for a workspace with activity in
 * the window; a zero-run target is skipped (dormancy owns the quiet ones). The
 * scan already only returns workspaces with ≥1 ran cell, so this makes that
 * invariant explicit and defends the copy from a "0 runs this week" digest.
 */
export function digestHasActivity(target: {
  readonly runsCompleted: number;
}): boolean {
  return target.runsCompleted > 0;
}

/** Constant dedupe key for the "send this once, ever" activation nudges (#8/#9/#11). */
export const ONCE = "once";

/** YYYY-MM billing-month dedupe key (#18 re-warns at most once per month). */
export function billingMonthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** #16 dedupe key: the UTC date of the user's last heartbeat, so a NEW dormancy spell re-fires. */
export function dormantDedupeKey(lastActiveAtMs: number): string {
  return new Date(lastActiveAtMs).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// #8 / #9 / #11 / #18 — daily activation-stall + credit-warning sweep.
// ---------------------------------------------------------------------------

export const lifecycleActivationStall = inngest.createFunction(
  {
    id: "lifecycle-activation-stall",
    triggers: [{ cron: "0 10 * * *" }],
    onFailure,
  },
  async ({ step }) => {
    if (!emailEnabled()) return { skipped: "email disabled" };
    const origin = siteOrigin();
    const now = Date.now();

    // #8 — young workspaces (24h–7d old) with no tables yet.
    const firstTableW = firstTableWindow(now);
    const firstTable = await step.run("scan-first-table", () =>
      scan((r) =>
        r.findFirstTableCandidates(firstTableW.fromMs, firstTableW.toMs, SCAN_LIMIT),
      ),
    );
    for (const t of firstTable) {
      await step.run(`first-table-${t.workspaceId}`, () =>
        sendLifecycleEmail({
          userId: t.ownerId,
          workspaceId: t.workspaceId,
          template: "first-table",
          category: "activation",
          dedupeKey: ONCE,
          build: ({ to, links }) => firstTableEmail({ to, ctaUrl: origin, links }),
        }),
      );
    }

    // #9 — ≥48h old, has a table, but no function column yet.
    const columnsFn = await step.run("scan-columns-functions", () =>
      scan((r) =>
        r.findColumnsAreFunctionsCandidates(columnsAreFunctionsCutoff(now), SCAN_LIMIT),
      ),
    );
    for (const t of columnsFn) {
      await step.run(`columns-fn-${t.workspaceId}`, () =>
        sendLifecycleEmail({
          userId: t.ownerId,
          workspaceId: t.workspaceId,
          template: "columns-are-functions",
          category: "activation",
          dedupeKey: ONCE,
          build: ({ to, links }) =>
            columnsAreFunctionsEmail({
              to,
              table: t.firstTableName,
              ctaUrl: origin,
              links,
            }),
        }),
      );
    }

    // #11 — ≥3d old, activated (a run happened), still a single-member workspace.
    const inviteTeam = await step.run("scan-invite-team", () =>
      scan((r) => r.findInviteTeamCandidates(inviteTeamCutoff(now), SCAN_LIMIT)),
    );
    for (const t of inviteTeam) {
      await step.run(`invite-team-${t.workspaceId}`, () =>
        sendLifecycleEmail({
          userId: t.ownerId,
          workspaceId: t.workspaceId,
          template: "invite-team",
          category: "activation",
          dedupeKey: ONCE,
          build: ({ to, links }) =>
            inviteTeamEmail({
              to,
              workspace: t.workspaceName,
              seatsOpen: INVITE_OPEN_SEATS,
              ctaUrl: origin,
              links,
            }),
        }),
      );
    }

    // #18 — workspaces at/over 80% of their cloud-action cap. Re-warns each
    // billing month via a YYYY-MM dedupe key.
    const creditWarning = await step.run("scan-credit-warning", () =>
      scan((r) => r.findCreditWarningCandidates(SCAN_LIMIT)),
    );
    const billingMonth = billingMonthKey(now); // YYYY-MM
    // INVENTED renewal label: first of next UTC month (no billing-period-end column).
    const resetsAt = shortDate(
      Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1),
    );
    for (const t of creditWarning) {
      // Defence in depth: the scan's SQL lets a zero cap through (0.8*0 = 0), so
      // re-check the crossing here and never warn an unmetered workspace.
      if (!creditWarningCrosses(t.used, t.limit)) continue;
      const percent = creditUsagePercent(t.used, t.limit);
      await step.run(`credit-warning-${t.workspaceId}`, () =>
        sendLifecycleEmail({
          userId: t.ownerId,
          workspaceId: t.workspaceId,
          template: "credit-warning",
          category: "status",
          dedupeKey: billingMonth,
          build: ({ to, links }) =>
            creditWarningEmail({
              to,
              used: t.used,
              limit: t.limit,
              percent,
              resetsAt,
              manageUrl: origin,
              links,
            }),
        }),
      );
    }

    return {
      firstTable: firstTable.length,
      columnsFn: columnsFn.length,
      inviteTeam: inviteTeam.length,
      creditWarning: creditWarning.length,
    };
  },
);

// ---------------------------------------------------------------------------
// #14 — weekly workspace digest (Mondays 09:00 UTC). Every member of a workspace
// with any activity in the last 7 days gets one digest.
// ---------------------------------------------------------------------------

export const lifecycleWeeklyDigest = inngest.createFunction(
  { id: "lifecycle-weekly-digest", triggers: [{ cron: "0 9 * * 1" }], onFailure },
  async ({ step }) => {
    if (!emailEnabled()) return { skipped: "email disabled" };
    const origin = siteOrigin();
    const now = Date.now();
    const fromMs = now - 7 * DAY_MS;
    const week = isoWeek(now);
    const weekRange = weekRangeLabel(fromMs, now);

    const targets = await step.run("scan-weekly-digest", () =>
      scan((r) => r.findWeeklyDigestTargets(fromMs, now, SCAN_LIMIT)),
    );

    let sends = 0;
    for (const w of targets) {
      // Zero-activity workspaces are dormancy's job, not the digest's; the scan
      // already excludes them, this keeps the rule visible at the send site.
      if (!digestHasActivity(w)) continue;
      for (const userId of w.memberUserIds) {
        sends += 1;
        await step.run(`digest-${w.workspaceId}-${userId}`, () =>
          sendLifecycleEmail({
            userId,
            workspaceId: w.workspaceId,
            template: "weekly-digest",
            category: "digest",
            dedupeKey: week,
            build: ({ to, links }) =>
              weeklyDigestEmail({
                to,
                workspace: w.workspaceName,
                weekRange,
                stats: {
                  rowsEnriched: w.rowsEnriched,
                  runsCompleted: w.runsCompleted,
                  creditsUsed: w.creditsUsed,
                  teammatesActive: w.teammatesActive,
                },
                topTables: w.topTables,
                openUrl: origin,
                links,
              }),
          }),
        );
      }
    }

    return { workspaces: targets.length, recipients: sends };
  },
);

// ---------------------------------------------------------------------------
// #16 — dormant re-engagement (daily 10:30 UTC). Users who went quiet 7–8 days
// ago (one-day window → one fire per dormancy spell; the lastActiveAt date is the
// dedupe key, so a NEW spell re-fires).
// ---------------------------------------------------------------------------

export const lifecycleDormant = inngest.createFunction(
  { id: "lifecycle-dormant", triggers: [{ cron: "30 10 * * *" }], onFailure },
  async ({ step }) => {
    if (!emailEnabled()) return { skipped: "email disabled" };
    const origin = siteOrigin();
    const now = Date.now();

    const dormantW = dormantWindow(now);
    const candidates = await step.run("scan-dormant", () =>
      scan((r) =>
        r.findDormantCandidates(dormantW.fromMs, dormantW.toMs, SCAN_LIMIT),
      ),
    );

    for (const d of candidates) {
      await step.run(`dormant-${d.userId}`, () =>
        sendLifecycleEmail({
          userId: d.userId,
          template: "dormant",
          category: "activation",
          dedupeKey: dormantDedupeKey(d.lastActiveAtMs),
          build: ({ to, links }) =>
            dormantEmail({
              to,
              table: d.table,
              cellsChanged: d.cellsChanged,
              newRows: d.newRows,
              columnsRecomputed: d.columnsRecomputed,
              rowsNeedRerun: d.rowsNeedRerun,
              jumpUrl: origin,
              links,
            }),
        }),
      );
    }

    return { dormant: candidates.length };
  },
);

// ---------------------------------------------------------------------------
// #17 — trial win-back (daily 15:00 UTC). Workspaces on no paid plan whose trial
// ended ~7 days ago and, separately, ~30 days ago.
// ---------------------------------------------------------------------------

export const lifecycleTrialWinback = inngest.createFunction(
  { id: "lifecycle-trial-winback", triggers: [{ cron: "0 15 * * *" }], onFailure },
  async ({ step }) => {
    if (!emailEnabled()) return { skipped: "email disabled" };
    const origin = siteOrigin();
    const now = Date.now();

    const milestones = [
      { tag: "winback-7d" as const, ...winback7dWindow(now) },
      { tag: "winback-30d" as const, ...winback30dWindow(now) },
    ];

    let sends = 0;
    for (const m of milestones) {
      const targets = await step.run(`scan-${m.tag}`, () =>
        scan((r) => r.findTrialWinbackCandidates(m.fromMs, m.toMs, SCAN_LIMIT)),
      );
      for (const t of targets) {
        sends += 1;
        await step.run(`${m.tag}-${t.workspaceId}`, () =>
          sendLifecycleEmail({
            userId: t.ownerId,
            workspaceId: t.workspaceId,
            template: "trial-winback",
            category: "activation",
            dedupeKey: m.tag,
            build: ({ to, links }) =>
              trialWinbackEmail({
                to,
                tableCount: t.tableCount,
                rowsEnriched: t.rowsEnriched,
                columnCount: t.columnCount,
                reactivateUrl: origin,
                links,
              }),
          }),
        );
      }
    }

    return { sent: sends };
  },
);
