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

  // ── Auth lifecycle (server-side, Better Auth hooks) ──────────────────────────
  /**
   * A brand-new account was created. Emitted server-side from the Better Auth
   * `user.create.after` hook (packages/auth) keyed on the user id, which is the
   * SAME distinct id the desktop client later passes to `posthog.identify` — so
   * the signup and all later product events resolve to one identified person.
   * Capturing this server-side means a signup is recorded with name/email even if
   * the client never fires identify (wrong build, analytics disabled, crash).
   */
  user_signed_up: { method: "password" | "oauth" | "unknown" };

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
  /**
   * A column run finished with one or more failed cells. Emitted by the run's host
   * (sidecar / cloud worker / MCP) from `runColumn`'s `{ ran, errors, firstError }`
   * summary — the monitoring signal for connector/AI/enrichment failure RATES
   * (dashboards + alerts), complementary to the deduped systemic exceptions raised
   * via the engine's `reportError` hook. `surface` says where the run executed.
   */
  column_run_failed: {
    column_id: string;
    provider: string | null;
    method: string | null;
    ran: number;
    errors: number;
    first_error?: string;
    surface: "sidecar" | "cloud" | "mcp";
  };
  agent_turn_completed: {
    agent: "claude" | "codex" | "cursor";
    mode?: string;
    outcome: "completed" | "stopped" | "error";
  };
  ask_user_question_answered: { agent: string; questions: number };
  cloud_sync_completed: { table_id: string; rows: number };
  onboarding_step_completed: { step: string };

  // ── Realtime (PartyKit) ──────────────────────────────────────────────────────
  realtime_connected: { workspace_id: string; table_id: string };

  // ── Revenue (emitted server-side from the billing webhook → Revenue Analytics) ─
  // `revenue` is the recurring amount in MAJOR currency units (e.g. dollars).
  subscription_started: { workspace_id: string; plan_id: string; revenue?: number; currency?: string };
  subscription_changed: { workspace_id: string; plan_id: string; revenue?: number; currency?: string };
  subscription_canceled: { workspace_id: string; plan_id: string };
  subscription_payment_failed: { workspace_id: string; plan_id: string };

  // ── Support / feedback (Surveys + in-app feedback) ───────────────────────────
  feedback_submitted: { surface: string; rating?: number };
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
