import { describe, expect, it } from "vitest";
import {
  PIPELINE_RUN_RETENTION_DAYS,
  PIPELINE_RUN_RETENTION_MS,
  pipelineRunRetentionCutoff,
} from "./pipeline-retention";

describe("pipeline run retention", () => {
  it("expires execution history after exactly 30 days", () => {
    const now = Date.UTC(2026, 6, 15, 12);
    expect(PIPELINE_RUN_RETENTION_DAYS).toBe(30);
    expect(pipelineRunRetentionCutoff(now)).toBe(now - PIPELINE_RUN_RETENTION_MS);
  });
});
