/**
 * Full-screen cloud onboarding + plan-selection flow (C28) — plain React.
 *
 * Recreates the design's "Login & Workspace Flow" (split layout: a left form pane
 * + a right live mini-grid preview) pixel-faithfully, with the PRIMARY brand-red
 * accent, and WIRES every step to the real Convex backend:
 *
 *   1. Sign in / 2. Sign up → Convex auth (useAccountActions),
 *   3. Create workspace   → createWorkspace mutation (live slug preview),
 *   4. Invite team        → inviteMember per row + live seat count,
 *   5. Plan select        → OUR real catalog; PAID → Stripe/Autumn checkout via
 *      the existing Convex billing.checkout action (no custom card form),
 *   6. Connect AI key     → saveCredential (workspace BYO key),
 *   7. Done               → enter the app.
 *
 * Logic (the screen state machine, plan/billing → planId, checkout routing) lives
 * in ./flow-logic (pure / Effect, unit-tested); this file is presentation + event
 * wiring only. OAuth buttons render per the design but are DISABLED ("Coming
 * soon") — native deep-link OAuth is deferred (#17). The flow is fully
 * dismissible back to the local app (local-first preserved).
 */

import { useCallback, useMemo, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { Effect, Layer } from "effect";
import { type BillingCycle, type PaidPlanId } from "@gtmgrid/cloud";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { LogoMark } from "../../Logo";
import {
  useAccountActions,
  useEnabledProviders,
  type OAuthProvider,
} from "../auth";
import {
  CheckoutError,
  CheckoutRunner,
  CheckoutService,
  CheckoutServiceLive,
  type CheckoutActionResult,
} from "../checkout";
import {
  CredentialError,
  CredentialSaver,
  CredentialService,
  CredentialServiceLive,
  aiProviderCredId,
  runSaveCredential,
} from "../credentials";
import { UrlOpenerLive } from "../invite";
import {
  backScreen,
  nextScreen,
  OnboardingCheckoutService,
  OnboardingCheckoutServiceLive,
  type OnboardingScreen,
  runOnboardingPlanContinue,
  type SelectablePlan,
  seatCount,
  slugify,
} from "./flow-logic";
import { PlanGrid, BillingToggle } from "./PlanGrid";
import { PreviewPane } from "./PreviewPane";
import {
  ArrowLeft,
  ArrowRight,
  Card,
  Check,
  ChevronDown,
  Cpu,
  GitHub,
  Globe,
  Google,
  Key,
  Lock,
  Mail,
  Plus,
  Shield,
  Table,
  Users,
  X,
} from "./icons";
import "./onboarding.css";

type AiProvider = "anthropic" | "openai";
/** Invite-row role — matches the REAL backend roles (no invented editor/viewer). */
type InviteRole = "member" | "admin";
interface InviteRow {
  value: string;
  role: InviteRole;
}

/** All flow state in one object so the preview pane + screens share it. */
interface FlowState {
  ownerName: string;
  email: string;
  password: string;
  workspaceName: string;
  slug: string;
  slugTouched: boolean;
  invites: InviteRow[];
  plan: SelectablePlan;
  billing: BillingCycle;
  provider: AiProvider;
  apiKey: string;
  /** The Convex workspace id once created (so invite/checkout/key can target it). */
  workspaceId: Id<"workspaces"> | null;
}

const INITIAL: FlowState = {
  ownerName: "",
  email: "",
  password: "",
  workspaceName: "",
  slug: "",
  slugTouched: false,
  invites: [{ value: "", role: "member" }],
  plan: "free",
  billing: "monthly",
  provider: "anthropic",
  apiKey: "",
  workspaceId: null,
};

interface OnboardingFlowProps {
  /** Where the wizard starts: the auth entry, or the first-run workspace step. */
  initialScreen: OnboardingScreen;
  /** Whether a Convex session already exists (skip auth on first-run). */
  hasSession: boolean;
  /** Dismiss the flow back to the local app (local-first opt-out). */
  onClose: () => void;
  /** Called when setup completes; the app enters with this workspace selected. */
  onDone: (workspaceId: Id<"workspaces"> | null) => void;
}

/** The shared left-pane scaffold: wordmark topbar, body card, optional footer. */
function Pane(props: {
  topbarRight?: React.ReactNode;
  wide?: boolean;
  bleed?: boolean;
  footer?: React.ReactNode;
  screenKey: string;
  children: React.ReactNode;
}) {
  const { topbarRight, wide, bleed, footer, screenKey, children } = props;
  return (
    <>
      <div className="ob-form-topbar">
        <LogoMark size={24} />
        <span className="ob-wordmark">gtm grid</span>
        <span className="ob-spacer" />
        {topbarRight}
      </div>
      <div className={`ob-form-body${bleed ? " bleed" : ""}`}>
        <div
          className={`ob-form-card ob-screen-enter${wide ? " wide" : ""}${
            bleed ? " bleed" : ""
          }`}
          key={screenKey}
        >
          {children}
        </div>
      </div>
      {footer && (
        <div className={`ob-form-footer${bleed ? " bleed" : ""}`}>{footer}</div>
      )}
    </>
  );
}

/** The 4-step wizard rail (Workspace / Team / Plan / AI key). */
function StepRail({ step }: { step: 1 | 2 | 3 | 4 }) {
  const nodes = [
    { n: 1, label: "Workspace" },
    { n: 2, label: "Team" },
    { n: 3, label: "Plan" },
    { n: 4, label: "AI key" },
  ] as const;
  return (
    <div className="ob-step-rail">
      {nodes.map((node, i) => (
        <span className="ob-rail-node-wrap" key={node.n}>
          {i > 0 && (
            <span className={`ob-seg${step > node.n - 1 ? " done" : ""}`} />
          )}
          <span className="ob-node">
            <span
              className={`ob-dot ${
                step > node.n ? "done" : step === node.n ? "current" : ""
              }`}
            >
              {step > node.n ? <Check s={12} /> : node.n}
            </span>
            <span className={`ob-label${step === node.n ? " active" : ""}`}>
              {node.label}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * OAuth row (C17) — one ENABLED button per provider configured on the backend,
 * using the standard Convex Auth web redirect flow. Renders nothing (so the
 * caller can also hide the "or with email" divider) when no provider is enabled,
 * keeping the screen clean before any OAuth app is configured.
 *
 * NOTE: this is the web/browser redirect path. The native Tauri deep-link
 * callback for the packaged app is the remaining follow-up (task #17).
 */
function OAuthRow(props: {
  verb: string;
  providers: readonly OAuthProvider[];
  onError: (message: string) => void;
}) {
  const { verb, providers, onError } = props;
  const { signInWithProvider } = useAccountActions();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  if (providers.length === 0) return null;

  const start = async (provider: OAuthProvider) => {
    if (busy !== null) return;
    setBusy(provider);
    try {
      // Redirects away to the provider and returns via the Convex callback, so
      // there is no inline success path to handle here.
      await signInWithProvider(provider);
    } catch (e) {
      onError(e instanceof Error ? e.message : "OAuth sign-in failed.");
      setBusy(null);
    }
  };

  return (
    <div className="ob-oauth-row">
      {providers.map((provider) => (
        <button
          key={provider}
          className="ob-oauth-btn"
          type="button"
          disabled={busy !== null}
          onClick={() => void start(provider)}
        >
          {provider === "google" ? <Google s={16} /> : <GitHub s={16} />}{" "}
          {busy === provider
            ? "Redirecting…"
            : `${verb} with ${provider === "google" ? "Google" : "GitHub"}`}
        </button>
      ))}
    </div>
  );
}

export function OnboardingFlow(props: OnboardingFlowProps) {
  const { initialScreen, hasSession, onClose, onDone } = props;
  const [screen, setScreen] = useState<OnboardingScreen>(initialScreen);
  const [state, setStateRaw] = useState<FlowState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((patch: Partial<FlowState>) => {
    setStateRaw((s) => ({ ...s, ...patch }));
  }, []);
  const go = useCallback((next: OnboardingScreen) => {
    setError(null);
    setScreen(next);
  }, []);

  // ── Real backend bindings ───────────────────────────────────────────────
  const { signInWithPassword } = useAccountActions();
  // Enabled OAuth providers (C17): drives the OAuth row on the auth screens.
  const providers = useEnabledProviders();
  const createWorkspace = useMutation(api.workspaces.createWorkspace);
  const inviteAction = useAction(api.workspaces.inviteMember);
  const checkoutAction = useAction(api.billing.checkout);
  const saveCredentialAction = useAction(api.credentials.saveCredential);

  // Compose the onboarding checkout Layer once (reuses the C27 CheckoutService +
  // shared system-browser opener). Stable across renders via useMemo.
  const checkoutLayer = useMemo<Layer.Layer<OnboardingCheckoutService>>(
    () =>
      OnboardingCheckoutServiceLive.pipe(
        Layer.provide(
          CheckoutServiceLive.pipe(
            Layer.provide(
              Layer.succeed(CheckoutRunner, {
                checkout: (args) =>
                  Effect.tryPromise({
                    try: () =>
                      checkoutAction({
                        workspaceId: args.workspaceId as Id<"workspaces">,
                        planId: args.planId,
                      }) as Promise<CheckoutActionResult>,
                    catch: (cause) =>
                      new CheckoutError({
                        message:
                          cause instanceof Error
                            ? cause.message
                            : "Checkout failed.",
                        cause,
                      }),
                  }),
              } satisfies typeof CheckoutRunner.Service),
            ),
            Layer.provide(UrlOpenerLive),
          ),
        ),
      ),
    [checkoutAction],
  );

  // The cloud credential-save Layer (workspace-scoped BYO key, T11).
  const credentialLayer = useMemo<Layer.Layer<CredentialService>>(
    () =>
      CredentialServiceLive.pipe(
        Layer.provide(
          Layer.succeed(CredentialSaver, {
            save: (input) =>
              Effect.tryPromise({
                try: () =>
                  saveCredentialAction({
                    workspaceId: input.workspaceId as Id<"workspaces">,
                    extensionId: input.extensionId,
                    scope: input.scope,
                    name: input.name,
                    secrets: input.secrets,
                  }) as Promise<Id<"credentials">>,
                catch: (cause) =>
                  new CredentialError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Could not save the key.",
                    cause,
                  }),
              }).pipe(Effect.asVoid),
          } satisfies typeof CredentialSaver.Service),
        ),
      ),
    [saveCredentialAction],
  );

  // ── Step handlers (real backend) ────────────────────────────────────────

  const submitAuth = useCallback(
    async (flow: "signIn" | "signUp") => {
      if (busy || !state.email.trim() || !state.password) return;
      setBusy(true);
      setError(null);
      try {
        await signInWithPassword(state.email.trim(), state.password, flow);
        go("workspace");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Authentication failed.");
      } finally {
        setBusy(false);
      }
    },
    [busy, state.email, state.password, signInWithPassword, go],
  );

  const submitWorkspace = useCallback(async () => {
    const name = state.workspaceName.trim();
    if (busy || !name) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createWorkspace({ name });
      set({ workspaceId: id });
      go("invite");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create workspace.");
    } finally {
      setBusy(false);
    }
  }, [busy, state.workspaceName, createWorkspace, set, go]);

  const submitInvites = useCallback(async () => {
    if (busy) return;
    const wid = state.workspaceId;
    const rows = state.invites.filter((i) => i.value.trim().length > 0);
    if (wid === null || rows.length === 0) {
      go("plan");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Invite each row against the REAL inviteMember action. The action gates on
      // seats; an over-limit result returns a checkout URL we surface in the plan
      // step rather than blocking onboarding here.
      for (const row of rows) {
        await inviteAction({
          workspaceId: wid,
          userId: row.value.trim(),
          role: row.role,
        });
      }
      go("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send invites.");
    } finally {
      setBusy(false);
    }
  }, [busy, state.workspaceId, state.invites, inviteAction, go]);

  const continueFromPlan = useCallback(async () => {
    if (busy) return;
    const wid = state.workspaceId;
    setBusy(true);
    setError(null);
    try {
      // Free → no checkout; paid → resolves the (tier, billing) plan id and opens
      // the Stripe/Autumn hosted checkout in the system browser. Either way we
      // advance to the AI-key step (a paid subscription completes out-of-band).
      await runOnboardingPlanContinue(
        {
          hasSession: true,
          workspaceId: wid ?? "",
          plan: state.plan,
          billing: state.billing,
        },
        checkoutLayer,
      );
      go("connect");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout.");
    } finally {
      setBusy(false);
    }
  }, [busy, state.workspaceId, state.plan, state.billing, checkoutLayer, go]);

  const submitKey = useCallback(async () => {
    if (busy) return;
    const wid = state.workspaceId;
    const key = state.apiKey.trim();
    // No key entered → skip; nothing to save.
    if (wid === null || key.length === 0) {
      go("done");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await runSaveCredential(
        true,
        {
          workspaceId: wid,
          extensionId: aiProviderCredId(state.provider),
          scope: "workspace",
          name: state.provider === "openai" ? "OpenAI" : "Anthropic",
          secrets: { apiKey: key },
        },
        credentialLayer,
      );
      go("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the key.");
    } finally {
      setBusy(false);
    }
  }, [busy, state.workspaceId, state.apiKey, state.provider, credentialLayer, go]);

  const seats = seatCount(state.invites);

  // ── Screen rendering ────────────────────────────────────────────────────
  const wizardScreen = ["workspace", "invite", "plan", "connect"].includes(
    screen,
  );
  const bleed = screen === "plan";

  return (
    <div className="gtm-onboarding">
      <div
        className={`ob-flow-shell${wizardScreen ? " wizard" : ""}${
          bleed ? " fullbleed" : ""
        }`}
      >
        <div className="ob-form-pane">
          {/* Dismiss back to local — always available (local-first opt-out). */}
          <button
            className="ob-dismiss"
            onClick={onClose}
            title="Continue without an account (local only)"
            aria-label="Close onboarding"
          >
            <X s={16} />
          </button>

          {screen === "signin" && (
            <SignIn
              state={state}
              set={set}
              busy={busy}
              error={error}
              providers={providers}
              onError={setError}
              onSubmit={() => void submitAuth("signIn")}
              onGoSignup={() => go("signup")}
              onSkip={onClose}
            />
          )}
          {screen === "signup" && (
            <SignUp
              state={state}
              set={set}
              busy={busy}
              error={error}
              providers={providers}
              onError={setError}
              onSubmit={() => void submitAuth("signUp")}
              onGoSignin={() => go("signin")}
            />
          )}
          {screen === "workspace" && (
            <CreateWorkspace
              state={state}
              set={set}
              busy={busy}
              error={error}
              onBack={() => go(hasSession ? "signin" : backScreen("workspace"))}
              onContinue={() => void submitWorkspace()}
              canBack={!hasSession}
            />
          )}
          {screen === "invite" && (
            <InviteTeam
              state={state}
              set={set}
              busy={busy}
              error={error}
              seats={seats}
              onBack={() => go("workspace")}
              onContinue={() => void submitInvites()}
            />
          )}
          {screen === "plan" && (
            <PlanSelect
              state={state}
              set={set}
              busy={busy}
              error={error}
              seats={seats}
              onBack={() => go("invite")}
              onContinue={() => void continueFromPlan()}
            />
          )}
          {screen === "connect" && (
            <ConnectKey
              state={state}
              set={set}
              busy={busy}
              error={error}
              onBack={() => go("plan")}
              onContinue={() => void submitKey()}
            />
          )}
          {screen === "done" && (
            <Done
              state={state}
              seats={seats}
              onEnter={() => onDone(state.workspaceId)}
            />
          )}
        </div>

        {!bleed && (
          <PreviewPane
            screen={screen}
            workspaceName={state.workspaceName}
            ownerName={state.ownerName || state.email}
            invites={state.invites}
            provider={state.provider}
            keyEntered={state.apiKey.trim().length > 0}
          />
        )}
      </div>
    </div>
  );
}

// ── Screen 1 · Sign in ─────────────────────────────────────────────────────
function SignIn(props: {
  state: FlowState;
  set: (p: Partial<FlowState>) => void;
  busy: boolean;
  error: string | null;
  providers: readonly OAuthProvider[];
  onError: (message: string) => void;
  onSubmit: () => void;
  onGoSignup: () => void;
  onSkip: () => void;
}) {
  const { state, set, busy, error, providers, onError, onSubmit, onGoSignup, onSkip } =
    props;
  return (
    <Pane
      screenKey="signin"
      topbarRight={
        <span className="ob-topbar-link">
          New here? <a onClick={onGoSignup}>Create account</a>
        </span>
      }
    >
      <div className="ob-eyebrow">Welcome back</div>
      <h1 className="ob-screen-title">Sign in to gtm grid</h1>
      <p className="ob-screen-sub">
        Pick up where you left off — your tables, connections and runs are
        waiting.
      </p>

      <OAuthRow verb="Continue" providers={providers} onError={onError} />
      {providers.length > 0 && <div className="ob-divider">or with email</div>}

      <div className="ob-field">
        <label className="ob-field-label">Work email</label>
        <TextInput
          type="email"
          placeholder="you@company.com"
          iconLeft={<Mail s={15} />}
          value={state.email}
          onChange={(v) => set({ email: v })}
        />
      </div>
      <div className="ob-field">
        <label className="ob-field-label">Password</label>
        <TextInput
          type="password"
          placeholder="••••••••••"
          iconLeft={<Lock s={14} />}
          value={state.password}
          onChange={(v) => set({ password: v })}
          onEnter={onSubmit}
        />
      </div>

      {error && <div className="ob-error">{error}</div>}

      <button
        className="ob-btn ob-btn-primary ob-btn-lg ob-btn-block"
        disabled={busy}
        onClick={onSubmit}
      >
        {busy ? "Signing in…" : "Sign in"} <ArrowRight s={15} />
      </button>

      <p className="ob-fineprint">
        Solo &amp; offline? You don't need an account —{" "}
        <a onClick={onSkip}>just keep using the desktop app</a>. Sign in is for
        cloud sync &amp; realtime teams.
      </p>
    </Pane>
  );
}

// ── Screen 2 · Sign up ─────────────────────────────────────────────────────
function SignUp(props: {
  state: FlowState;
  set: (p: Partial<FlowState>) => void;
  busy: boolean;
  error: string | null;
  providers: readonly OAuthProvider[];
  onError: (message: string) => void;
  onSubmit: () => void;
  onGoSignin: () => void;
}) {
  const { state, set, busy, error, providers, onError, onSubmit, onGoSignin } =
    props;
  return (
    <Pane
      screenKey="signup"
      topbarRight={
        <span className="ob-topbar-link">
          Have an account? <a onClick={onGoSignin}>Sign in</a>
        </span>
      }
    >
      <div className="ob-eyebrow">Get started</div>
      <h1 className="ob-screen-title">Create your account</h1>
      <p className="ob-screen-sub">
        Free to start. Spin up a cloud workspace, invite your team, and keep
        execution local.
      </p>

      <OAuthRow verb="Sign up" providers={providers} onError={onError} />
      {providers.length > 0 && <div className="ob-divider">or with email</div>}

      <div className="ob-field">
        <label className="ob-field-label">Full name</label>
        <TextInput
          placeholder="Max Mitchell"
          value={state.ownerName}
          onChange={(v) => set({ ownerName: v })}
        />
      </div>
      <div className="ob-field">
        <label className="ob-field-label">Work email</label>
        <TextInput
          type="email"
          placeholder="you@company.com"
          iconLeft={<Mail s={15} />}
          value={state.email}
          onChange={(v) => set({ email: v })}
        />
      </div>
      <div className="ob-field">
        <label className="ob-field-label">Password</label>
        <TextInput
          type="password"
          placeholder="At least 8 characters"
          iconLeft={<Lock s={14} />}
          value={state.password}
          onChange={(v) => set({ password: v })}
          onEnter={onSubmit}
        />
        <div className="ob-field-hint">
          Use 8+ characters with a mix of letters, numbers &amp; symbols.
        </div>
      </div>

      {error && <div className="ob-error">{error}</div>}

      <button
        className="ob-btn ob-btn-primary ob-btn-lg ob-btn-block"
        disabled={busy}
        onClick={onSubmit}
      >
        {busy ? "Creating…" : "Create account"} <ArrowRight s={15} />
      </button>
    </Pane>
  );
}

// ── Screen 3 · Create workspace ────────────────────────────────────────────
function CreateWorkspace(props: {
  state: FlowState;
  set: (p: Partial<FlowState>) => void;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onContinue: () => void;
  canBack: boolean;
}) {
  const { state, set, busy, error, onBack, onContinue, canBack } = props;
  const onName = (name: string) =>
    set({
      workspaceName: name,
      slug: state.slugTouched ? state.slug : slugify(name),
    });
  return (
    <Pane
      screenKey="workspace"
      wide
      footer={
        <>
          {canBack ? (
            <button className="ob-btn ob-btn-ghost" onClick={onBack}>
              <ArrowLeft s={14} /> Back
            </button>
          ) : (
            <span />
          )}
          <span className="ob-foot-spacer" />
          <button
            className="ob-btn ob-btn-primary ob-btn-lg"
            disabled={busy || !state.workspaceName.trim()}
            onClick={onContinue}
          >
            {busy ? "Creating…" : "Continue"} <ArrowRight s={15} />
          </button>
        </>
      }
    >
      <StepRail step={1} />
      <div className="ob-eyebrow">
        <span className="ob-step-num">Step 1 / 4</span> · Workspace
      </div>
      <h1 className="ob-screen-title">Name your workspace</h1>
      <p className="ob-screen-sub">
        This is where your team's tables, connections and runs live. You can
        rename it anytime.
      </p>

      <div className="ob-field">
        <label className="ob-field-label">Workspace name</label>
        <TextInput
          placeholder="Trigify GTM"
          iconLeft={<Table s={14} />}
          value={state.workspaceName}
          onChange={onName}
        />
      </div>

      <div className="ob-field">
        <label className="ob-field-label">Workspace URL</label>
        <div className="ob-slug-input">
          <span className="ob-prefix">gtmgrid.app/</span>
          <input
            value={state.slug}
            placeholder="your-team"
            onChange={(e) =>
              set({ slug: slugify(e.target.value), slugTouched: true })
            }
          />
        </div>
        <div className="ob-field-hint">
          Used for invite links and realtime sync. Lowercase letters, numbers and
          hyphens.
        </div>
      </div>

      {error && <div className="ob-error">{error}</div>}

      <div className="ob-note">
        <span className="ob-note-ico ok">
          <Shield s={15} />
        </span>
        <span className="ob-note-text">
          <strong>Cloud sync &amp; multiplayer</strong> are billed per seat. The
          free solo tier always stays 100% local.
        </span>
      </div>
    </Pane>
  );
}

// ── Screen 4 · Invite team ─────────────────────────────────────────────────
const ROLES = ["member", "admin"] as const;
function InviteTeam(props: {
  state: FlowState;
  set: (p: Partial<FlowState>) => void;
  busy: boolean;
  error: string | null;
  seats: number;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { state, set, busy, error, seats, onBack, onContinue } = props;
  const setInvite = (i: number, patch: Partial<InviteRow>) =>
    set({
      invites: state.invites.map((inv, idx) =>
        idx === i ? { ...inv, ...patch } : inv,
      ),
    });
  const addInvite = () =>
    set({ invites: [...state.invites, { value: "", role: "member" }] });
  const removeInvite = (i: number) =>
    set({ invites: state.invites.filter((_, idx) => idx !== i) });

  return (
    <Pane
      screenKey="invite"
      wide
      footer={
        <>
          <button className="ob-btn ob-btn-ghost" onClick={onBack}>
            <ArrowLeft s={14} /> Back
          </button>
          <span className="ob-foot-meta">
            <span className="ob-mono">{seats}</span> seat{seats !== 1 ? "s" : ""}
          </span>
          <span className="ob-foot-spacer" />
          <button className="ob-foot-skip" onClick={onContinue} disabled={busy}>
            Skip for now
          </button>
          <button
            className="ob-btn ob-btn-primary ob-btn-lg"
            disabled={busy}
            onClick={onContinue}
          >
            {busy ? "Inviting…" : "Continue"} <ArrowRight s={15} />
          </button>
        </>
      }
    >
      <StepRail step={2} />
      <div className="ob-eyebrow">
        <span className="ob-step-num">Step 2 / 4</span> · Team
      </div>
      <h1 className="ob-screen-title">Invite your team</h1>
      <p className="ob-screen-sub">
        gtm grid is multiplayer — collaborators edit the same grid in realtime.
        Execution still runs locally on each machine.
      </p>

      <div className="ob-invite-list">
        {state.invites.map((inv, i) => (
          <div className="ob-invite-row" key={i}>
            <div className="ob-email-wrap">
              <TextInput
                placeholder="teammate user id"
                value={inv.value}
                onChange={(v) => setInvite(i, { value: v })}
              />
            </div>
            <div className="ob-role-select">
              <select
                value={inv.role}
                onChange={(e) =>
                  setInvite(i, {
                    role: e.target.value === "admin" ? "admin" : "member",
                  })
                }
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <span className="ob-chev">
                <ChevronDown s={13} />
              </span>
            </div>
            <button
              className="ob-icon-x-btn"
              title="Remove"
              onClick={() => removeInvite(i)}
            >
              <X s={14} />
            </button>
          </div>
        ))}
      </div>

      <button className="ob-add-line" onClick={addInvite}>
        <Plus s={14} /> Add another
      </button>

      {error && <div className="ob-error">{error}</div>}

      <div className="ob-note">
        <span className="ob-note-ico subtle">
          <Globe s={15} />
        </span>
        <span className="ob-note-text">
          Invite teammates by their gtm grid user id — anyone with{" "}
          <span className="ob-mono">@{state.slug || "your-team"}</span> can join
          your workspace.
        </span>
      </div>
    </Pane>
  );
}

// ── Screen 5 · Plan select ─────────────────────────────────────────────────
function PlanSelect(props: {
  state: FlowState;
  set: (p: Partial<FlowState>) => void;
  busy: boolean;
  error: string | null;
  seats: number;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { state, set, busy, error, seats, onBack, onContinue } = props;
  const isFree = state.plan === "free";
  return (
    <Pane
      screenKey="plan"
      bleed
      footer={
        <>
          <button className="ob-btn ob-btn-ghost" onClick={onBack}>
            <ArrowLeft s={14} /> Back
          </button>
          <span className="ob-foot-meta">
            <span className="ob-mono">{seats}</span> seat{seats !== 1 ? "s" : ""}
            {!isFree && (
              <>
                {" "}
                ·{" "}
                <span className="ob-foot-secure">
                  <Lock s={12} /> Secured by Stripe · cancel anytime
                </span>
              </>
            )}
          </span>
          <span className="ob-foot-spacer" />
          <button
            className="ob-btn ob-btn-primary ob-btn-lg"
            disabled={busy}
            onClick={onContinue}
          >
            {busy
              ? "Working…"
              : isFree
                ? "Continue on Free"
                : "Continue to checkout"}{" "}
            <ArrowRight s={15} />
          </button>
        </>
      }
    >
      <StepRail step={3} />
      <div className="ob-eyebrow">
        <span className="ob-step-num">Step 3 / 4</span> · Plan
      </div>
      <div className="ob-plan-head">
        <div>
          <h1 className="ob-screen-title">Choose your plan</h1>
          <p className="ob-screen-sub" style={{ marginBottom: 0 }}>
            Per-seat, for your whole team. Execution always stays local — you only
            pay for cloud sync &amp; collaboration.
          </p>
        </div>
        <BillingToggle
          billing={state.billing}
          onChange={(b) => set({ billing: b })}
        />
      </div>

      <PlanGrid
        billing={state.billing}
        selected={state.plan}
        onSelect={(id) => set({ plan: id })}
      />

      {error && <div className="ob-error">{error}</div>}
    </Pane>
  );
}

// ── Screen 6 · Connect AI key ──────────────────────────────────────────────
function ConnectKey(props: {
  state: FlowState;
  set: (p: Partial<FlowState>) => void;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { state, set, busy, error, onBack, onContinue } = props;
  const meta =
    state.provider === "openai"
      ? { ph: "sk-…", host: "api.openai.com" }
      : { ph: "sk-ant-…", host: "api.anthropic.com" };
  return (
    <Pane
      screenKey="connect"
      wide
      footer={
        <>
          <button className="ob-btn ob-btn-ghost" onClick={onBack}>
            <ArrowLeft s={14} /> Back
          </button>
          <span className="ob-foot-spacer" />
          <button className="ob-foot-skip" onClick={onContinue} disabled={busy}>
            I'll do this later
          </button>
          <button
            className="ob-btn ob-btn-primary ob-btn-lg"
            disabled={busy}
            onClick={onContinue}
          >
            {busy ? "Saving…" : "Finish setup"} <Check s={15} />
          </button>
        </>
      }
    >
      <StepRail step={4} />
      <div className="ob-eyebrow">
        <span className="ob-step-num">Step 4 / 4</span> · AI key
      </div>
      <h1 className="ob-screen-title">Connect your AI key</h1>
      <p className="ob-screen-sub">
        Bring your own key — gtm grid never proxies your prompts. Calls go
        straight from your machine to the provider.
      </p>

      <div className="ob-provider-tabs">
        <button
          className={`ob-provider-tab${
            state.provider === "anthropic" ? " active" : ""
          }`}
          onClick={() => set({ provider: "anthropic" })}
        >
          <span className="ob-pt-mark">A</span>
          <span className="ob-pt-text">
            <span className="ob-pt-name">Anthropic</span>
            <span className="ob-pt-sub">claude</span>
          </span>
        </button>
        <button
          className={`ob-provider-tab${
            state.provider === "openai" ? " active" : ""
          }`}
          onClick={() => set({ provider: "openai" })}
        >
          <span className="ob-pt-mark">O</span>
          <span className="ob-pt-text">
            <span className="ob-pt-name">OpenAI</span>
            <span className="ob-pt-sub">gpt</span>
          </span>
        </button>
      </div>

      <div className="ob-field">
        <label className="ob-field-label">
          API key <span className="ob-opt">· {meta.host}</span>
        </label>
        <TextInput
          mono
          type="password"
          placeholder={meta.ph}
          iconLeft={<Key s={14} />}
          value={state.apiKey}
          onChange={(v) => set({ apiKey: v })}
        />
      </div>

      {error && <div className="ob-error">{error}</div>}

      <div className="ob-note">
        <span className="ob-note-ico ok">
          <Shield s={15} />
        </span>
        <span className="ob-note-text">
          Stored <strong>encrypted</strong> for your workspace, shared with
          members. Execution stays local — the engine runs the sandbox &amp;
          connector calls on your machine.
        </span>
      </div>
    </Pane>
  );
}

// ── Screen 7 · Done ────────────────────────────────────────────────────────
function Done(props: {
  state: FlowState;
  seats: number;
  onEnter: () => void;
}) {
  const { state, seats, onEnter } = props;
  const provName = state.provider === "openai" ? "OpenAI" : "Anthropic";
  const planName =
    state.plan === "free"
      ? "Free"
      : state.plan === "team"
        ? "Team"
        : state.plan === "business"
          ? "Business"
          : "Unlimited";
  return (
    <Pane screenKey="done">
      <div className="ob-success-mark">
        <Check s={26} />
      </div>
      <div className="ob-eyebrow">Setup complete</div>
      <h1 className="ob-screen-title">Your workspace is ready</h1>
      <p className="ob-screen-sub">
        <span className="ob-mono">{state.workspaceName || "Your workspace"}</span>{" "}
        is live. The local engine handles sandboxing &amp; connector runs.
      </p>

      <div className="ob-summary-list">
        <div className="ob-summary-row">
          <span className="ob-sr-ico">
            <Table s={14} />
          </span>
          <span className="ob-sr-label">Workspace</span>
          <span className="ob-sr-val ob-mono">
            gtmgrid.app/{state.slug || "your-team"}
          </span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-sr-ico">
            <Users s={14} />
          </span>
          <span className="ob-sr-label">Team</span>
          <span className="ob-sr-val">
            {seats} seat{seats !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-sr-ico">
            <Card s={14} />
          </span>
          <span className="ob-sr-label">Plan</span>
          <span className="ob-sr-val">{planName}</span>
        </div>
        <div className="ob-summary-row">
          <span className="ob-sr-ico">
            <Cpu s={14} />
          </span>
          <span className="ob-sr-label">AI provider</span>
          <span className="ob-sr-val">
            {state.apiKey.trim() ? `${provName} · key set` : "Not connected"}
          </span>
        </div>
      </div>

      <button
        className="ob-btn ob-btn-primary ob-btn-lg ob-btn-block"
        onClick={onEnter}
      >
        Enter gtm grid <ArrowRight s={15} />
      </button>

      <p className="ob-fineprint">
        The engine runs locally — your data &amp; keys never leave your machine.
      </p>
    </Pane>
  );
}

// ── Small shared input (mirrors the design's DS Input) ─────────────────────
function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  iconLeft?: React.ReactNode;
  mono?: boolean;
  onEnter?: () => void;
}) {
  const { value, onChange, type, placeholder, iconLeft, mono, onEnter } = props;
  return (
    <div className={`ob-input${iconLeft ? " has-icon" : ""}`}>
      {iconLeft && <span className="ob-input-ico">{iconLeft}</span>}
      <input
        type={type ?? "text"}
        placeholder={placeholder}
        value={value}
        className={mono ? "ob-mono" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
      />
    </div>
  );
}
