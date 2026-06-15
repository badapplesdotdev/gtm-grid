/**
 * Fire-and-forget PostHog capture for the PartyKit (Cloudflare Workers) runtime.
 * There is no long-lived process and `posthog-node` isn't a fit here, so we POST
 * directly to PostHog's ingestion endpoint and never await — telemetry must never
 * block or fail a realtime connection.
 *
 * Config via the party's env: `POSTHOG_KEY` (+ optional `POSTHOG_HOST`). Unset →
 * no-op. Event names mirror the @gtmgrid/analytics catalog (kept as a string here
 * to avoid bundling a workspace dep into the Worker).
 */
export function capturePartyEvent(
  env: Record<string, unknown>,
  event: string,
  distinctId: string,
  properties?: Record<string, unknown>,
  workspaceId?: string,
): void {
  const key = env.POSTHOG_KEY as string | undefined;
  if (!key) return;
  const host = (env.POSTHOG_HOST as string | undefined) ?? "https://eu.i.posthog.com";
  void fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event,
      distinct_id: distinctId || "anonymous",
      properties: {
        ...properties,
        ...(workspaceId ? { $groups: { workspace: workspaceId } } : {}),
      },
    }),
  }).catch(() => {
    /* telemetry is best-effort; never surface to the room */
  });
}
