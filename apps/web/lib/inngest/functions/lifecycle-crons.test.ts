/**
 * The DECISION LOGIC of the cron-driven lifecycle emails (#8 #9 #11 #14 #16 #17
 * #18), condition by condition — OFFLINE. No Inngest, no Effect, no DB: the scan
 * WINDOWS, the credit-warning CROSSING rule, and every DEDUPE KEY are lifted
 * into pure helpers and pinned here. These are the policy each daily/weekly job
 * enforces — get the arithmetic or a dedupe key wrong and you either miss a
 * cohort entirely or re-send the same mail every run.
 *
 * The ISO-week block also serves as a regression pin: the digest key is real
 * ISO-8601 (verified across several year boundaries), so a "naive" rewrite that
 * broke the 2025→2026 / 2020↔2021 rollovers would fail here.
 */

import { describe, expect, it } from "vitest";
import {
  billingMonthKey,
  columnsAreFunctionsCutoff,
  creditUsagePercent,
  creditWarningCrosses,
  digestHasActivity,
  dormantDedupeKey,
  dormantWindow,
  firstTableWindow,
  inviteTeamCutoff,
  isoWeek,
  ONCE,
  winback30dWindow,
  winback7dWindow,
} from "./lifecycle-crons";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0); // 2026-07-04T12:00:00Z

describe("scan windows — the cohort each sweep selects (exact bounds, from < to)", () => {
  it("#8 first-table: created 24h–7d ago", () => {
    expect(firstTableWindow(NOW)).toEqual({
      fromMs: NOW - 7 * DAY,
      toMs: NOW - DAY,
    });
  });

  it("#8 first-table window spans six days and runs forwards (from < to)", () => {
    const w = firstTableWindow(NOW);
    expect(w.fromMs).toBeLessThan(w.toMs);
    expect(w.toMs - w.fromMs).toBe(6 * DAY);
  });

  it("#9 columns-are-functions: cutoff is 48h ago (created on/before)", () => {
    expect(columnsAreFunctionsCutoff(NOW)).toBe(NOW - 2 * DAY);
  });

  it("#11 invite-team: cutoff is 3d ago (created on/before)", () => {
    expect(inviteTeamCutoff(NOW)).toBe(NOW - 3 * DAY);
  });

  it("#16 dormant: lastActiveAt 7–8d ago, a one-day window (from < to)", () => {
    const w = dormantWindow(NOW);
    expect(w).toEqual({ fromMs: NOW - 8 * DAY, toMs: NOW - 7 * DAY });
    expect(w.fromMs).toBeLessThan(w.toMs);
    expect(w.toMs - w.fromMs).toBe(DAY);
  });

  it("#17 win-back @7d: trial ended 7–8d ago, a one-day window (from < to)", () => {
    const w = winback7dWindow(NOW);
    expect(w).toEqual({ fromMs: NOW - 8 * DAY, toMs: NOW - 7 * DAY });
    expect(w.fromMs).toBeLessThan(w.toMs);
    expect(w.toMs - w.fromMs).toBe(DAY);
  });

  it("#17 win-back @30d: trial ended 30–31d ago, a one-day window (from < to)", () => {
    const w = winback30dWindow(NOW);
    expect(w).toEqual({ fromMs: NOW - 31 * DAY, toMs: NOW - 30 * DAY });
    expect(w.fromMs).toBeLessThan(w.toMs);
    expect(w.toMs - w.fromMs).toBe(DAY);
  });

  it("the two win-back windows do not overlap (7d cohort is strictly newer than 30d)", () => {
    expect(winback30dWindow(NOW).toMs).toBeLessThan(winback7dWindow(NOW).fromMs);
  });
});

describe("creditWarningCrosses — #18 at/over 80% of a positive cap", () => {
  it("crosses EXACTLY at 80%", () => {
    expect(creditWarningCrosses(80, 100)).toBe(true);
    expect(creditWarningCrosses(8, 10)).toBe(true);
  });

  it("does not cross just below 80%", () => {
    expect(creditWarningCrosses(79, 100)).toBe(false);
    expect(creditWarningCrosses(7, 10)).toBe(false);
  });

  it("crosses above 80% and at the cap", () => {
    expect(creditWarningCrosses(81, 100)).toBe(true);
    expect(creditWarningCrosses(100, 100)).toBe(true);
  });

  it("zero usage never crosses", () => {
    expect(creditWarningCrosses(0, 100)).toBe(false);
  });

  it("missing usage counts as zero (never warns)", () => {
    expect(creditWarningCrosses(null, 100)).toBe(false);
  });

  it("a null cap never warns (unmetered workspace)", () => {
    expect(creditWarningCrosses(50, null)).toBe(false);
  });

  it("a ZERO cap never warns — closes the SQL hole where 0.8*0 = 0 lets it through", () => {
    // The scan's `coalesce(used,0) >= 0.8 * limit` is `>= 0` when limit is 0, so
    // it would return a zero-cap workspace; this helper is the belt-and-braces.
    expect(creditWarningCrosses(50, 0)).toBe(false);
    expect(creditWarningCrosses(0, 0)).toBe(false);
  });

  it("a negative cap never warns", () => {
    expect(creditWarningCrosses(5, -10)).toBe(false);
  });
});

describe("creditUsagePercent — #18 usage-bar display", () => {
  it("renders a plain percentage", () => {
    expect(creditUsagePercent(50, 100)).toBe(50);
    expect(creditUsagePercent(85, 100)).toBe(85);
  });

  it("clamps to 100 when over the cap", () => {
    expect(creditUsagePercent(150, 100)).toBe(100);
  });

  it("rounds to a whole percent", () => {
    expect(creditUsagePercent(1, 3)).toBe(33);
    expect(creditUsagePercent(2, 3)).toBe(67);
  });

  it("reads 0% for a null/zero/absent cap or usage", () => {
    expect(creditUsagePercent(0, 100)).toBe(0);
    expect(creditUsagePercent(null, 100)).toBe(0);
    expect(creditUsagePercent(5, 0)).toBe(0);
    expect(creditUsagePercent(5, null)).toBe(0);
  });
});

describe("digestHasActivity — #14 skip zero-activity workspaces (dormancy owns them)", () => {
  it("skips a workspace with no completed runs in the window", () => {
    expect(digestHasActivity({ runsCompleted: 0 })).toBe(false);
  });

  it("sends when at least one run completed", () => {
    expect(digestHasActivity({ runsCompleted: 1 })).toBe(true);
    expect(digestHasActivity({ runsCompleted: 42 })).toBe(true);
  });
});

describe("isoWeek — #14 weekly-digest dedupe key (real ISO-8601, incl. year boundaries)", () => {
  it("mid-year: 2026-07-04 is week 27", () => {
    expect(isoWeek(Date.UTC(2026, 6, 4))).toBe("2026-W27");
  });

  it("Jan 1 2026 (a Thursday) belongs to 2026-W01", () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe("2026-W01");
  });

  it("Dec 29 2025 (a Monday) already belongs to the NEXT year's 2026-W01", () => {
    // The tricky rollover: an ISO week is owned by the year of its Thursday.
    expect(isoWeek(Date.UTC(2025, 11, 29))).toBe("2026-W01");
  });

  it("Dec 28 2025 (a Sunday) is still 2025-W52", () => {
    expect(isoWeek(Date.UTC(2025, 11, 28))).toBe("2025-W52");
  });

  it("Dec 30 2024 (a Monday) belongs to 2025-W01", () => {
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01");
  });

  it("Jan 1 2021 (a Friday) belongs to the PREVIOUS year's 2020-W53", () => {
    expect(isoWeek(Date.UTC(2021, 0, 1))).toBe("2020-W53");
  });

  it("Jan 1 2023 (a Sunday) belongs to 2022-W52", () => {
    expect(isoWeek(Date.UTC(2023, 0, 1))).toBe("2022-W52");
  });

  it("Jan 1 2016 (a Friday) belongs to 2015-W53", () => {
    expect(isoWeek(Date.UTC(2016, 0, 1))).toBe("2015-W53");
  });

  it("pads the week number to two digits", () => {
    expect(isoWeek(Date.UTC(2026, 0, 5))).toBe("2026-W02");
  });
});

describe("billingMonthKey — #18 monthly re-warn key (YYYY-MM, UTC)", () => {
  it("formats the month", () => {
    expect(billingMonthKey(Date.UTC(2026, 6, 4))).toBe("2026-07");
    expect(billingMonthKey(Date.UTC(2026, 0, 1))).toBe("2026-01");
    expect(billingMonthKey(Date.UTC(2026, 11, 31))).toBe("2026-12");
  });

  it("buckets by UTC across a month boundary", () => {
    expect(billingMonthKey(Date.UTC(2026, 6, 31, 23, 59, 59))).toBe("2026-07");
    expect(billingMonthKey(Date.UTC(2026, 7, 1, 0, 0, 0))).toBe("2026-08");
  });
});

describe("dormantDedupeKey — #16 per-lastActiveAt-date key (a NEW spell re-fires)", () => {
  it("is the UTC date of the last heartbeat", () => {
    expect(dormantDedupeKey(Date.UTC(2026, 6, 4, 8, 0, 0))).toBe("2026-07-04");
  });

  it("is stable across the same UTC day (one fire per dormancy spell)", () => {
    const morning = dormantDedupeKey(Date.UTC(2026, 6, 4, 6, 0, 0));
    const evening = dormantDedupeKey(Date.UTC(2026, 6, 4, 22, 0, 0));
    expect(morning).toBe(evening);
  });

  it("changes on a new day, so a later dormancy spell re-fires", () => {
    expect(dormantDedupeKey(Date.UTC(2026, 6, 5, 6, 0, 0))).not.toBe(
      dormantDedupeKey(Date.UTC(2026, 6, 4, 6, 0, 0)),
    );
  });

  it("rolls at the UTC midnight boundary", () => {
    expect(dormantDedupeKey(Date.UTC(2026, 6, 4, 23, 59, 59))).toBe("2026-07-04");
    expect(dormantDedupeKey(Date.UTC(2026, 6, 5, 0, 0, 0))).toBe("2026-07-05");
  });
});

describe("ONCE — the send-once-ever activation key (#8/#9/#11)", () => {
  it("is the literal 'once'", () => {
    expect(ONCE).toBe("once");
  });
});
