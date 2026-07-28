/**
 * OFFLINE tests for the CRM-sync poller's pure helpers (TRI: crm-sync) — the
 * trigger mapping, the status→analytics-event mapping, and the enrichment +
 * realtime event builders. These are extracted as pure functions so the wiring
 * that drives the durable Inngest steps is pinned without a live DB, Attio HTTP,
 * PostHog, or Inngest runtime — the same shape as the signals poller's tests.
 *
 * Also pins the concurrency-config contract (global account cap + per-workspace
 * key) the way concurrency-caps.test.ts pins the signals functions.
 */

import type { CrmSyncPageState } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import {
  crmContinuationEvent,
  crmEnrichEvents,
  crmSyncTrigger,
  crmTerminalEvent,
  processCrmBinding,
  warmUpCrmBinding,
  enrichCrmRow,
} from "./poll-crm-sync";

const WS = "ws_1";
const TABLE = "table_1";

describe("crmSyncTrigger — event → syncForWorker trigger", () => {
  it("maps the manual sync-now event to `manual`", () => {
    expect(crmSyncTrigger("crm/binding.sync-now")).toBe("manual");
  });

  it("maps the post-create event to `warmup`", () => {
    expect(crmSyncTrigger("crm/binding.created")).toBe("warmup");
  });

  it("maps the cron fan-out event to `cron`", () => {
    expect(crmSyncTrigger("crm/binding.due")).toBe("cron");
  });

  it("falls back to `cron` for any other event name", () => {
    expect(crmSyncTrigger("something/else")).toBe("cron");
  });
});

describe("crmTerminalEvent — status → analytics event", () => {
  it("ok → crm_sync_completed", () => {
    expect(crmTerminalEvent("ok")).toBe("crm_sync_completed");
  });

  it("partial → crm_sync_partial", () => {
    expect(crmTerminalEvent("partial")).toBe("crm_sync_partial");
  });

  it("warn → crm_sync_partial (landed data but degraded)", () => {
    expect(crmTerminalEvent("warn")).toBe("crm_sync_partial");
  });

  it("failed → crm_sync_failed", () => {
    expect(crmTerminalEvent("failed")).toBe("crm_sync_failed");
  });
});

describe("crmEnrichEvents — one idempotent enrich event per new row", () => {
  it("returns [] when the sync inserted no rows", () => {
    expect(crmEnrichEvents({ newRowIds: [], tableId: TABLE, workspaceId: WS })).toEqual([]);
  });

  it("returns [] when table/workspace did not resolve (defensive)", () => {
    expect(crmEnrichEvents({ newRowIds: ["r1"], tableId: "", workspaceId: WS })).toEqual([]);
    expect(crmEnrichEvents({ newRowIds: ["r1"], tableId: TABLE, workspaceId: "" })).toEqual([]);
  });

  it("emits one crm/row.inserted per new row, keyed by rowId for idempotency", () => {
    expect(crmEnrichEvents({ newRowIds: ["r1", "r2"], tableId: TABLE, workspaceId: WS })).toEqual([
      { name: "crm/row.inserted", data: { tableId: TABLE, workspaceId: WS, rowId: "r1" }, id: "crm-enrich:r1" },
      { name: "crm/row.inserted", data: { tableId: TABLE, workspaceId: WS, rowId: "r2" }, id: "crm-enrich:r2" },
    ]);
  });
});

describe("crmContinuationEvent — bounded page chaining", () => {
  it("carries only the compact checkpoint into a fresh Inngest run", () => {
    const checkpoint: CrmSyncPageState = {
      runId: "run_1",
      bindingId: "binding_1",
      cursor: "500",
      pages: 1,
      rowsCreated: 500,
      rowsUpdated: 0,
      rowsSkipped: 0,
      remainingRowBudget: 9_500,
      plan: {
        cap: 10_000,
        activeCols: [
          {
            attrSlug: "name",
            attrType: "personal-name",
            columnId: "column_1",
            title: "Name",
          },
        ],
        activeFilters: [],
        pullAttrs: [{ slug: "name", type: "personal-name" }],
        fieldsDropped: [],
      },
      members: null,
    };

    const event = crmContinuationEvent({
      bindingId: "binding_1",
      workspaceId: WS,
      checkpoint,
      trigger: "cron",
    });

    expect(event.id).toBe("crm-page:run_1:1");
    expect(event.name).toBe("crm/binding.page");
    expect(event.data.checkpoint).toEqual(checkpoint);
    expect(event.data).not.toHaveProperty("newRowIds");
  });
});

type ConcurrencyOption = { scope?: "fn" | "env" | "account"; key?: string; limit: number };

function asEntries(concurrency: unknown): ConcurrencyOption[] {
  if (Array.isArray(concurrency)) return concurrency as ConcurrencyOption[];
  if (concurrency && typeof concurrency === "object") return [concurrency as ConcurrencyOption];
  return [];
}

describe("global Inngest concurrency caps (TRI-3265)", () => {
  it("continues large CRM pulls through a fresh event run per checkpoint", () => {
    expect(processCrmBinding.opts.triggers).toContainEqual({ event: "crm/binding.page" });
  });

  it("process-crm-binding carries a global account cap + per-workspace key", () => {
    const entries = asEntries(processCrmBinding.opts.concurrency);
    const account = entries.find((e) => e.scope === "account");
    expect(account, "missing account-scoped global cap").toBeDefined();
    expect(account?.limit).toBe(50);
    expect(account?.key, "account-scoped cap must specify a key").toBeTruthy();
    const perWorkspace = entries.find((e) => e.key === "event.data.workspaceId");
    expect(perWorkspace?.limit).toBe(2);
  });

  it("enrich-crm-row carries a global account cap + per-workspace key", () => {
    const entries = asEntries(enrichCrmRow.opts.concurrency);
    const account = entries.find((e) => e.scope === "account");
    expect(account?.limit).toBe(50);
    expect(account?.key, "account-scoped cap must specify a key").toBeTruthy();
    const perWorkspace = entries.find((e) => e.key === "event.data.workspaceId");
    expect(perWorkspace?.limit).toBe(4);
  });

  it("warm-up-crm-binding keeps its per-workspace concurrency key", () => {
    const entries = asEntries(warmUpCrmBinding.opts.concurrency);
    const perWorkspace = entries.find((e) => e.key === "event.data.workspaceId");
    expect(perWorkspace?.limit).toBe(2);
  });
});
