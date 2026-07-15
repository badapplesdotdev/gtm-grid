/**
 * AI prompt fields are textual even when they contain only an exact template.
 * Exact templates elsewhere deliberately retain their native type for tool
 * parameters, so this conversion is applied only at the AI execution boundary.
 */
export function pipelineTemplateText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
