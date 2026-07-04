/**
 * The DECISION LOGIC of the event-driven lifecycle emails (#10 #12 #13 #17),
 * condition by condition — OFFLINE. No Inngest, no Effect, no DB: every branch
 * the handlers take is lifted into a pure helper and pinned here, because each
 * one is a "spam vs. silence" fork:
 *   - {@link isPresent}    — send the "signals landed" mail ONLY when the owner
 *                            is away; a wrong answer either spams a live user or
 *                            drops the mail for an away one.
 *   - {@link runEmailRowThreshold} / {@link routeSignals} — pick #12 vs #13 and
 *     the dedupe key; a bad threshold silently forces one template forever.
 *   - {@link dunningContinues} — keep dunning a still-paying customer, STOP once
 *     they have churned.
 *   - {@link hasAiCredential}  — suppress the "connect a key" nudge once a key
 *     exists.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_EMAIL_ROW_THRESHOLD,
  dunningContinues,
  hasAiCredential,
  heartbeatMs,
  isPresent,
  PRESENCE_MS,
  routeSignals,
  runEmailRowThreshold,
} from "./lifecycle-events";

// A fixed "now" so every presence assertion is deterministic.
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0); // 2026-07-04T12:00:00Z

describe("heartbeatMs — coercing a heartbeat across the step.run JSON boundary", () => {
  it("passes a raw epoch number through unchanged", () => {
    expect(heartbeatMs(NOW)).toBe(NOW);
  });

  it("reads a Date (the shape inside the Effect read)", () => {
    expect(heartbeatMs(new Date(NOW))).toBe(NOW);
  });

  it("parses an ISO string (the shape AFTER a step.run serializes the Date)", () => {
    // step.run returns JSON, so a Date comes back as an ISO string — the real
    // bug class this helper exists to absorb.
    expect(heartbeatMs("2026-07-04T12:00:00.000Z")).toBe(NOW);
  });

  it("treats null / undefined as 'never seen' (null)", () => {
    expect(heartbeatMs(null)).toBeNull();
    expect(heartbeatMs(undefined)).toBeNull();
  });

  it("treats an unparseable string as absent (null), not NaN", () => {
    expect(heartbeatMs("not-a-date")).toBeNull();
  });
});

describe("isPresent — the #12/#13 presence gate (present ⇒ skip the email)", () => {
  it("a null heartbeat is NOT present, so the email SENDS (never heartbeated)", () => {
    // The load-bearing case: a user who has never opened the app must still be
    // emailed, not silently skipped.
    expect(isPresent(null, NOW)).toBe(false);
  });

  it("undefined is likewise NOT present (email sends)", () => {
    expect(isPresent(undefined, NOW)).toBe(false);
  });

  it("is present when the last heartbeat is right now", () => {
    expect(isPresent(NOW, NOW)).toBe(true);
  });

  it("is present one millisecond inside the 5-minute window", () => {
    expect(isPresent(NOW - (PRESENCE_MS - 1), NOW)).toBe(true);
  });

  it("is NOT present exactly AT the 5-minute boundary (email sends)", () => {
    // `now - lastActive === PRESENCE_MS` is not strictly within the window.
    expect(isPresent(NOW - PRESENCE_MS, NOW)).toBe(false);
  });

  it("is NOT present one millisecond past the boundary", () => {
    expect(isPresent(NOW - (PRESENCE_MS + 1), NOW)).toBe(false);
  });

  it("honours an ISO-string heartbeat inside the window (the JSON round-trip case)", () => {
    const iso = new Date(NOW - 60_000).toISOString(); // 1 min ago as a string
    expect(isPresent(iso, NOW)).toBe(true);
  });

  it("honours an ISO-string heartbeat at the boundary (email sends)", () => {
    const iso = new Date(NOW - PRESENCE_MS).toISOString();
    expect(isPresent(iso, NOW)).toBe(false);
  });

  it("treats a future heartbeat (clock skew) as present", () => {
    expect(isPresent(NOW + 10_000, NOW)).toBe(true);
  });

  it("fails OPEN: an unparseable heartbeat is not present, so the email sends", () => {
    expect(isPresent("garbage", NOW)).toBe(false);
  });

  it("PRESENCE_MS is exactly five minutes", () => {
    expect(PRESENCE_MS).toBe(5 * 60 * 1000);
  });
});

describe("runEmailRowThreshold — resolving RUN_EMAIL_ROW_THRESHOLD", () => {
  it("defaults to 25 when unset", () => {
    expect(runEmailRowThreshold(undefined)).toBe(DEFAULT_RUN_EMAIL_ROW_THRESHOLD);
    expect(DEFAULT_RUN_EMAIL_ROW_THRESHOLD).toBe(25);
  });

  it("parses a plain numeric string", () => {
    expect(runEmailRowThreshold("10")).toBe(10);
  });

  it("accepts an explicit zero (every landing becomes 'run finished')", () => {
    expect(runEmailRowThreshold("0")).toBe(0);
  });

  it("falls back to the default on garbage instead of yielding NaN", () => {
    // The bug this fixes: `Number("abc")` is NaN, and `added >= NaN` is always
    // false, which silently forced every landing to "signals waiting".
    expect(runEmailRowThreshold("abc")).toBe(25);
  });

  it("falls back to the default on a non-finite value like 'Infinity'", () => {
    expect(runEmailRowThreshold("Infinity")).toBe(25);
    expect(runEmailRowThreshold("NaN")).toBe(25);
  });

  it("tolerates surrounding whitespace", () => {
    expect(runEmailRowThreshold(" 10 ")).toBe(10);
  });

  it("pins the empty-string sharp edge: '' parses to 0, not the default", () => {
    // `RUN_EMAIL_ROW_THRESHOLD=` (set-but-empty) is Number("") === 0 — a finite
    // number — so it is honoured as 0, NOT treated as unset.
    expect(runEmailRowThreshold("")).toBe(0);
  });
});

describe("routeSignals — #12 'run finished' vs #13 'signals waiting' + dedupe key", () => {
  const landedIso = "2026-07-04T23:30:00.000Z";

  it("routes to 'run finished' when added is over the threshold", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 40,
      threshold: 25,
      landedAt: landedIso,
    });
    expect(r.template).toBe("run-finished");
  });

  it("routes to 'run finished' EXACTLY at the threshold (>= boundary)", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 25,
      threshold: 25,
      landedAt: landedIso,
    });
    expect(r.template).toBe("run-finished");
  });

  it("routes to 'signals waiting' one below the threshold", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 24,
      threshold: 25,
      landedAt: landedIso,
    });
    expect(r.template).toBe("signals-waiting");
  });

  it("dedupes 'run finished' PER LANDING — the raw landedAt is the key suffix", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 30,
      threshold: 25,
      landedAt: landedIso,
    });
    expect(r.dedupeKey).toBe(`bind_1:${landedIso}`);
  });

  it("keeps a numeric landedAt raw in the 'run finished' key (two landings a day stay distinct)", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 30,
      threshold: 25,
      landedAt: 1_751_670_600_000,
    });
    expect(r.dedupeKey).toBe("bind_1:1751670600000");
  });

  it("dedupes 'signals waiting' PER BINDING PER UTC DAY (YYYY-MM-DD of landedAt)", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 5,
      threshold: 25,
      landedAt: landedIso,
    });
    expect(r.dedupeKey).toBe("bind_1:2026-07-04");
  });

  it("buckets the 'signals waiting' day by UTC, not local time (23:59:59Z stays the same day)", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 5,
      threshold: 25,
      landedAt: "2026-07-04T23:59:59.000Z",
    });
    expect(r.dedupeKey).toBe("bind_1:2026-07-04");
  });

  it("rolls the 'signals waiting' day at the UTC midnight boundary", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 5,
      threshold: 25,
      landedAt: "2026-07-05T00:00:00.000Z",
    });
    expect(r.dedupeKey).toBe("bind_1:2026-07-05");
  });

  it("computes the 'signals waiting' day key from a numeric landedAt too", () => {
    const r = routeSignals({
      bindingId: "bind_1",
      added: 5,
      threshold: 25,
      landedAt: Date.UTC(2026, 6, 4, 6, 0, 0),
    });
    expect(r.dedupeKey).toBe("bind_1:2026-07-04");
  });
});

describe("dunningContinues — #17 continuation between escalation days", () => {
  it("STOPS when the re-synced plan id is null (canceled/lapsed)", () => {
    expect(dunningContinues(null)).toBe(false);
  });

  it("CONTINUES while a paid plan id is present", () => {
    expect(dunningContinues("plan_pro")).toBe(true);
  });

  it("is a null check, NOT truthiness: an empty-string plan id still continues", () => {
    // Pins the exact `p.id !== null` semantics — "" is a non-null id.
    expect(dunningContinues("")).toBe(true);
  });
});

describe("hasAiCredential — #10 skip when a key already exists", () => {
  it("an empty credential list has no AI key, so the nudge SENDS", () => {
    expect(hasAiCredential([])).toBe(false);
  });

  it("skips when a provider-scoped 'ai-anthropic' credential exists", () => {
    expect(hasAiCredential([{ extensionId: "ai-anthropic" }])).toBe(true);
  });

  it("skips on the bare 'ai' connector id", () => {
    expect(hasAiCredential([{ extensionId: "ai" }])).toBe(true);
  });

  it("a non-AI credential ('slack') does NOT suppress the nudge", () => {
    expect(hasAiCredential([{ extensionId: "slack" }])).toBe(false);
  });

  it("finds an AI key anywhere in the list", () => {
    expect(
      hasAiCredential([{ extensionId: "slack" }, { extensionId: "ai-openai" }]),
    ).toBe(true);
  });

  it("is case-sensitive: an upper-case 'AI' id does not match", () => {
    expect(hasAiCredential([{ extensionId: "AI" }])).toBe(false);
  });

  it("FOOTGUN pin: a prefix match means a hypothetical 'airtable' id would count as an AI key", () => {
    // Documents current behavior — `startsWith("ai")` is a prefix test, not an
    // id equality test. Safe today (the only "ai*" connector id is "ai"), but a
    // future "airtable" connector would wrongly suppress the nudge.
    expect(hasAiCredential([{ extensionId: "airtable" }])).toBe(true);
  });
});
