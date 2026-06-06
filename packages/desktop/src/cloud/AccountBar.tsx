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

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cloudEnabled } from "./convex";
import {
  useAccountActions,
  useActiveWorkspace,
  useAuthState,
  useMe,
  type WorkspaceSummary,
} from "./auth";

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
  currentProjectPath: string | null;
  /** Open the local project switcher (unchanged local behaviour). */
  onSwitchProject: () => void;
  /** Refresh the current local project path when the menu opens. */
  onOpenMenu: () => void;
  /** Current appearance theme (for the dark-mode toggle). */
  theme?: "light" | "dark";
  /** Toggle the appearance theme; when provided, the Appearance section shows. */
  onToggleTheme?: () => void;
}

/**
 * The sidebar-footer account control + dropdown menu. Shows local project info
 * always; layers cloud auth + workspace switching on top when signed in.
 */
export function AccountBar(props: AccountBarProps) {
  const { projectName, healthStatus, currentProjectPath, onSwitchProject, onOpenMenu, theme, onToggleTheme } =
    props;
  const [open, setOpen] = useState(false);
  const me = useMe();
  const { isAuthenticated } = useAuthState();
  const { activeWorkspace, setActiveWorkspaceId } = useActiveWorkspace(me ?? null);

  const signedIn = cloudEnabled && isAuthenticated && me != null;
  const avatarLetter = signedIn
    ? (me!.user.name ?? me!.user.email ?? "?").slice(0, 1).toUpperCase()
    : projectName.slice(0, 1).toUpperCase();

  const openMenu = useCallback(() => {
    setOpen(true);
    onOpenMenu();
  }, [onOpenMenu]);

  return (
    <div className="account-bar">
      <button
        className="account-btn"
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="account-avatar">{avatarLetter}</span>
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
              <span className="account-avatar">{avatarLetter}</span>
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
              ) : (
                <SignInSection onDone={() => setOpen(false)} />
              ))}

            {/* Local project section — always present (local stays unchanged). */}
            <div className="account-menu-sec">
              <div className="account-menu-label">Local project</div>
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
                  <span className="account-menu-current-name">{projectName}</span>
                  {currentProjectPath && (
                    <span className="account-menu-current-path">
                      {currentProjectPath}
                    </span>
                  )}
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

            {signedIn && (
              <div className="account-menu-sec">
                <SignOutButton onDone={() => setOpen(false)} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The workspace list + active selection + "Create workspace". */
function WorkspaceSwitcher(props: {
  workspaces: readonly WorkspaceSummary[];
  activeId: Id<"workspaces"> | null;
  onSelect: (id: Id<"workspaces">) => void;
}) {
  const { workspaces, activeId, onSelect } = props;
  const createWorkspace = useMutation(api.workspaces.createWorkspace);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const id = await createWorkspace({ name: trimmed });
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

/** Email + password sign-in / sign-up (the active provider on the backend). */
function SignInSection(props: { onDone: () => void }) {
  const { signInWithPassword } = useAccountActions();
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
