/**
 * OFFLINE tests for the Social-Signals poller's lifecycle emission — the
 * `lifecycle/signals.landed` reward-loop email (#12/#13). The emission rule is
 * extracted into the pure {@link signalsLandedEvent} so the gate + exact payload
 * are pinned here without a live DB, Trigify HTTP, or Inngest runtime.
 *
 * Also pins the deliberate asymmetry: the CRON sync (`processSignalBinding`)
 * emits the landed event, but the post-create WARM-UP (`warmUpSignalBinding`)
 * MUST NOT — the user just created that binding and is in the app watching it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signalsLandedEvent } from "./poll-trigify-signals";

const WS = "ws_1";
const TABLE = "table_1";
const BINDING = "binding_1";
const LANDED_AT = 1_750_000_000_000;

describe("signalsLandedEvent — gate", () => {
  it("returns null when the sync added no rows (added 0)", () => {
    expect(
      signalsLandedEvent({ added: 0, workspaceId: WS, tableId: TABLE }, BINDING, LANDED_AT),
    ).toBeNull();
  });

  it("returns null when the workspace did not resolve (failed sync)", () => {
    expect(
      signalsLandedEvent({ added: 3, workspaceId: null, tableId: TABLE }, BINDING, LANDED_AT),
    ).toBeNull();
  });

  it("returns null when the table did not resolve (failed sync)", () => {
    expect(
      signalsLandedEvent({ added: 3, workspaceId: WS, tableId: null }, BINDING, LANDED_AT),
    ).toBeNull();
  });

  it("returns null when a failed sync leaves both null with added 0", () => {
    expect(
      signalsLandedEvent({ added: 0, workspaceId: null, tableId: null }, BINDING, LANDED_AT),
    ).toBeNull();
  });
});

describe("signalsLandedEvent — happy path payload", () => {
  it("emits the event with EXACTLY the keyed payload when rows land", () => {
    const event = signalsLandedEvent(
      { added: 5, workspaceId: WS, tableId: TABLE },
      BINDING,
      LANDED_AT,
    );
    expect(event).toEqual({
      name: "lifecycle/signals.landed",
      data: {
        workspaceId: WS,
        tableId: TABLE,
        bindingId: BINDING,
        added: 5,
        landedAt: LANDED_AT,
      },
    });
  });
});

describe("warm-up does NOT emit the landed reward-loop email", () => {
  it("the warmUpSignalBinding function never references lifecycle/signals.landed", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./poll-trigify-signals.ts", import.meta.url)),
      "utf8",
    );
    // Isolate the warm-up function body (from its export to end of file) and
    // assert the reward-loop event name never appears in it — only the CRON
    // `processSignalBinding` path is allowed to emit it.
    const warmUpStart = src.indexOf("export const warmUpSignalBinding");
    expect(warmUpStart, "warmUpSignalBinding export not found").toBeGreaterThan(-1);
    const warmUpBody = src.slice(warmUpStart);
    expect(warmUpBody).not.toContain("lifecycle/signals.landed");
    expect(warmUpBody).not.toContain("signalsLandedEvent");
  });
});
