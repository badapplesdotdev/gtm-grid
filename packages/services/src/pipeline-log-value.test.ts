import { describe, expect, it } from "vitest";
import { compactPipelineLogValue, MAX_PIPELINE_LOG_VALUE_BYTES } from "./pipeline-log-value.js";

describe("compactPipelineLogValue", () => {
  it("keeps deterministic scalar and small structured outputs native", () => {
    expect(compactPipelineLogValue("hello")).toBe("hello");
    expect(compactPipelineLogValue(42)).toBe(42);
    expect(compactPipelineLogValue(false)).toBe(false);
    expect(compactPipelineLogValue({ result: "ok" })).toEqual({ result: "ok" });
  });

  it("replaces oversized payloads with a stable bounded receipt", () => {
    const value = "x".repeat(MAX_PIPELINE_LOG_VALUE_BYTES + 1);
    const compact = compactPipelineLogValue(value) as { _pipelineLog: { truncated: boolean; bytes: number; sha256: string; preview: string } };
    expect(compact._pipelineLog).toMatchObject({ truncated: true, bytes: value.length + 2 });
    expect(compact._pipelineLog.sha256).toHaveLength(64);
    expect(compact._pipelineLog.preview.length).toBeLessThan(value.length);
    expect(compactPipelineLogValue(value)).toEqual(compact);
  });
});
