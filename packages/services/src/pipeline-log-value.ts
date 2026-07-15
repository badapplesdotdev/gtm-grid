import { createHash } from "node:crypto";

export const MAX_PIPELINE_LOG_VALUE_BYTES = 64 * 1_024;
export const PIPELINE_LOG_PREVIEW_CHARS = 2_000;

export interface TruncatedPipelineLogValue {
  readonly _pipelineLog: {
    readonly truncated: true;
    readonly type: "string" | "array" | "object";
    readonly bytes: number;
    readonly sha256: string;
    readonly preview: string;
  };
}

/** Keep native scalars and normal structured results unchanged. Oversized log
 * payloads become a deterministic preview receipt; table output cells still
 * retain the actual user result. */
export function compactPipelineLogValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_PIPELINE_LOG_VALUE_BYTES) return value;
  const type = typeof value === "string" ? "string" : Array.isArray(value) ? "array" : "object";
  return {
    _pipelineLog: {
      truncated: true,
      type,
      bytes,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      preview: (typeof value === "string" ? value : serialized).slice(0, PIPELINE_LOG_PREVIEW_CHARS),
    },
  } satisfies TruncatedPipelineLogValue;
}
