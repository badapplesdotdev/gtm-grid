// Engine-level rate-limit integration: every connector call funnels through
// `Engine.throttle` (dispatch + runBatch), which paces starts + caps in-flight
// per connector. The load-bearing safety property is that an OUTBOUND connector
// with NO `rateLimit` of its own still can't fire an unbounded burst — it inherits
// the conservative default — while pure-local connectors are exempt.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";
import { DEFAULT_RATE_LIMIT, Engine } from "./execute.js";
import { Registry } from "./registry.js";
import type { Connector, ConnectorMethod, EngineConfig, RateLimit } from "./types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rate-limit-engine-test-"));
  db = new Db(join(dir, "project.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A connector whose `ping` method records each call's start time + peak in-flight. */
function timedRegistry(opts: { rateLimit?: RateLimit; local?: boolean; workMs?: number }) {
  const starts: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const workMs = opts.workMs ?? 0;
  const method: ConnectorMethod = {
    id: "ping",
    label: "Ping",
    description: "Records call timing.",
    inputSchema: {},
    batchSize: 1, // per-row path → goes through dispatch → throttle
    credits: 0,
    run: async () => {
      starts.push(Date.now());
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (workMs > 0) await new Promise((r) => setTimeout(r, workMs));
      inFlight--;
      return { text: "ok" };
    },
  };
  const connector: Connector = {
    id: "test",
    name: "Test",
    category: "test",
    auth: null,
    methods: [method],
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.local ? { local: true } : {}),
  };
  return {
    registry: new Registry([connector]),
    starts,
    get peak() {
      return peak;
    },
  };
}

/** Seed a table of N rows with a plain `test.ping` function column. */
function seed(n: number) {
  const table = db.createTable("Leads");
  const name = db.createColumn({ tableId: table.id, name: "Name", kind: "manual" });
  const out = db.createColumn({
    tableId: table.id,
    name: "Ping",
    kind: "function",
    provider: "test",
    method: "ping",
    params: { value: "{{Name}}" },
  });
  for (let i = 0; i < n; i++) {
    const r = db.createRow(table.id);
    db.setCell(r.id, name.id, { value: `name${i}`, status: "done" });
  }
  return out.id;
}

const run = (reg: ReturnType<typeof timedRegistry>, colId: string, config: EngineConfig = {}) =>
  new Engine(db, config, reg.registry).runColumn(colId);

describe("Engine.throttle — safety default", () => {
  it("DEFAULT_RATE_LIMIT is the conservative 2 req/s, 2 concurrent floor", () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({ rps: 2, concurrency: 2 });
  });

  it("paces an unconfigured connector's call STARTS at the default rps", async () => {
    const reg = timedRegistry({}); // no rateLimit → inherits DEFAULT_RATE_LIMIT (2 rps)
    const colId = seed(2);
    await run(reg, colId); // default EngineConfig → DEFAULT_RATE_LIMIT applies

    expect(reg.starts).toHaveLength(2);
    // 2 req/s ⇒ ~500ms between starts; allow timer slack below the nominal gap.
    expect(reg.starts[1] - reg.starts[0]).toBeGreaterThanOrEqual(450);
  });

  it("caps in-flight calls for an unconfigured connector", async () => {
    const reg = timedRegistry({ workMs: 40 });
    const colId = seed(6);
    // Override the default to a fast rps (no pacing) but keep the concurrency cap,
    // so the in-flight bound is observable without waiting on rps spacing.
    await run(reg, colId, { defaultRateLimit: { rps: 1000, concurrency: 2 } });

    expect(reg.peak).toBeLessThanOrEqual(2);
  });

  it("exempts pure-local connectors from the default throttle", async () => {
    const reg = timedRegistry({ local: true, workMs: 40 });
    const colId = seed(6);
    // Same fast/capped default — but a local connector must bypass it entirely, so
    // its in-flight count is bounded only by the run's own concurrency (5), not 2.
    await run(reg, colId, { defaultRateLimit: { rps: 1000, concurrency: 2 } });

    expect(reg.peak).toBeGreaterThan(2);
  });

  it("an explicit connector rateLimit wins over the default", async () => {
    const reg = timedRegistry({ rateLimit: { concurrency: 1 }, workMs: 30 });
    const colId = seed(4);
    // A lax default would allow 5 in flight; the connector's own cap of 1 must win.
    await run(reg, colId, { defaultRateLimit: { concurrency: 5 } });

    expect(reg.peak).toBe(1);
  });
});
