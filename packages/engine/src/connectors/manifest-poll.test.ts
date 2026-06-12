// The manifest `poll` capability: a method that STARTS an async job, then polls a
// sibling status method host-side until it completes — so a multi-minute job finishes
// in ONE connector call (not bound by the in-sandbox per-cell timeout). Mirrors the
// Firecrawl extract → getExtractStatus flow.

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "jobs",
  name: "Jobs",
  baseUrl: "https://api.jobs.test",
  auth: null,
  methods: [
    {
      id: "getStatus",
      description: "Poll a job",
      verb: "GET",
      path: "/jobs/{id}",
      input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    {
      id: "run",
      description: "Start and wait",
      verb: "POST",
      path: "/jobs",
      input: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
      poll: {
        statusMethod: "getStatus",
        idFrom: "id",
        idParam: "id",
        statusFrom: "status",
        doneWhen: "completed",
        failWhen: ["failed"],
        dataFrom: "data",
        intervalMs: 1, // keep the test instant
        timeoutMs: 50, // small so the timeout case resolves fast
      },
    },
  ],
});

const runMethod = (): ConnectorMethod => {
  const m = connectorFromManifest(manifest).methods.find((x) => x.id === "run");
  if (!m) throw new Error("run method missing");
  return m;
};
const ctx: MethodContext = { secrets: {} };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("manifest poll", () => {
  it("starts the job, polls until completed, and returns the data payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ success: true, id: "job-1" })) // start
      .mockResolvedValueOnce(json({ status: "processing" })) // poll 1
      .mockResolvedValueOnce(json({ status: "completed", data: { answer: 42 } })); // poll 2

    const result = await runMethod().run({ q: "hello" }, ctx);

    expect(result).toEqual({ answer: 42 });
    // 1 start + 2 status polls.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.jobs.test/jobs");
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("https://api.jobs.test/jobs/job-1");
  });

  it("throws (not returns) when the job ends in a failWhen state", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ id: "job-2" }))
      .mockResolvedValueOnce(json({ status: "failed" }));

    await expect(runMethod().run({ q: "x" }, ctx)).rejects.toThrow(/job failed/i);
  });

  it("throws a timeout when the job never completes within the budget", async () => {
    // Always 'processing' → must give up at the deadline rather than loop forever.
    // Fresh Response per call (a body can only be read once).
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ id: "job-3", status: "processing" }));

    await expect(runMethod().run({ q: "x" }, ctx)).rejects.toThrow(/timed out/i);
  });
});
