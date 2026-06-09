/**
 * Regression test for TRI-3265: per-workspace Inngest concurrency limits
 * multiply unbounded as the number of workspaces grows, so every fan-out
 * function must ALSO carry a GLOBAL account-scoped cap. This pins the config
 * shape so the global cap can never silently disappear: each function must
 * expose an `account`-scoped entry AND keep its original per-workspace key.
 *
 * We assert against `fn.opts.concurrency` (the public, readonly config the
 * function was created with) rather than running the function, so the test is
 * offline and deterministic.
 */

import { describe, expect, it } from "vitest";
import { processSignalBinding } from "./poll-trigify-signals";
import { processWebhookRecord } from "./process-webhook-record";

type ConcurrencyOption = {
  scope?: "fn" | "env" | "account";
  key?: string;
  limit: number;
};

function asEntries(
  concurrency: unknown,
): ConcurrencyOption[] {
  if (Array.isArray(concurrency)) return concurrency as ConcurrencyOption[];
  if (concurrency && typeof concurrency === "object") {
    return [concurrency as ConcurrencyOption];
  }
  return [];
}

describe("global Inngest concurrency caps (TRI-3265)", () => {
  it("process-webhook-record carries a global account cap + per-workspace key", () => {
    const entries = asEntries(processWebhookRecord.opts.concurrency);

    const account = entries.find((e) => e.scope === "account");
    expect(account, "missing account-scoped global cap").toBeDefined();
    expect(account?.limit).toBe(50);

    const perWorkspace = entries.find(
      (e) => e.key === "event.data.workspaceId",
    );
    expect(perWorkspace, "missing per-workspace concurrency key").toBeDefined();
    expect(perWorkspace?.limit).toBe(5);
  });

  it("process-signal-binding carries a global account cap + per-workspace key", () => {
    const entries = asEntries(processSignalBinding.opts.concurrency);

    const account = entries.find((e) => e.scope === "account");
    expect(account, "missing account-scoped global cap").toBeDefined();
    expect(account?.limit).toBe(50);

    const perWorkspace = entries.find(
      (e) => e.key === "event.data.workspaceId",
    );
    expect(perWorkspace, "missing per-workspace concurrency key").toBeDefined();
    expect(perWorkspace?.limit).toBe(2);
  });
});
