/**
 * The single, typed source of truth for every product analytics event captured
 * across gtm-grid — web (`posthog-js`), desktop (`posthog-js`), the local sidecar
 * (`posthog-node`), Inngest, and PartyKit. Keep event NAMES snake_case and stable
 * (they become PostHog insight identifiers), and keep property keys snake_case to
 * match PostHog conventions.
 *
 * Surfaces should never call `posthog.capture("some_string", ...)` directly — they
 * import {@link AnalyticsEventName} / {@link AnalyticsEventMap} so a typo or a wrong
 * payload is a compile error, and the catalog stays discoverable in one place.
 */
export interface AnalyticsEventMap {
  // ── Web marketing site (already instrumented by the PostHog wizard) ──────────
  download_initiated: { platform: string; os: string };
  pricing_plan_cta_clicked: { plan: string; billing_period: string };
  billing_period_toggled: { period: string };
  invite_code_copied: Record<string, never>;
  clone_command_copied: Record<string, never>;

  // ── Server-side (web tRPC / webhook / Inngest) ───────────────────────────────
  billing_checkout_initiated: { workspace_id: string; plan_id: string };
  webhook_received: {
    webhook_id: string;
    workspace_id: string;
    table_id: string;
    auto_run: boolean;
    mode: string;
  };

  // ── Desktop product surface (new) ────────────────────────────────────────────
  app_opened: { version?: string };
  table_created: { table_id: string; source: "manual" | "csv" | "agent" };
  column_added: {
    table_id: string;
    column_id: string;
    kind: "manual" | "formula" | "function" | "code";
    fn?: string;
  };
  column_run: { table_id: string; column_id: string; rows: number; cloud: boolean };
  agent_turn_completed: {
    agent: "claude" | "codex" | "hermes";
    mode?: string;
    outcome: "completed" | "stopped" | "error";
  };
  ask_user_question_answered: { agent: string; questions: number };
  cloud_sync_completed: { table_id: string; rows: number };
  onboarding_step_completed: { step: string };

  // ── Realtime (PartyKit) ──────────────────────────────────────────────────────
  realtime_connected: { workspace_id: string; table_id: string };
}

/** Every valid analytics event name. */
export type AnalyticsEventName = keyof AnalyticsEventMap;

/** The property payload for a given event name (use `never`-free `Record` for "no props"). */
export type AnalyticsEventProps<E extends AnalyticsEventName> = AnalyticsEventMap[E];

/** Traits attached to a user via `identify`. */
export interface UserTraits {
  email?: string;
  name?: string;
}

/** Properties attached to a workspace group via group analytics. */
export interface WorkspaceGroupProps {
  name?: string;
  plan?: string;
}

/** The PostHog group type used for workspace-level (account) analytics. */
export const WORKSPACE_GROUP = "workspace";
