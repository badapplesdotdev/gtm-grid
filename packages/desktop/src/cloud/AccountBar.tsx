/**
 * Account bar / menu + plan badge (T8) — plain React.
 *
 * Renders the sidebar-footer account control and the top-bar plan/seat badge,
 * driven by the reactive `me` query (via the hooks in ./auth). All client-side
 * LOGIC (sign-in orchestration, active-workspace selection) lives in Effect
 * services / hooks in ./auth; this file is presentation + event wiring only.
 *
 * Behaviour:
 *   - Cloud disabled OR signed out → the badge shows "FREE" (local) and the
 *     account menu offers **Sign in** (email + password). The existing local
 *     project switcher is preserved in every state.
 *   - Signed in → the badge shows the active workspace's plan + seats
 *     (used / limit); the menu shows the user, a **workspace switcher**
 *     (with **Create workspace**), and **Sign out**.
 *
 * The LOCAL project section (current project + "Switch project") is always
 * shown so local-only usage is unchanged.
 */

import { useCallback, useEffect, useState } from "react";
import { type BillingCycle, resolvePlanId } from "@gtmgrid/cloud";
import { Dialog, DialogContent } from "../components/ui/dialog";
import type { Id } from "./ids";
import { cloudEnabled, syncWorkspacePlan } from "./client";
import { electron } from "../electron";

/** Open a URL in the system browser (Electron when packaged, else a new tab). */
async function openExternalUrl(url: string): Promise<void> {
  try {
    const api = electron();
    if (api) {
      await api.openExternal(url);
      return;
    }
  } catch {
    /* fall through to a browser tab */
  }
  const w = (globalThis as { window?: Window }).window;
  if (!w) return;
  const tab = w.open(url, "_blank", "noopener");
  if (!tab) w.location.assign(url);
}

/** Discord brand mark. */
const DiscordIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.291.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);
import {
  useAccountActions,
  useActiveWorkspace,
  useAuthState,
  useCreateWorkspace,
  useEnabledProviders,
  useMe,
  type OAuthProvider,
  type WorkspaceSummary,
} from "./auth";
import { GitHub, Google } from "./onboarding/icons";
import { PlanGrid, BillingToggle } from "./onboarding/PlanGrid";
import type { SelectablePlan } from "./onboarding/flow-logic";
import { runCheckout, useCheckoutLayer } from "./checkout";

type HealthStatus = "loading" | "connected" | "offline";

/**
 * Human-readable plan label for a workspace (C27): the real plan name the `me`
 * query surfaces from Autumn (Free / Team / Business / Unlimited), cached on the
 * workspace by the usage cron. Falls back to "Free" when no workspace.
 */
function planLabel(ws: WorkspaceSummary | null): string {
  if (ws === null) return "Free";
  return ws.plan.name;
}

/**
 * The top-bar badge. Real plan/seat badge from `me` when signed in; the
 * decorative "FREE" otherwise. Replaces the old static `.free-badge`.
 */
export function PlanBadge() {
  const me = useMe();
  const { activeWorkspace } = useActiveWorkspace(me ?? null);

  if (!cloudEnabled || me == null || activeWorkspace === null) {
    return <span className="free-badge">FREE</span>;
  }

  const { used, limit } = activeWorkspace.seatUsage;
  const seats = limit === null ? `${used}` : `${used}/${limit}`;
  return (
    <span className="free-badge" title={`${planLabel(activeWorkspace)} plan`}>
      {planLabel(activeWorkspace).toUpperCase()} · {seats} {used === 1 ? "seat" : "seats"}
    </span>
  );
}

interface AccountBarProps {
  projectName: string;
  healthStatus: HealthStatus;
  /** The open cloud project's name (shown as the selected Environment item). */
  cloudProjectName?: string | null;
  /** Open the cloud project switcher. */
  onSwitchProject: () => void;
  /** Current appearance theme (for the dark-mode toggle). */
  theme?: "light" | "dark";
  /** Toggle the appearance theme; when provided, the Appearance section shows. */
  onToggleTheme?: () => void;
  /**
   * Open the full-screen cloud onboarding flow (C28). When provided, the
   * signed-out menu's "Sign in" opens this flow instead of the inline form.
   */
  onStartOnboarding?: () => void;
}

/**
 * The account avatar: the signed-in user's profile picture when available
 * (`me.user.image`, an OAuth/profile URL), otherwise the initial letter. The
 * `.account-avatar` class supplies the circle; the image fills it. `no-referrer`
 * is required for Google/GitHub avatar hotlinking (same as PresenceAvatars). On
 * a broken image URL we fall back to the letter.
 */
export function AccountAvatar({ image, letter }: { image: string | null; letter: string }) {
  const [failed, setFailed] = useState(false);
  const showImage = image != null && image !== "" && !failed;
  return (
    <span className="account-avatar">
      {showImage ? (
        <img
          className="account-avatar-img"
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        letter
      )}
    </span>
  );
}

/**
 * The sidebar-footer account control + dropdown menu. Shows local project info
 * always; layers cloud auth + workspace switching on top when signed in.
 */
export function AccountBar(props: AccountBarProps) {
  const {
    projectName,
    healthStatus,
    cloudProjectName = null,
    onSwitchProject,
    theme,
    onToggleTheme,
    onStartOnboarding,
  } = props;
  const [open, setOpen] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const me = useMe();
  const { isAuthenticated } = useAuthState();
  const { activeWorkspace, setActiveWorkspaceId } = useActiveWorkspace(me ?? null);

  const signedIn = cloudEnabled && isAuthenticated && me != null;
  const avatarLetter = signedIn
    ? (me!.user.name ?? me!.user.email ?? "?").slice(0, 1).toUpperCase()
    : projectName.slice(0, 1).toUpperCase();

  const openMenu = useCallback(() => {
    setOpen(true);
  }, []);

  return (
    <div className="account-bar">
      <button
        className="account-btn"
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <AccountAvatar image={signedIn ? me!.user.image : null} letter={avatarLetter} />
        <span className="account-text">
          <span className="account-name">
            {signedIn
              ? activeWorkspace?.name ?? me!.user.name ?? me!.user.email ?? "Account"
              : projectName}
          </span>
          <span className="account-sub">
            {/* The status dot reflects the relevant connection: cloud session
                state when signed in (the `me` query is live by then), vs. the
                local sidecar's health otherwise. Without this scoping a signed-in
                user would see a green/red dot driven by the LOCAL sidecar, which
                says nothing about their cloud connectivity. */}
            <span className={`status-dot ${signedIn ? "connected" : healthStatus}`} />
            {signedIn
              ? me!.user.email ?? "Signed in"
              : healthStatus === "connected"
                ? "Local workspace"
                : healthStatus === "offline"
                  ? "Offline"
                  : "Connecting…"}
          </span>
        </span>
        {/* Plan/seat chip lives here (moved out of the cramped sidebar header). */}
        <PlanBadge />
        <svg
          className="account-chevrons"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="7 15 12 20 17 15" />
          <polyline points="7 9 12 4 17 9" />
        </svg>
      </button>

      {open && (
        <>
          <div className="account-backdrop" onClick={() => setOpen(false)} />
          <div className="account-menu">
            <div className="account-menu-head">
              <AccountAvatar image={signedIn ? me!.user.image : null} letter={avatarLetter} />
              <div className="account-menu-head-text">
                <strong>
                  {signedIn
                    ? me!.user.name ?? me!.user.email ?? "Account"
                    : "Local workspace"}
                </strong>
                <span>
                  {signedIn
                    ? me!.user.email ?? "Signed in"
                    : "All projects on this device"}
                </span>
              </div>
            </div>

            {/* Cloud: workspace switcher (signed in) or sign-in (signed out). */}
            {cloudEnabled &&
              (signedIn ? (
                <WorkspaceSwitcher
                  workspaces={me!.workspaces}
                  activeId={activeWorkspace?._id ?? null}
                  onSelect={(id) => setActiveWorkspaceId(id)}
                />
              ) : onStartOnboarding ? (
                // Full-screen onboarding (C28): the menu's "Sign in" launches the
                // split-layout flow instead of the inline form.
                <div className="account-menu-sec">
                  <div className="account-menu-label">Cloud</div>
                  <button
                    className="account-menu-item"
                    onClick={() => {
                      setOpen(false);
                      onStartOnboarding();
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                    Sign in to GTM Grid cloud
                  </button>
                </div>
              ) : (
                <SignInSection onDone={() => setOpen(false)} />
              ))}

            {/* Environment section — the open cloud project (the only data path)
                + a "Switch project" action that opens the cloud project switcher. */}
            <div className="account-menu-sec">
              <div className="account-menu-label">Environment</div>
              {/* Current selected environment (checkmark). */}
              <div className="account-menu-current">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <div className="account-menu-current-text">
                  <span className="account-menu-current-name">
                    {cloudProjectName ?? "Cloud project"}
                  </span>
                  <span className="account-menu-current-path">
                    Cloud · live multiplayer
                  </span>
                </div>
              </div>

              <button
                className="account-menu-item"
                onClick={() => {
                  setOpen(false);
                  onSwitchProject();
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
                Switch project
              </button>
            </div>

            {/* Plan & billing — current plan name + cloud-actions usage + an
                Upgrade/Change plan action (reuses the existing checkout). Cloud,
                signed-in only. */}
            {signedIn && activeWorkspace && (
              <div className="account-menu-sec">
                <div className="account-menu-label">Plan &amp; billing</div>
                <button
                  className="account-menu-item"
                  onClick={() => {
                    setOpen(false);
                    setShowPlan(true);
                  }}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                    <line x1="1" y1="10" x2="23" y2="10" />
                  </svg>
                  {planLabel(activeWorkspace)} plan · manage
                </button>
              </div>
            )}

            {/* Appearance — dark-mode toggle (the only user-adjustable option). */}
            {onToggleTheme && (
              <div className="account-menu-sec">
                <div className="account-menu-label">Appearance</div>
                <button className="appearance-toggle" onClick={onToggleTheme}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                  <span>Dark mode</span>
                  <span className={`appearance-switch ${theme === "dark" ? "on" : ""}`}>
                    <span className="appearance-knob" />
                  </span>
                </button>
              </div>
            )}

            {/* Community — Discord invite (opens in the system browser). */}
            <div className="account-menu-sec">
              <button
                className="account-menu-item"
                onClick={() => openExternalUrl("https://discord.gg/xTEb65XQb")}
              >
                {DiscordIcon}
                <span>Join our community</span>
              </button>
            </div>

            {signedIn && (
              <div className="account-menu-sec">
                <SignOutButton onDone={() => setOpen(false)} />
              </div>
            )}

            <div className="account-menu-version">GTM Grid v{__APP_VERSION__}</div>
          </div>
        </>
      )}

      {/* Plan & billing settings panel (cloud, signed-in). Shows the plan name +
          cloud-actions usage and an Upgrade/Change plan action that opens the
          existing Autumn checkout. Lives outside the menu so it stays open after
          the menu closes. */}
      {showPlan && activeWorkspace && (
        <PlanBillingModal
          workspace={activeWorkspace}
          isAuthenticated={isAuthenticated}
          onClose={() => setShowPlan(false)}
        />
      )}
    </div>
  );
}

/**
 * Plan & billing settings modal: current plan + cloud-actions usage + an
 * Upgrade/Change plan action. Reuses the existing checkout infrastructure (the
 * `billing.checkout` action via the Effect `CheckoutService`, opening the Autumn
 * hosted URL in the system browser) and the shared {@link PlanGrid} card — it
 * does NOT reimplement billing.
 */
export function PlanBillingModal(props: {
  workspace: WorkspaceSummary;
  isAuthenticated: boolean;
  onClose: () => void;
}) {
  const { workspace, isAuthenticated, onClose } = props;

  // Opening this panel should always show the current plan: reconcile with Autumn
  // (writes back `currentPlanId`) then refetch `me`, so a manual upgrade in Autumn
  // or a just-completed checkout is reflected immediately.
  useEffect(() => {
    void syncWorkspacePlan(workspace._id);
  }, [workspace._id]);

  const checkoutLayer = useCheckoutLayer();

  const [showUpgrade, setShowUpgrade] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<SelectablePlan>("business");
  const [billing, setBilling] = useState<BillingCycle>("monthly");
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const startUpgrade = useCallback(async () => {
    if (upgrading || selectedPlan === "free") return;
    setUpgrading(true);
    setUpgradeError(null);
    try {
      const planId = resolvePlanId(selectedPlan, billing);
      await runCheckout(
        isAuthenticated,
        { workspaceId: workspace._id, planId },
        checkoutLayer,
      );
    } catch (e) {
      setUpgradeError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setUpgrading(false);
    }
  }, [upgrading, selectedPlan, billing, isAuthenticated, workspace._id, checkoutLayer]);

  const { used, limit } = workspace.cloudActions;
  const usageLabel =
    limit === null ? `${used}` : `${used} / ${limit}`;
  const isFree = selectedPlan === "free";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal" srTitle="Plan & billing" style={{ width: 460 }}>
        <div className="modal-header">
          <span className="modal-title">Plan &amp; billing</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Current plan</label>
            <div className="account-menu-current">
              <div className="account-menu-current-text">
                <span className="account-menu-current-name">
                  {planLabel(workspace)}
                </span>
                <span className="account-menu-current-path">
                  {workspace.name}
                </span>
              </div>
              <span className="free-badge" title={`${planLabel(workspace)} plan`}>
                {planLabel(workspace).toUpperCase()}
              </span>
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">Cloud actions used</label>
            <div style={{ fontSize: 13, color: "var(--text-2)" }}>
              <span className="import-mono">{usageLabel}</span>{" "}
              {limit === null ? "actions" : "actions this period"}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setUpgradeError(null);
              setShowUpgrade(true);
            }}
          >
            Upgrade / change plan
          </button>
        </div>

      {/* Plan-selection modal — the SHARED PlanGrid + the existing checkout. */}
      {showUpgrade && (
        <Dialog open onOpenChange={(o) => { if (!o) setShowUpgrade(false); }}>
          <DialogContent className="modal gtm-onboarding-modal" srTitle="Choose a plan" style={{ width: 900, maxWidth: "94vw" }}>
            <div className="modal-header">
              <span className="modal-title">Choose a plan</span>
              <BillingToggle billing={billing} onChange={setBilling} />
              <button
                className="modal-close"
                onClick={() => setShowUpgrade(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body gtm-onboarding">
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-2)" }}>
                Per-seat, for your whole team. Checkout opens in your browser;
                complete it to unlock more cloud actions, multiplayer and sync.
              </p>
              <PlanGrid
                billing={billing}
                selected={selectedPlan}
                onSelect={setSelectedPlan}
              />
              {upgradeError && (
                <div className="account-menu-error" role="alert" style={{ marginTop: 12 }}>
                  {upgradeError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-outline"
                onClick={() => setShowUpgrade(false)}
              >
                Close
              </button>
              <button
                className="btn btn-primary"
                onClick={startUpgrade}
                disabled={isFree || upgrading}
                title={isFree ? "Free needs no checkout" : undefined}
              >
                {upgrading
                  ? "Opening checkout…"
                  : isFree
                    ? "Free — no checkout"
                    : "Continue to checkout"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </DialogContent>
    </Dialog>
  );
}

/** The workspace list + active selection + "Create workspace". */
function WorkspaceSwitcher(props: {
  workspaces: readonly WorkspaceSummary[];
  activeId: Id<"workspaces"> | null;
  onSelect: (id: Id<"workspaces">) => void;
}) {
  const { workspaces, activeId, onSelect } = props;
  const createWorkspace = useCreateWorkspace();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const id = await createWorkspace(trimmed);
      onSelect(id);
      setName("");
      setCreating(false);
    } finally {
      setBusy(false);
    }
  }, [name, busy, createWorkspace, onSelect]);

  return (
    <div className="account-menu-sec">
      <div className="account-menu-label">Workspaces</div>
      {workspaces.length === 0 && (
        <div className="account-menu-current">
          <div className="account-menu-current-text">
            <span className="account-menu-current-path">No workspaces yet</span>
          </div>
        </div>
      )}
      {workspaces.map((ws) => (
        <button
          key={ws._id}
          className="account-menu-item"
          onClick={() => onSelect(ws._id)}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: ws._id === activeId ? 1 : 0 }}
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {ws.name}
        </button>
      ))}

      {creating ? (
        <form
          className="account-menu-create"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            autoFocus
            className="account-menu-input"
            placeholder="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <button className="account-menu-item" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </form>
      ) : (
        <button
          className="account-menu-item"
          onClick={() => setCreating(true)}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create workspace
        </button>
      )}
    </div>
  );
}

/**
 * The OAuth buttons (C17 / C29) — one per ENABLED provider. Renders nothing when
 * no provider is enabled, so the caller can also hide the divider. The web build
 * uses the Convex Auth redirect; the packaged Tauri app uses the native
 * deep-link flow — `signInWithProvider` selects the branch by runtime.
 */
function OAuthButtons(props: {
  providers: readonly OAuthProvider[];
  onError: (message: string) => void;
}) {
  const { providers, onError } = props;
  const { signInWithProvider } = useAccountActions();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  const start = useCallback(
    async (provider: OAuthProvider) => {
      if (busy !== null) return;
      setBusy(provider);
      try {
        // Web: navigates away to the provider and returns via the Convex
        // callback. Desktop (C29): opens the provider in the system browser and
        // completes via the deep-link callback. No inline success path either way.
        await signInWithProvider(provider);
      } catch (e) {
        onError(e instanceof Error ? e.message : "OAuth sign-in failed");
        setBusy(null);
      }
    },
    [busy, signInWithProvider, onError],
  );

  return (
    <>
      {providers.map((provider) => (
        <button
          key={provider}
          className="account-menu-item"
          type="button"
          disabled={busy !== null}
          onClick={() => void start(provider)}
        >
          {provider === "google" ? <Google s={15} /> : <GitHub s={15} />}
          {busy === provider
            ? "Redirecting…"
            : `Continue with ${provider === "google" ? "Google" : "GitHub"}`}
        </button>
      ))}
    </>
  );
}

/** Email + password sign-in / sign-up + OAuth (the providers on the backend). */
function SignInSection(props: { onDone: () => void }) {
  const { signInWithPassword } = useAccountActions();
  const providers = useEnabledProviders();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithPassword(email.trim(), password, flow);
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }, [busy, email, password, flow, signInWithPassword, props]);

  return (
    <div className="account-menu-sec">
      <div className="account-menu-label">
        {flow === "signIn" ? "Sign in" : "Create account"}
      </div>
      {/* OAuth (C17): only when a provider is enabled per the backend query;
          otherwise the whole block (buttons + divider) is omitted. */}
      {providers.length > 0 && (
        <>
          <OAuthButtons providers={providers} onError={setError} />
          <div className="account-menu-oauth-divider">or with email</div>
        </>
      )}
      <form
        className="account-menu-create"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="account-menu-input"
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
        <input
          className="account-menu-input"
          type="password"
          placeholder="Password"
          autoComplete={flow === "signIn" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        {error && <div className="account-menu-error">{error}</div>}
        <button className="account-menu-item" type="submit" disabled={busy}>
          {busy
            ? "…"
            : flow === "signIn"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>
      <button
        className="account-menu-item account-menu-link"
        onClick={() => {
          setError(null);
          setFlow((f) => (f === "signIn" ? "signUp" : "signIn"));
        }}
      >
        {flow === "signIn"
          ? "Need an account? Sign up"
          : "Have an account? Sign in"}
      </button>
    </div>
  );
}

/** Sign out of the cloud session. */
function SignOutButton(props: { onDone: () => void }) {
  const { signOut } = useAccountActions();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="account-menu-item"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signOut();
          props.onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      Sign out
    </button>
  );
}
