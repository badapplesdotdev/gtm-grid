import { describe, expect, it, vi } from "vitest";
import { BackgroundRunRegistry } from "./background-runs";

describe("BackgroundRunRegistry", () => {
  it("keeps work alive independently and wakes a long poll on success", async () => {
    let resolve!: (value: { ran: number; errors: number }) => void;
    const task = new Promise<{ ran: number; errors: number }>((done) => { resolve = done; });
    const runs = new BackgroundRunRegistry(() => "run-1", () => 100);
    expect(runs.start(() => task)).toMatchObject({ runId: "run-1", status: "running" });

    const waiting = runs.wait("run-1", 5_000);
    resolve({ ran: 236, errors: 0 });
    await expect(waiting).resolves.toMatchObject({
      runId: "run-1",
      status: "succeeded",
      result: { ran: 236, errors: 0 },
    });
  });

  it("records failures instead of rejecting the status request", async () => {
    const runs = new BackgroundRunRegistry(() => "run-2");
    runs.start(async () => { throw new Error("connector unavailable"); });
    await vi.waitFor(() => expect(runs.get("run-2")).toMatchObject({
      status: "failed",
      error: "connector unavailable",
    }));
  });

  it("returns undefined for a run lost after an engine restart", async () => {
    const runs = new BackgroundRunRegistry();
    await expect(runs.wait("missing", 20_000)).resolves.toBeUndefined();
  });
});
