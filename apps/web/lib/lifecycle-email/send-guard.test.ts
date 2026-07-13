/**
 * The lifecycle send-guard rule engine, condition by condition — OFFLINE.
 *
 * {@link runLifecycleSend} is driven with plain fakes (no Effect, no DB, no
 * Resend): every skip/deliver rule the system relies on is pinned here, most
 * importantly the ones whose failure would SPAM or SILENTLY DROP mail:
 * kill-switch dry-run, category opt-outs vs the transactional bypass, the
 * once-only claim, claim RELEASE on a failed delivery (retry-safe), the
 * unsubscribe-secret refusal for marketing-ish mail, and the compliance
 * headers/links on everything non-transactional.
 */

import type { OutboundEmail } from "@gtmgrid/email";
import type { LifecycleRecipient } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import {
  runLifecycleSend,
  type LifecycleSendRequest,
  type SendGuardDeps,
} from "./send-guard";

const RECIPIENT: LifecycleRecipient = {
  id: "user_1",
  email: "olive@acme.com",
  name: "Olive Owner",
  emailPrefs: {},
  lastActiveAt: null,
};

interface Harness {
  readonly deps: SendGuardDeps;
  readonly delivered: OutboundEmail[];
  readonly captured: unknown[];
  readonly claims: string[];
  readonly released: string[];
  readonly logs: string[];
}

/** Fake collaborators with a real once-only claim set, all switches settable. */
function harness(overrides?: {
  recipient?: LifecycleRecipient | null;
  emailConfigured?: boolean;
  lifecycleEnabled?: boolean;
  unsubscribeSecret?: boolean;
  deliverError?: Error;
  preClaimed?: readonly string[];
}): Harness {
  const delivered: OutboundEmail[] = [];
  const captured: unknown[] = [];
  const claims: string[] = [...(overrides?.preClaimed ?? [])];
  const released: string[] = [];
  const logs: string[] = [];
  const deps: SendGuardDeps = {
    emailConfigured: overrides?.emailConfigured ?? true,
    lifecycleEnabled: overrides?.lifecycleEnabled ?? true,
    siteOrigin: "https://test.gtmgrid.dev",
    getRecipient: async () =>
      overrides && "recipient" in overrides ? (overrides.recipient ?? null) : RECIPIENT,
    recordSendOnce: async (c) => {
      const key = `${c.userId} ${c.template} ${c.dedupeKey}`;
      if (claims.includes(key)) return false;
      claims.push(key);
      return true;
    },
    releaseSend: async (c) => {
      released.push(`${c.userId} ${c.template} ${c.dedupeKey}`);
      const key = `${c.userId} ${c.template} ${c.dedupeKey}`;
      const i = claims.indexOf(key);
      if (i >= 0) claims.splice(i, 1);
    },
    mintUnsubscribeUrl: (userId, category) =>
      (overrides?.unsubscribeSecret ?? true)
        ? `https://test.gtmgrid.dev/email/unsubscribe?token=${userId}.${category}`
        : null,
    deliver: async (email) => {
      if (overrides?.deliverError) throw overrides.deliverError;
      delivered.push(email);
    },
    capture: (args) => captured.push(args),
    log: (line) => logs.push(line),
  };
  return { deps, delivered, captured, claims, released, logs };
}

function request(partial?: Partial<LifecycleSendRequest>): LifecycleSendRequest {
  return {
    userId: "user_1",
    workspaceId: "ws_1",
    template: "weekly-digest",
    dedupeKey: "2026-W27",
    category: "digest",
    build: async ({ to, links }) => ({
      to,
      subject: "your week in gtm grid",
      html: `<a href="${links.unsubscribeUrl ?? ""}">unsub</a>`,
      text: "digest",
    }),
    ...partial,
  };
}

describe("runLifecycleSend — gates that stop everything", () => {
  it("skips when email is not configured (no AUTH_RESEND_KEY)", async () => {
    const h = harness({ emailConfigured: false });
    const res = await runLifecycleSend(request(), h.deps);
    expect(res).toEqual({ sent: false, skipped: "email disabled" });
    expect(h.delivered).toHaveLength(0);
    expect(h.claims).toHaveLength(0);
  });

  it("dry-runs (logs, sends nothing, claims nothing) when the kill-switch is off", async () => {
    const h = harness({ lifecycleEnabled: false });
    const res = await runLifecycleSend(request(), h.deps);
    expect(res).toEqual({ sent: false, skipped: "dry-run" });
    expect(h.delivered).toHaveLength(0);
    expect(h.claims).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("DRY RUN");
    expect(h.logs.join("\n")).toContain("weekly-digest");
  });

  it("skips an unknown user without claiming", async () => {
    const h = harness({ recipient: null });
    const res = await runLifecycleSend(request(), h.deps);
    expect(res).toEqual({ sent: false, skipped: "no such user" });
    expect(h.claims).toHaveLength(0);
  });
});

describe("runLifecycleSend — preferences", () => {
  it("skips a category the user opted out of", async () => {
    const h = harness({
      recipient: { ...RECIPIENT, emailPrefs: { digest: false } },
    });
    const res = await runLifecycleSend(request({ category: "digest" }), h.deps);
    expect(res).toEqual({ sent: false, skipped: "opted out of digest" });
    expect(h.delivered).toHaveLength(0);
  });

  it("an opt-out in one category does not block another", async () => {
    const h = harness({
      recipient: { ...RECIPIENT, emailPrefs: { digest: false } },
    });
    const res = await runLifecycleSend(
      request({ category: "activation", template: "first-table" }),
      h.deps,
    );
    expect(res).toEqual({ sent: true });
  });

  it("transactional mail bypasses opt-outs entirely", async () => {
    const h = harness({
      recipient: {
        ...RECIPIENT,
        emailPrefs: { digest: false, activation: false, status: false },
      },
    });
    const res = await runLifecycleSend(
      request({ category: "transactional", template: "teammate-joined" }),
      h.deps,
    );
    expect(res).toEqual({ sent: true });
    expect(h.delivered).toHaveLength(1);
  });
});

describe("runLifecycleSend — compliance chrome", () => {
  it("REFUSES a non-transactional send when no unsubscribe secret is configured", async () => {
    const h = harness({ unsubscribeSecret: false });
    const res = await runLifecycleSend(request(), h.deps);
    expect(res).toEqual({
      sent: false,
      skipped: "no unsubscribe secret configured",
    });
    // The refusal happens BEFORE the claim so a later configured deploy can send.
    expect(h.claims).toHaveLength(0);
  });

  it("still sends transactional mail without an unsubscribe secret", async () => {
    const h = harness({ unsubscribeSecret: false });
    const res = await runLifecycleSend(
      request({ category: "transactional" }),
      h.deps,
    );
    expect(res).toEqual({ sent: true });
    expect(h.delivered[0]?.headers).toBeUndefined();
  });

  it("attaches List-Unsubscribe + one-click headers and the footer link on non-transactional sends", async () => {
    const h = harness();
    await runLifecycleSend(request(), h.deps);
    const email = h.delivered[0];
    expect(email?.headers?.["List-Unsubscribe"]).toContain(
      "/email/unsubscribe?token=",
    );
    expect(email?.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    // The builder received the link (rendered into the footer).
    expect(email?.html).toContain("/email/unsubscribe?token=user_1.digest");
  });

  it("gives the builder the recipient address and first name", async () => {
    const h = harness();
    let seen: { to: string; firstName: string | null } | null = null;
    await runLifecycleSend(
      request({
        build: async ({ to, firstName }) => {
          seen = { to, firstName };
          return { to, subject: "s", html: "h", text: "t" };
        },
      }),
      h.deps,
    );
    expect(seen).toEqual({ to: "olive@acme.com", firstName: "Olive" });
  });
});

describe("runLifecycleSend — idempotency", () => {
  it("sends exactly once for the same (user, template, dedupeKey)", async () => {
    const h = harness();
    const first = await runLifecycleSend(request(), h.deps);
    const second = await runLifecycleSend(request(), h.deps);
    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: false, skipped: "already sent" });
    expect(h.delivered).toHaveLength(1);
    expect(h.captured).toHaveLength(1);
  });

  it("a different dedupeKey (new window) sends again", async () => {
    const h = harness();
    await runLifecycleSend(request({ dedupeKey: "2026-W27" }), h.deps);
    const res = await runLifecycleSend(request({ dedupeKey: "2026-W28" }), h.deps);
    expect(res).toEqual({ sent: true });
    expect(h.delivered).toHaveLength(2);
  });

  it("a pre-existing claim from an earlier run is honoured", async () => {
    const h = harness({ preClaimed: ["user_1 weekly-digest 2026-W27"] });
    const res = await runLifecycleSend(request(), h.deps);
    expect(res).toEqual({ sent: false, skipped: "already sent" });
  });

  it("releases the claim when delivery fails, so a retry can send", async () => {
    const boom = new Error("resend 500");
    const failing = harness({ deliverError: boom });
    await expect(runLifecycleSend(request(), failing.deps)).rejects.toThrow(
      "resend 500",
    );
    expect(failing.released).toEqual(["user_1 weekly-digest 2026-W27"]);
    expect(failing.captured).toHaveLength(0); // no telemetry for a failed send

    // The same harness (claim released) now delivers on "retry".
    const retryDeps: typeof failing.deps = { ...failing.deps, deliver: async () => {} };
    const res = await runLifecycleSend(request(), retryDeps);
    expect(res).toEqual({ sent: true });
  });
});

describe("runLifecycleSend — Resend idempotency key", () => {
  it("attaches user:template:dedupeKey so a delivered-but-errored retry can't double-send", async () => {
    const h = harness();
    await runLifecycleSend(request(), h.deps);
    expect(h.delivered[0]?.idempotencyKey).toBe(
      "user_1:weekly-digest:2026-W27",
    );
  });

  it("attaches the key on transactional sends too", async () => {
    const h = harness();
    await runLifecycleSend(
      request({ category: "transactional", template: "teammate-joined", dedupeKey: "user_9" }),
      h.deps,
    );
    expect(h.delivered[0]?.idempotencyKey).toBe("user_1:teammate-joined:user_9");
  });
});

describe("runLifecycleSend — telemetry", () => {
  it("captures lifecycle_email_sent with template/category/workspace on success only", async () => {
    const h = harness();
    await runLifecycleSend(request(), h.deps);
    expect(h.captured).toEqual([
      {
        distinctId: "user_1",
        template: "weekly-digest",
        category: "digest",
        workspaceId: "ws_1",
      },
    ]);
  });

  it("captures nothing for a skipped send", async () => {
    const h = harness({ recipient: { ...RECIPIENT, emailPrefs: { digest: false } } });
    await runLifecycleSend(request(), h.deps);
    expect(h.captured).toHaveLength(0);
  });
});
