// Pure helpers for the `/api/options` dependent-dropdown logic (extracted so the
// injection + missing-input rules are unit-testable without the HTTP server).
//
// A field's option source (e.g. `campaign_id` → `listCampaigns`) may itself
// require a SIBLING field's value (e.g. `workspace_id`). The column editor sends
// the in-progress field values; we inject any whose key the SOURCE method
// declares required — and only those, so the half-picked field being edited or
// unrelated inputs never leak into the list call.

/** A connector method's required input keys, read from its JSON-Schema `input`. */
export function requiredInputKeys(inputSchema: unknown): string[] {
  const req = (inputSchema as { required?: unknown } | null | undefined)?.required;
  return Array.isArray(req) ? req.map(String) : [];
}

/**
 * Inject required sibling values into the option-list args, and report which
 * required inputs are still unset. A present arg is never overwritten; a blank /
 * nullish value is treated as unset.
 */
export function resolveOptionArgs(
  baseArgs: Record<string, unknown>,
  srcRequired: readonly string[],
  values: Record<string, unknown>,
): { args: Record<string, unknown>; missing: string[] } {
  const args = { ...baseArgs };
  for (const key of srcRequired) {
    const v = values[key];
    if (v != null && v !== "" && args[key] == null) args[key] = v;
  }
  const missing = srcRequired.filter((k) => args[k] == null || args[k] === "");
  return { args, missing };
}
