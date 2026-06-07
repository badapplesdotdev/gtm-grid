/**
 * `MeterService` unit tests — OFFLINE against the in-memory Test Layer. Proves
 * the cloud-actions WRITE path: `meterActions` increments `cloudActionsUsed` by N
 * (and is a no-op for N <= 0), and `readQuota` surfaces the seeded snapshot.
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { type MeterQuota, MeterService, meterServiceLayer } from "./meter-service.js";

const WS = "ws-1";

const run = <A, E>(
  quotas: Map<string, MeterQuota>,
  program: Effect.Effect<A, E, MeterService>,
) => Effect.runPromise(program.pipe(Effect.provide(meterServiceLayer(quotas))));

describe("MeterService.meterActions", () => {
  it("increments cloudActionsUsed by N from a seeded base", async () => {
    const quotas = new Map<string, MeterQuota>([
      [WS, { cloudActionsUsed: 5, cloudActionsLimit: 100 }],
    ]);
    await run(quotas, Effect.flatMap(MeterService, (s) => s.meterActions(WS, 3)));
    expect(quotas.get(WS)).toEqual({ cloudActionsUsed: 8, cloudActionsLimit: 100 });
  });

  it("starts from 0 when the workspace has no prior usage", async () => {
    const quotas = new Map<string, MeterQuota>();
    await run(quotas, Effect.flatMap(MeterService, (s) => s.meterActions(WS, 1)));
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
  });

  it("is a no-op for N <= 0 (never decrements or creates a row)", async () => {
    const quotas = new Map<string, MeterQuota>();
    await run(quotas, Effect.flatMap(MeterService, (s) => s.meterActions(WS, 0)));
    expect(quotas.has(WS)).toBe(false);
  });
});

describe("MeterService.readQuota", () => {
  it("returns the seeded snapshot", async () => {
    const quotas = new Map<string, MeterQuota>([
      [WS, { cloudActionsUsed: 2, cloudActionsLimit: 10 }],
    ]);
    const q = await run(quotas, Effect.flatMap(MeterService, (s) => s.readQuota(WS)));
    expect(Option.isSome(q) && q.value).toEqual({ cloudActionsUsed: 2, cloudActionsLimit: 10 });
  });

  it("returns None for an unknown workspace", async () => {
    const q = await run(new Map(), Effect.flatMap(MeterService, (s) => s.readQuota(WS)));
    expect(Option.isNone(q)).toBe(true);
  });
});
