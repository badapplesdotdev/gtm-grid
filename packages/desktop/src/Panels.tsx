// Detail panels rendered in the main area when an Extension or AI Provider
// is selected. Layout mirrors the connections design: a header, Personal/Team/
// Local scope tabs, a "CONNECTIONS" add-card, and collapsible info sections.

import { useState, useEffect, useCallback, ReactNode, type MouseEvent } from "react";
import { api, ExtensionDetail, ExtensionInfo, AiProviderInfo, CredentialScope, SkillInfo, SkillDetail } from "./api";
import { onActivateKey } from "./lib/utils";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { aiProviderCredId } from "./cloud/credentials";
import { Markdown } from "./AgentPanel";
import { BrandIcon } from "./BrandIcon";
import { apiClient } from "./cloud/client";
import { OAuthConnectCard, type OAuthCardStatus } from "./cloud/OAuthConnectCard";

/**
 * The scope a credential is saved under in the panels. Extends the local-only
 * {@link CredentialScope} (`personal`/`team`/`local`, machine-encrypted via the
 * sidecar) with `workspace` — a SHARED, server-encrypted key for cloud projects
 * (saved via Convex `saveCredential`, T7). `workspace` is offered only when a
 * workspace is active (signed in); the local scopes are always available and
 * keep their existing behaviour.
 */
export type PanelScope = CredentialScope | "workspace";

/**
 * Workspace (cloud, shared) credential context for a panel. When present a
 * "Workspace" scope tab is shown; saving under it calls {@link onSaveWorkspace}
 * (the Convex encrypted-save path) instead of the local sidecar. Absent for a
 * signed-out / local-only user, in which case panels behave exactly as before.
 */
export interface WorkspaceCredContext {
  /** True when a shared workspace key already exists for this connector. */
  readonly connected: boolean;
  /**
   * Save the plaintext key as a SHARED workspace credential (encrypted
   * server-side). Throws on failure so the form can surface the message.
   */
  readonly onSaveWorkspace: (apiKey: string) => Promise<void>;
  /**
   * Copy this connector's LOCAL key up to the shared Cloud key in one click. The
   * sidecar reveals the local plaintext in-process and saves it server-side — the
   * plaintext never enters the renderer. Present only when a cloud session is
   * available; the panel shows the affordance only when a local key also exists.
   * Throws on failure so the form can surface the message.
   */
  readonly copyLocalKey?: () => Promise<void>;
}

/**
 * App-level source for shared workspace credentials, threaded into the panels.
 * Present only when a workspace is active (signed in); each panel narrows it to a
 * per-connector {@link WorkspaceCredContext} via {@link workspaceCtxFor}.
 *
 * `connectedExtensionIds` is the set of credential keys (see
 * `aiProviderCredId` in ./cloud/credentials.ts for the AI namespacing) that
 * already have a shared workspace key, derived from the Convex `listCredentials`
 * query so the panel shows the connected indicator. `save` calls the Convex
 * encrypted-save path.
 */
export interface WorkspaceCredSource {
  readonly connectedExtensionIds: ReadonlySet<string>;
  readonly save: (
    extensionId: string,
    name: string,
    apiKey: string,
  ) => Promise<void>;
  /**
   * Copy a connector's LOCAL key (its full secret map) to the shared Cloud key,
   * via the sidecar (plaintext never enters the renderer). Present only when a
   * signed-in cloud session exists; `undefined` otherwise.
   */
  readonly copyLocalKey?: (extensionId: string, name: string) => Promise<void>;
}

/** Narrow an app-level {@link WorkspaceCredSource} to one connector's context. */
function workspaceCtxFor(
  source: WorkspaceCredSource | undefined,
  extensionId: string,
  name: string,
): WorkspaceCredContext | undefined {
  if (source === undefined) return undefined;
  return {
    connected: source.connectedExtensionIds.has(extensionId),
    onSaveWorkspace: (apiKey) => source.save(extensionId, name, apiKey),
    copyLocalKey: source.copyLocalKey
      ? () => source.copyLocalKey!(extensionId, name)
      : undefined,
  };
}

// ─── tiny inline icons ───────────────────────────────────

const I = {
  Lock: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  Globe: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 010 20 15 15 0 010-20" />
    </svg>
  ),
  Home: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><path d="M9 22V12h6v10" />
    </svg>
  ),
  Users: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  Plus: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  Caret: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  Back: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
    </svg>
  ),
  Search: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  X: ({ s = 16 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  Check: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  Tag: ({ s = 15 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L3 13V3h10l7.59 7.59a2 2 0 0 1 0 2.82z" /><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  Copy: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  Table: ({ s = 22 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" />
    </svg>
  ),
  Trash: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  Pencil: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  ),
  Star: ({ s = 14, filled = false }: { s?: number; filled?: boolean }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  More: ({ s = 15 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
    </svg>
  ),
  Sort: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h12M3 12h9M3 18h6M17 8V20M17 20l-3-3M17 20l3-3" />
    </svg>
  ),
  ChevronDown: ({ s = 11 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  ListView: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  GridView: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  CloudUp: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 16a4 4 0 0 0 0-8 5 5 0 0 0-9.6-1.5A3.5 3.5 0 0 0 6 16" /><polyline points="12 12 12 21" /><polyline points="9 15 12 12 15 15" />
    </svg>
  ),
};

// Two credential scopes the panels expose:
//  • LOCAL  — the key is stored on THIS machine only (sidecar SQLite, engine
//    scope "local"), for local runs.
//  • CLOUD  — the key is stored encrypted server-side and SHARED with the whole
//    workspace/team (everyone uses it). This is the cloud `workspace` scope; the
//    tab only appears when signed into a cloud workspace.
// (The old Personal/Team local sub-scopes are collapsed into a single Local tab;
//  existing personal/team rows still read back as "connected" under Local.)
const LOCAL_SCOPE: { id: CredentialScope; label: string; icon: ReactNode } = {
  id: "local",
  label: "Local",
  icon: <I.Home />,
};

/**
 * The shared (cloud) scope tab, shown only when a workspace is active. Saving
 * under it routes to the encrypted cloud save path and is shared with the team.
 */
const CLOUD_SCOPE: { id: "workspace"; label: string; icon: ReactNode } = {
  id: "workspace",
  label: "Cloud",
  icon: <I.Users />,
};

/** Friendly label for a scope id (the underlying cloud id stays "workspace"). */
const scopeLabel = (s: PanelScope): string => (s === "workspace" ? "Cloud" : "Local");

// BrandIcon (and its `initials` helper) live in ./BrandIcon so they can be
// eagerly imported into the initial bundle while the rest of Panels is
// lazy-loaded. Re-exported here to preserve existing import sites; also used
// internally by the panel/header components below.
export { BrandIcon };

function PanelHeader({ logo, title, description, meta }: { logo: string | null; title: string; description: string; meta: string }) {
  return (
    <>
      <div className="detail-head">
        <div className="detail-icon"><BrandIcon logo={logo} name={title} size={30} /></div>
        <div className="detail-head-text">
          <span className="detail-title">{title}</span>
          {description && <span className="detail-desc">{description}</span>}
        </div>
      </div>
      <div className="detail-meta">{meta}</div>
    </>
  );
}

function ScopeTabs({
  scope,
  onScope,
  showWorkspace,
}: {
  scope: PanelScope;
  onScope: (s: PanelScope) => void;
  /** When true, prepend the shared "Workspace" (cloud) scope tab. */
  showWorkspace: boolean;
}) {
  // Cloud first (it's the headline) when signed into a workspace; otherwise the
  // Local tab is the only option.
  const tabs: { id: PanelScope; label: string; icon: ReactNode }[] = showWorkspace
    ? [CLOUD_SCOPE, LOCAL_SCOPE]
    : [LOCAL_SCOPE];
  return (
    <div className="scope-tabs">
      {tabs.map((s) => (
        <button key={s.id} className={`scope-tab${scope === s.id ? " active" : ""}`} onClick={() => onScope(s.id)}>
          {s.icon}
          {s.label}
        </button>
      ))}
    </div>
  );
}

function Collapsible({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="detail-collapse">
      <button className="detail-collapse-head" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <span className={`detail-collapse-caret${open ? " open" : ""}`}><I.Caret /></span>
      </button>
      {open && <div className="detail-collapse-body">{children}</div>}
    </div>
  );
}

/**
 * The shared CONNECTIONS block: scope tabs + a dashed add-card. Reused by both
 * the extension and AI-provider panels. `onSave` stores the key for `scope`.
 */
function ConnectionsSection({
  name,
  credentialLabel = "API key",
  connectedScopes,
  onSave,
  workspace,
}: {
  name: string;
  credentialLabel?: string;
  connectedScopes: CredentialScope[];
  onSave: (apiKey: string, scope: CredentialScope) => Promise<void>;
  /**
   * Cloud context. When present a shared "Workspace" scope tab is shown and
   * saving under it routes to the Convex encrypted-save path. Absent for a
   * signed-out / local-only user (panels then behave exactly as before).
   */
  workspace?: WorkspaceCredContext;
}) {
  const showWorkspace = workspace !== undefined;
  // Default to the shared Cloud tab when available (team sharing is the headline);
  // otherwise the machine-local tab.
  const [scope, setScope] = useState<PanelScope>(showWorkspace ? "workspace" : "local");
  const [adding, setAdding] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [copying, setCopying] = useState(false);

  const isWorkspace = scope === "workspace";
  // A LOCAL key exists for this connector (any machine-local scope, incl. legacy
  // personal/team) — the prerequisite for offering the one-click copy-to-cloud.
  const hasLocalKey = connectedScopes.length > 0;
  // The single Local tab represents ALL machine-local scopes, so it's "connected"
  // when any local credential exists (incl. legacy personal/team rows).
  const connectedHere = isWorkspace
    ? (workspace?.connected ?? false)
    : connectedScopes.length > 0;

  const reset = () => { setAdding(false); setKeyDraft(""); setErr(""); };

  const save = async () => {
    if (!keyDraft.trim()) { setErr(`Enter ${credentialLabel}`); return; }
    setSaving(true);
    setErr("");
    try {
      if (isWorkspace) {
        // workspace !== undefined is guaranteed: the tab only shows when set.
        await workspace!.onSaveWorkspace(keyDraft.trim());
      } else {
        await onSave(keyDraft.trim(), scope);
      }
      reset();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to connect");
    } finally {
      setSaving(false);
    }
  };

  // One-click copy of the local key up to the shared Cloud key (the sidecar does
  // the reveal+save; the plaintext never reaches here).
  const copyLocal = async () => {
    if (!workspace?.copyLocalKey) return;
    setCopying(true);
    setErr("");
    try {
      await workspace.copyLocalKey();
      reset();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to copy your local key");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="detail-section">
      <ScopeTabs scope={scope} showWorkspace={showWorkspace} onScope={(s) => { setScope(s); reset(); }} />
      <div className="conn-label">Connections</div>

      <div className={`conn-card${adding ? " editing" : ""}`}>
        {adding ? (
          <div className="conn-add-form">
            <label className="form-label">{name} {credentialLabel} · {scopeLabel(scope)}</label>
            <input
              className="form-input"
              type="password"
              placeholder={`${name} ${credentialLabel}`}
              value={keyDraft}
              autoFocus
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") reset(); }}
            />
            {err && <div className="conn-err">{err}</div>}
            <div className="conn-add-actions">
              <button className="btn btn-outline btn-sm" onClick={reset} disabled={saving}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : /key/i.test(credentialLabel) ? "Save key" : "Save token"}
              </button>
            </div>
          </div>
        ) : connectedHere ? (
          <div className="conn-connected">
            <span className="conn-dot" />
            <div className="conn-text">
              <strong>{name} connected</strong>
              <span>
                {isWorkspace ? (
                  <>Shared with your <b>team</b> · encrypted in the cloud.</>
                ) : (
                  <>Stored on <b>this device</b> only · encrypted at rest.</>
                )}
              </span>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => setAdding(true)}>
              {/key/i.test(credentialLabel) ? "Replace key" : "Replace token"}
            </button>
          </div>
        ) : (
          <div className="conn-empty">
            <div className="conn-plus"><I.Plus /></div>
            <div className="conn-empty-title">No {name} credentials yet</div>
            <div className="conn-empty-sub">Add one to connect {name}.</div>
            <button className="btn btn-primary btn-sm conn-add-btn" onClick={() => setAdding(true)}>
              <I.Plus /> Add connection
            </button>
            {/* Offer the one-click copy only in the Cloud tab, when a local key
                exists and the cloud session can save it. */}
            {isWorkspace && hasLocalKey && workspace?.copyLocalKey && (
              <button
                className="btn btn-outline btn-sm conn-add-btn"
                onClick={copyLocal}
                disabled={copying}
                title={`Copy your local ${name} key to the shared Cloud key`}
              >
                {copying ? "Copying…" : "Use my local key"}
              </button>
            )}
            {err && <div className="conn-err">{err}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Extension detail ────────────────────────────────────


/**
 * OAuth management for the CRM SYNC connection — deliberately separate from
 * the API-key section below it: the key powers cell actions (engine methods),
 * the OAuth grant powers synced tables. Removing one never touches the other.
 *
 * The flow (server-minted state → openExternal → poll) lives in
 * {@link OAuthConnectCard}; this supplies only what is CRM-specific.
 */
function CrmOAuthSection({ workspaceId, provider }: { workspaceId: string; provider: "attio" | "hubspot" }) {
  const crmName = provider === "hubspot" ? "HubSpot" : "Attio";
  const [status, setStatus] = useState<OAuthCardStatus>({ kind: "loading" });

  const refresh = useCallback(async () => {
    if (!apiClient) return;
    try {
      const s = await apiClient.crm.connectionStatus.query({ workspaceId, provider });
      if (s == null) setStatus({ kind: "disconnected", configured: false });
      else if (s.connected) {
        setStatus({
          kind: "connected",
          byName: s.connectedByName,
          accountLabel: s.workspaceLabel ?? s.attioWorkspaceName,
        });
      } else setStatus({ kind: "disconnected", configured: s.configured });
    } catch {
      setStatus({ kind: "disconnected", configured: false });
    }
  }, [workspaceId, provider]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <OAuthConnectCard
      headText="CRM sync · OAuth connection"
      providerName={crmName}
      status={status}
      refresh={refresh}
      authorizeUrl={async () => {
        if (!apiClient) throw new Error("Not signed in");
        const { url } = await apiClient.crm.authorizeUrl.query({ workspaceId, provider });
        return url;
      }}
      disconnect={async () => {
        if (!apiClient) throw new Error("Not signed in");
        const res = await apiClient.crm.disconnect.mutate({ workspaceId, provider });
        return res.bindingsPaused > 0
          ? `Disconnected. ${res.bindingsPaused} synced table${res.bindingsPaused === 1 ? "" : "s"} paused — reconnect to resume.`
          : "Disconnected.";
      }}
      connectedSub="read-only · powers synced tables"
      disconnectedSub={`Connect with OAuth to sync ${crmName} objects & lists into tables`}
      footerNote={`The API key below is separate — it powers ${crmName} cell actions and is never used for syncing.`}
    />
  );
}

/**
 * OAuth management for the SLACK connection.
 *
 * Note how much thinner this is than the CRM section: no bindings to pause on
 * disconnect, and the account label is the Slack TEAM, which the token exchange
 * already returned — no identify round trip.
 */
export function SlackOAuthSection({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<OAuthCardStatus>({ kind: "loading" });

  const refresh = useCallback(async () => {
    if (!apiClient) return;
    try {
      const s = await apiClient.slack.connectionStatus.query({ workspaceId });
      if (s.connected) {
        setStatus({ kind: "connected", byName: s.connectedByName, accountLabel: s.teamName || "Slack" });
      } else setStatus({ kind: "disconnected", configured: s.configured });
    } catch {
      // NOT `{ disconnected, configured: false }`. A failed read tells us nothing
      // about whether this deployment is configured, and claiming it does renders
      // "Slack isn't set up on this deployment yet" with Connect DISABLED — an
      // accusation against the operator, and a dead end, on any transient blip.
      setStatus({ kind: "error" });
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <OAuthConnectCard
      headText="Slack · OAuth connection"
      providerName="Slack"
      status={status}
      refresh={refresh}
      authorizeUrl={async () => {
        if (!apiClient) throw new Error("Not signed in");
        const { url } = await apiClient.slack.authorizeUrl.query({ workspaceId });
        return url;
      }}
      disconnect={async () => {
        if (!apiClient) throw new Error("Not signed in");
        const res = await apiClient.slack.disconnect.mutate({ workspaceId });
        return res.removed ? "Disconnected." : "Nothing to disconnect.";
      }}
      connectedSub="powers Slack columns (post a message, look up a user)"
      disconnectedSub="Connect with OAuth to post messages and look up users from a column"
    />
  );
}

export function ExtensionPanel({ id, onConnected, onBack, workspaceCreds, workspaceId }: { id: string; onConnected: () => void; onBack?: () => void; workspaceCreds?: WorkspaceCredSource; workspaceId?: string }) {
  const [detail, setDetail] = useState<ExtensionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await api.extension(id));
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [id, load]);

  const backBar = onBack && (
    <button className="detail-back" onClick={onBack}><I.Back /> Tools</button>
  );

  if (loading) {
    return <div className="detail-wrap">{backBar}<div className="detail"><div className="cell-spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /></div></div>;
  }
  if (!detail) {
    return <div className="detail-wrap">{backBar}<div className="detail"><div className="detail-empty">Tool not found.</div></div></div>;
  }

  const methodCount = detail.methods.length;
  const connected = detail.connected || (workspaceCreds?.connectedExtensionIds.has(detail.id) ?? false);
  const description = detail.description ?? `${detail.category} tool`;
  const meta = ["Tool", `${methodCount} method${methodCount !== 1 ? "s" : ""}`, detail.version ? `v${detail.version}` : null]
    .filter(Boolean)
    .join("  ·  ");

  const onSave = async (apiKey: string, scope: CredentialScope) => {
    const secretKey = detail.auth?.secretKey ?? "apiKey";
    await api.connect(detail.id, { [secretKey]: apiKey }, scope);
    await load();
    onConnected();
  };

  return (
    <div className="detail-wrap">
      {backBar}
      <div className="detail">
      <PanelHeader logo={detail.logo} title={detail.name} description={description} meta={meta} />

      {(detail.id === "attio" || detail.id === "hubspot") && workspaceId ? (
        <CrmOAuthSection workspaceId={workspaceId} provider={detail.id} />
      ) : null}

      {detail.id === "slack" && workspaceId ? <SlackOAuthSection workspaceId={workspaceId} /> : null}

      {/*
        An OAUTH tool gets NO api-key section — and this is a data-loss guard, not
        cosmetics.

        `ConnectionsSection`'s workspace save writes `{ apiKey: <pasted text> }` at
        `extensionId` / scope `workspace`, and `CredentialService.saveCredential`
        REPLACES the whole encrypted secret map (it encrypts exactly the map it is
        given). For Slack that row IS the OAuth grant — `SLACK_CONNECTION_SLOT` is
        the bare "slack", because the engine resolves a connector's credential by
        its manifest id, so `sdk.slack.*` finds nothing under any other name. One
        paste therefore destroys accessToken, the SINGLE-USE refreshToken and the
        team meta. With rotation on, that grant is gone for good — reconnect is the
        only recovery.

        It was worse than dead UI: an OAuth-connected workspace has a row at slot
        "slack", so `connectedExtensionIds` contained it and the section rendered
        "Slack connected · Replace key" — an invitation to destroy the token.

        `crm-connection-service.ts` names this exact hazard as the reason CRM slots
        are suffixed ("attio-crm"), which is why Attio/HubSpot keep their key form:
        their auth.type is apiKey and their OAuth lives in a DIFFERENT row. Slack
        shares its row by design, so the UI must not offer to overwrite it.

        Gated on the MANIFEST rather than `id !== "slack"`, so the next OAuth
        connector inherits this instead of re-learning it.
      */}
      {detail.auth?.type !== "oauth" ? (
        <ConnectionsSection
          name={detail.name}
          credentialLabel={detail.auth?.credentialLabel}
          connectedScopes={detail.connectedScopes}
          onSave={onSave}
          workspace={workspaceCtxFor(workspaceCreds, detail.id, detail.name)}
        />
      ) : null}

      {/* Endpoints stay hidden until a key is connected. */}
      <Collapsible title={`Available methods · ${methodCount}`} defaultOpen={connected}>
        {connected ? (
          <div className="method-list">
            {detail.methods.map((m) => (
              <div key={m.id} className="method-row">
                <div className="method-top">
                  <span className="method-label">{m.label}</span>
                  {m.verb && m.path && (
                    <span className="method-route"><span className="method-verb">{m.verb}</span>{m.path}</span>
                  )}
                  <span className="method-credits" title="Credits per call">{m.credits} cr</span>
                </div>
                {m.description && <div className="method-desc">{m.description}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="method-locked">🔒 Connect your {detail.auth?.credentialLabel ?? "API key"} to see {detail.name}'s methods.</div>
        )}
      </Collapsible>

      {detail.auth?.header && (
        <Collapsible title={/key/i.test(detail.auth.credentialLabel ?? "API key") ? "Where the key is used" : "Where the credential is used"}>
          <p className="conn-hint" style={{ margin: 0 }}>
            Sent as the <code>{detail.auth.header}</code> header on requests to{" "}
            <code>{detail.baseUrl ?? "the API"}</code> when a function column calls a {detail.name} method.
          </p>
        </Collapsible>
      )}
      </div>
    </div>
  );
}

// ─── Extensions gallery (Browse all) ─────────────────────

interface Perk {
  /** Discount code the user redeems on the partner's checkout. */
  code: string;
  /** Short discount label, e.g. "50% off" (uppercased for the card badge). */
  pct: string;
  /** One-line terms / context shown under the partner name in the modal. */
  sub: string;
}

/**
 * Hand-picked partner discounts, keyed by extension id. Each perk surfaces three
 * ways in Browse all: a quiet "% OFF" badge on the matching card (in-context
 * discovery), a "Partner perks" button under the search that opens
 * {@link PerksModal}, and a copyable code chip in that modal. Codes are redeemed
 * on the partner's own billing page — GTM Grid doesn't process the discount.
 * Add or remove a perk by editing this object and {@link PERK_ORDER}; the button
 * count and card badges update automatically.
 */
const PERKS: Record<string, Perk> = {
  smuggler: { code: "MAX50", pct: "50% off", sub: "First 3 months on any plan · LinkedIn engagement intelligence" },
  trigify: { code: "MAX30", pct: "30% off", sub: "Any annual plan · social listening + engagement signals" },
  avtrz: { code: "MAX10", pct: "10% off", sub: "Stacks with usage credits · profile-photo enrichment" },
};
const PERK_ORDER = ["smuggler", "trigify", "avtrz"];

/** A click-to-copy code chip; flips to a green "Copied" confirmation briefly. */
function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className={`perk-code${copied ? " copied" : ""}`} onClick={copy} title="Copy code">
      <span className="perk-code-label">Code</span>
      <span className="perk-code-val">{copied ? "Copied" : code}</span>
      <span className="perk-code-copy">{copied ? <I.Check /> : <I.Copy />}</span>
    </button>
  );
}

/** Modal listing every partner perk with its discount and a copyable code. */
function PerksModal({ extensions, onClose }: { extensions: ExtensionInfo[]; onClose: () => void }) {
  const rows = PERK_ORDER.flatMap((id) => {
    const ext = extensions.find((e) => e.id === id);
    return ext ? [{ ext, perk: PERKS[id] }] : [];
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="ppm" overlayClassName="ppm-scrim" srTitle="Partner perks">
        <div className="ppm-head">
          <div className="ppm-head-text">
            <div className="ppm-title"><span className="tag-ic"><I.Tag s={17} /></span>Partner perks</div>
            <div className="ppm-sub">Exclusive codes for GTM Grid users. Copy a code and apply it at the partner's checkout.</div>
          </div>
          <button className="ppm-close" onClick={onClose} aria-label="Close"><I.X s={17} /></button>
        </div>
        <div className="ppm-body">
          {rows.map(({ ext, perk }) => (
            <div key={ext.id} className="ppm-row">
              <span className="browse-card-icon ppm-row-icon"><BrandIcon logo={ext.logo} name={ext.name} size={26} /></span>
              <div className="ppm-row-body">
                <div className="ppm-row-name"><strong>{ext.name}</strong><span className="ppm-pct">{perk.pct}</span></div>
                <div className="ppm-row-sub">{perk.sub}</div>
              </div>
              <CodeChip code={perk.code} />
            </div>
          ))}
        </div>
        <div className="ppm-foot">Codes are redeemed on the partner's own billing page — GTM Grid doesn't process the discount.</div>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionCard({ e, onOpen, featured = false }: { e: ExtensionInfo; onOpen: (id: string) => void; featured?: boolean }) {
  const perk = PERKS[e.id];
  return (
    <button className={`browse-card${featured ? " featured" : ""}`} onClick={() => onOpen(e.id)}>
      <div className="browse-card-icon"><BrandIcon logo={e.logo} name={e.name} size={26} /></div>
      <div className="browse-card-body">
        <div className="browse-card-top">
          <span className="browse-card-name">{e.name}</span>
          {e.connected && <span className="ext-badge connected">connected</span>}
          {perk && <span className="deal-badge">{perk.pct.toUpperCase()}</span>}
        </div>
        <div className="browse-card-desc">{e.description ?? `${e.category} · ${e.methods} methods`}</div>
      </div>
      <span className="browse-card-add"><I.Plus /></span>
    </button>
  );
}

export function ExtensionsBrowse({
  extensions,
  onOpen,
}: {
  extensions: ExtensionInfo[];
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [perksOpen, setPerksOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? extensions.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          (e.description ?? "").toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q),
      )
    : extensions;

  const featured = extensions.filter((e) => e.featured);
  const rest = extensions.filter((e) => !e.featured);
  const searching = q.length > 0;
  const availablePerks = PERK_ORDER.filter((id) => extensions.some((e) => e.id === id));

  return (
    <div className="browse">
      <h1 className="browse-title">Make GTM Grid work your way</h1>

      <div className="browse-search">
        <I.Search />
        <input
          className="browse-search-input"
          placeholder="Search tools"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {availablePerks.length > 0 && (
        <div className="perks-bar">
          <button className="perks-btn" onClick={() => setPerksOpen(true)}>
            <span className="tag-ic"><I.Tag s={14} /></span>
            Partner perks
            <span className="perks-btn-count">{availablePerks.length}</span>
          </button>
        </div>
      )}

      {searching ? (
        <>
          <div className="browse-section-label">
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
          </div>
          {filtered.length === 0 ? (
            <div className="browse-empty">No tools match “{query}”.</div>
          ) : (
            <div className="browse-grid">
              {filtered.map((e) => <ExtensionCard key={e.id} e={e} onOpen={onOpen} />)}
            </div>
          )}
        </>
      ) : (
        <>
          {featured.length > 0 && (
            <>
              <div className="browse-section-label">Featured</div>
              <div className="browse-grid" style={{ marginBottom: 28 }}>
                {featured.map((e) => <ExtensionCard key={e.id} e={e} onOpen={onOpen} featured />)}
              </div>
            </>
          )}
          <div className="browse-section-label">All tools</div>
          <div className="browse-grid">
            {rest.map((e) => <ExtensionCard key={e.id} e={e} onOpen={onOpen} />)}
          </div>
        </>
      )}

      {perksOpen && <PerksModal extensions={extensions} onClose={() => setPerksOpen(false)} />}
    </div>
  );
}

// ─── AI Provider detail ──────────────────────────────────

export function AiProviderPanel({ provider, onConnected, workspaceCreds }: { provider: AiProviderInfo; onConnected: () => void; workspaceCreds?: WorkspaceCredSource }) {
  const meta = `AI Provider  ·  ${provider.models.length} model${provider.models.length !== 1 ? "s" : ""}`;
  // Hermes is a self-hosted gateway, so its OpenAI-compatible base URL is
  // user-configurable (unlike the fixed cloud providers).
  const isHermes = provider.id === "hermes";
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");

  const onSave = async (apiKey: string, scope: CredentialScope) => {
    await api.connectAiProvider(provider.id, {
      apiKey,
      scope,
      ...(isHermes ? { baseURL: baseUrl.trim() || undefined } : {}),
    });
    onConnected();
  };

  return (
    <div className="detail">
      <PanelHeader logo={provider.logo} title={provider.name} description={provider.description} meta={meta} />

      {isHermes && (
        <div className="detail-section">
          <div className="conn-label">Gateway</div>
          <label className="form-label">OpenAI-compatible base URL</label>
          <input
            className="form-input"
            value={baseUrl}
            placeholder={provider.baseUrl ?? "http://localhost:18642/v1"}
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="conn-hint" style={{ margin: "6px 0 0" }}>
            Your Hermes gateway's <code>/v1</code> endpoint — the SSH-tunnel port for a remote
            (mac-mini) gateway, or <code>:8642</code> for a local one. Add the gateway's API key
            below (any value works if it has no <code>API_SERVER_KEY</code> set).
          </p>
        </div>
      )}

      <ConnectionsSection
        name={provider.name}
        connectedScopes={provider.connectedScopes}
        onSave={onSave}
        workspace={workspaceCtxFor(workspaceCreds, aiProviderCredId(provider.id), provider.name)}
      />

      <Collapsible title="Where each key is used">
        <p className="conn-hint" style={{ margin: 0 }}>
          Storing the key makes {provider.name} available to AI function columns and the in-app agent.
          You pick the exact model later, when you set up an AI step.
          {provider.viaEnv && " A key is currently set from an environment variable — adding one here overrides it."}
        </p>
      </Collapsible>

      <Collapsible title={`Available models · ${provider.models.length}`}>
        <div className="models-list">
          {provider.models.map((m) => (
            <span key={m} className="model-chip">{m}</span>
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

// ─── Skills: per-tool agent playbooks + custom skills ────────────────────

function SkillCard({ s, onOpen }: { s: SkillInfo; onOpen: (id: string) => void }) {
  return (
    <button className="browse-card" onClick={() => onOpen(s.id)}>
      <div className="browse-card-icon"><BrandIcon logo={s.logo} name={s.name} size={26} /></div>
      <div className="browse-card-body">
        <div className="browse-card-top">
          <span className="browse-card-name">{s.name}</span>
          {s.source === "tool" && s.connected && <span className="ext-badge connected">on</span>}
          {s.source === "custom" && <span className="ext-badge no-key">custom</span>}
        </div>
        <div className="browse-card-desc">
          {s.description ?? (s.source === "tool" ? `Playbook for the ${s.name} tool` : "Custom skill")} · {s.wordCount} words
        </div>
      </div>
      <span className="browse-card-add"><I.Search /></span>
    </button>
  );
}

export function SkillsBrowse({
  skills,
  onOpen,
  onChanged,
}: {
  skills: SkillInfo[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? skills.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
    : skills;
  const toolSkills = filtered.filter((s) => s.source === "tool");
  const customSkills = filtered.filter((s) => s.source === "custom");

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const r = await api.saveSkill({ name: name.trim(), body });
      setCreating(false);
      setName("");
      setBody("");
      onChanged();
      if (r?.id) onOpen(r.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="browse">
      <h1 className="browse-title">Skills — playbooks for your tools</h1>
      <p className="browse-sub">
        Each connected tool ships an agent playbook so Claude / Codex picks the right endpoint without guessing.
        Add your own to teach the agent your workflows.
      </p>

      <div className="browse-search">
        <I.Search />
        <input
          className="browse-search-input"
          placeholder="Search skills"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button className="skill-new-btn" onClick={() => setCreating((c) => !c)}>
          <I.Plus /> New skill
        </button>
      </div>

      {creating && (
        <div className="skill-create">
          <input
            className="skill-create-name"
            placeholder="Skill name — e.g. “Cold outbound playbook”"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <textarea
            className="skill-create-body"
            placeholder={"# My playbook\n\n## When to use\n- ...\n\n## Recipes\n1. ..."}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
          />
          <div className="skill-create-actions">
            <button className="skill-btn ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button className="skill-btn primary" onClick={create} disabled={!name.trim() || saving}>
              {saving ? "Saving…" : "Create skill"}
            </button>
          </div>
        </div>
      )}

      {toolSkills.length > 0 && (
        <>
          <div className="browse-section-label">Tool playbooks</div>
          <div className="browse-grid" style={{ marginBottom: 28 }}>
            {toolSkills.map((s) => <SkillCard key={s.id} s={s} onOpen={onOpen} />)}
          </div>
        </>
      )}

      <div className="browse-section-label">Custom skills</div>
      {customSkills.length === 0 ? (
        <div className="browse-empty">No custom skills yet. Click “New skill” to add one.</div>
      ) : (
        <div className="browse-grid">
          {customSkills.map((s) => <SkillCard key={s.id} s={s} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

// ─── Tables management hub ───────────────────────────────
//
// A connector-page-style hub for every table (from the GTM Grid Tables design):
// title + subtitle, search, status-filter chips with counts, sort dropdown,
// list/grid views, bulk-select, per-row favorite + actions menu. Owns its
// view/search/sort/select/rename state; open/delete/rename/favorite/create/
// bulk-delete are delegated to App. Owner/size/edited/function-stack columns from
// the design are omitted — that data isn't in the live table model.

/** One table as the hub renders it; `null` counts mean "unknown" (cloud). */
export interface TableCard {
  key: string;
  kind: "local" | "cloud";
  id: string;
  name: string;
  rows: number | null;
  columns: number | null;
  favorite: boolean;
  synced: boolean;
  active: boolean;
  /** Sort key for "Recently added" — cloud createdAt / local sidebar position. */
  recency: number;
}

type TableFilter = "all" | "favorites" | "synced" | "local";
type TableSort = "recent" | "name" | "rows";

const TABLE_FILTERS: { id: TableFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "favorites", label: "Favorites" },
  { id: "synced", label: "Synced" },
  { id: "local", label: "Local only" },
];
const TABLE_SORTS: { id: TableSort; label: string }[] = [
  { id: "recent", label: "Recently added" },
  { id: "name", label: "Name" },
  { id: "rows", label: "Row count" },
];

function cardMeta(c: TableCard): string {
  // Show real counts whenever we have them. Cloud tables only carry a row count
  // (no column count from the worker list), so they read "124 rows"; a cloud table
  // whose count the server didn't report (older API) falls back to "Cloud table".
  const cols = c.columns != null ? `${c.columns} column${c.columns !== 1 ? "s" : ""}` : "";
  const rows = c.rows != null ? `${c.rows} row${c.rows !== 1 ? "s" : ""}` : "";
  const meta = [cols, rows].filter(Boolean).join(" · ");
  if (meta) return meta;
  return c.kind === "cloud" ? "Cloud table" : "Empty table";
}

export function TablesBrowse({
  cards,
  workspaceName,
  syncing,
  onOpen,
  onDelete,
  onFavorite,
  onRename,
  onNew,
  onBulkDelete,
  onSyncAll,
}: {
  cards: TableCard[];
  workspaceName?: string;
  syncing?: boolean;
  onOpen: (c: TableCard) => void;
  onDelete: (c: TableCard) => void;
  onFavorite: (c: TableCard) => void;
  onRename: (c: TableCard, name: string) => void;
  onNew: () => void;
  onBulkDelete: (cs: TableCard[]) => void;
  onSyncAll?: () => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<TableFilter>("all");
  const [sort, setSort] = useState<TableSort>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [view, setView] = useState<"list" | "grid">("list");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const query = q.trim().toLowerCase();
  const counts: Record<TableFilter, number> = {
    all: cards.length,
    favorites: cards.filter((c) => c.favorite).length,
    synced: cards.filter((c) => c.synced).length,
    local: cards.filter((c) => !c.synced).length,
  };
  let visible = cards.filter((c) => c.name.toLowerCase().includes(query));
  if (filter === "favorites") visible = visible.filter((c) => c.favorite);
  else if (filter === "synced") visible = visible.filter((c) => c.synced);
  else if (filter === "local") visible = visible.filter((c) => !c.synced);
  visible = [...visible].sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name)
    : sort === "rows" ? (b.rows ?? -1) - (a.rows ?? -1)
    : b.recency - a.recency,
  );

  const selectedCards = cards.filter((c) => selected.has(c.key));
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.key));
  const toggleSel = (key: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () =>
    setSelected(() => (allVisibleSelected ? new Set<string>() : new Set(visible.map((c) => c.key))));
  const clearSel = () => { setSelected(new Set()); setConfirmBulk(false); };

  const openMenu = (e: MouseEvent<HTMLElement>, key: string) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ key, x: Math.min(r.right - 204, window.innerWidth - 216), y: r.bottom + 4 });
  };
  const commitRename = (c: TableCard, value: string) => {
    const v = value.trim();
    if (v && v !== c.name) onRename(c, v);
    setRenaming(null);
  };

  const Star = I.Star;
  const menuCard = menu ? cards.find((c) => c.key === menu.key) : null;

  return (
    <div className="tables-page">
      {/* Header */}
      <div className="tp-head">
        <div className="tp-head-left">
          <h1 className="tp-title">Tables</h1>
          <p className="tp-sub">
            {workspaceName != null
              ? <><strong>{cards.length}</strong> table{cards.length !== 1 ? "s" : ""} in <strong>{workspaceName}</strong></>
              : <><strong>{cards.length}</strong> local table{cards.length !== 1 ? "s" : ""}</>}
          </p>
        </div>
        <div className="tp-head-actions">
          {onSyncAll && (
            <button className={`tp-btn tp-btn-outline${syncing ? " busy" : ""}`} onClick={onSyncAll}>
              <I.CloudUp s={13} /> Sync all
            </button>
          )}
          <button className="tp-btn tp-btn-primary" onClick={onNew}><I.Plus /> New table</button>
        </div>
      </div>

      {/* Controls */}
      <div className="tp-controls">
        <div className="tp-search">
          <I.Search s={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tables…" autoFocus />
          {q && <button className="tp-search-x" onClick={() => setQ("")}><I.X s={12} /></button>}
        </div>
        <div className="tp-chips">
          {TABLE_FILTERS.map((f) => (
            <button key={f.id} className={`tp-chip${filter === f.id ? " active" : ""}`} onClick={() => setFilter(f.id)}>
              {f.label}<span className="tp-chip-n">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <span className="tp-controls-spacer" />
        <div className="tp-sortwrap">
          <button className="tp-sort" onClick={() => setSortOpen((v) => !v)}>
            <I.Sort s={13} /> {TABLE_SORTS.find((s) => s.id === sort)!.label}<I.ChevronDown s={11} />
          </button>
          {sortOpen && (
            <>
              <div className="popover-scrim" onMouseDown={() => setSortOpen(false)} />
              <div className="tp-sortmenu" onMouseDown={(e) => e.stopPropagation()}>
                {TABLE_SORTS.map((s) => (
                  <button key={s.id} className={`tp-menu-item${sort === s.id ? " active" : ""}`}
                    onClick={() => { setSort(s.id); setSortOpen(false); }}>
                    {s.label}{sort === s.id && <I.Check s={13} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="tp-viewtoggle">
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} title="List view"><I.ListView s={14} /></button>
          <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} title="Card view"><I.GridView s={14} /></button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="tp-bulk">
          <span className="tp-bulk-count"><strong>{selected.size}</strong> selected</span>
          {confirmBulk ? (
            <>
              <span className="tp-bulk-confirm">Delete {selected.size} table{selected.size !== 1 ? "s" : ""}? This can’t be undone.</span>
              <button className="tp-bulk-btn danger" onClick={() => { onBulkDelete(selectedCards); clearSel(); }}>Confirm delete</button>
              <button className="tp-bulk-btn" onClick={() => setConfirmBulk(false)}>Cancel</button>
            </>
          ) : (
            <button className="tp-bulk-btn danger" onClick={() => setConfirmBulk(true)}><I.Trash s={13} /> Delete</button>
          )}
          <span className="tp-controls-spacer" />
          <button className="tp-bulk-x" onClick={clearSel}><I.X s={13} /></button>
        </div>
      )}

      {/* Body */}
      {visible.length === 0 ? (
        <div className="tp-empty">
          <span className="tp-empty-ic"><I.Search s={22} /></span>
          <div className="tp-empty-t">{cards.length === 0 ? "No tables yet" : "No tables match"}</div>
          <div className="tp-empty-s">{cards.length === 0 ? "Click “New table” to create one." : "Try a different search or filter."}</div>
        </div>
      ) : view === "list" ? (
        <div className="tp-listwrap">
          <div className="tp-list-head tp-grid">
            <span className="tp-cell-sel">
              <button className={`tp-check${allVisibleSelected ? " on" : ""}`} onClick={toggleAll}>{allVisibleSelected && <I.Check s={11} />}</button>
            </span>
            <span>Name</span>
            <span className="tp-r">Rows</span>
            <span>Sync</span>
            <span />
          </div>
          {visible.map((c) => {
            const sel = selected.has(c.key);
            const ren = renaming === c.key;
            return (
              <div key={c.key} className={`tp-row tp-grid${sel ? " selected" : ""}${c.active ? " active" : ""}`} onClick={() => (ren ? undefined : onOpen(c))} onKeyDown={onActivateKey(() => (ren ? undefined : onOpen(c)))} role="button" tabIndex={0}>
                <span className="tp-cell-sel" onClick={(e) => e.stopPropagation()}>
                  <button className={`tp-check${sel ? " on" : ""}`} onClick={() => toggleSel(c.key)}>{sel && <I.Check s={11} />}</button>
                </span>
                <span className="tp-name">
                  <span className="tp-name-ic"><I.Table s={15} /></span>
                  <span className="tp-name-text">
                    {ren ? (
                      <input className="tp-rename" autoFocus defaultValue={c.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => commitRename(c, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c, (e.target as HTMLInputElement).value);
                          if (e.key === "Escape") setRenaming(null);
                        }} />
                    ) : (
                      <span className="tp-name-row">
                        <span className="tp-name-label">{c.name}</span>
                        {c.favorite && <span className="tp-name-star"><Star s={11} filled /></span>}
                      </span>
                    )}
                    <span className="tp-name-meta">{cardMeta(c)}</span>
                  </span>
                </span>
                <span className="tp-r tp-rows">{c.rows != null ? c.rows.toLocaleString() : "—"}</span>
                <span className="tp-cell-sync">
                  <span className={`tp-sync ${c.synced ? "is-synced" : "is-local"}`}>{c.synced ? "Synced" : "Local"}</span>
                </span>
                <span className="tp-cell-actions" onClick={(e) => e.stopPropagation()}>
                  {c.kind === "local" && (
                    <button className={`tp-star${c.favorite ? " on" : ""}`} onClick={() => onFavorite(c)} title="Favorite"><Star s={13} filled={c.favorite} /></button>
                  )}
                  <button className="tp-more" onClick={(e) => openMenu(e, c.key)} title="Actions"><I.More s={15} /></button>
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="tp-cards">
          {visible.map((c) => (
            <div key={c.key} className={`tp-card${selected.has(c.key) ? " selected" : ""}${c.active ? " active" : ""}`} onClick={() => onOpen(c)} onKeyDown={onActivateKey(() => onOpen(c))} role="button" tabIndex={0}>
              <div className="tp-card-top">
                <span className="tp-card-ic"><I.Table s={16} /></span>
                {c.kind === "local" && <button className={`tp-star${c.favorite ? " on" : ""}`} onClick={(e) => { e.stopPropagation(); onFavorite(c); }}><I.Star s={13} filled={c.favorite} /></button>}
                <button className="tp-more" onClick={(e) => openMenu(e, c.key)}><I.More s={15} /></button>
              </div>
              <div className="tp-card-name">{c.name}</div>
              <div className="tp-card-meta">{cardMeta(c)}</div>
              <div className="tp-card-foot">
                <span className={`tp-sync ${c.synced ? "is-synced" : "is-local"}`}>{c.synced ? "Synced" : "Local"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Row actions menu */}
      {menu && menuCard && (
        <>
          <div className="popover-scrim" onMouseDown={() => setMenu(null)} />
          <div className="tp-menu" style={{ top: Math.min(menu.y, window.innerHeight - 180), left: menu.x }} onMouseDown={(e) => e.stopPropagation()}>
            <button className="tp-menu-item" onClick={() => { setMenu(null); onOpen(menuCard); }}><I.Table s={14} /> Open table</button>
            {menuCard.kind === "local" && <button className="tp-menu-item" onClick={() => { setMenu(null); setRenaming(menuCard.key); }}><I.Pencil s={14} /> Rename</button>}
            <div className="tp-menu-sep" />
            <button className="tp-menu-item danger" onClick={() => { setMenu(null); onDelete(menuCard); }}><I.Trash s={14} /> Delete table</button>
          </div>
        </>
      )}
    </div>
  );
}

export function SkillPanel({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack?: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.skill(id);
      setDetail(d);
      setDraft(d.body);
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [id, load]);

  const backBar = onBack && (
    <button className="detail-back" onClick={onBack}><I.Back /> Skills</button>
  );

  if (loading) {
    return <div className="detail-wrap">{backBar}<div className="detail"><div className="cell-spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /></div></div>;
  }
  if (!detail) {
    return <div className="detail-wrap">{backBar}<div className="detail"><div className="detail-empty">Skill not found.</div></div></div>;
  }

  const isCustom = detail.source === "custom";
  const meta = [
    isCustom ? "Custom skill" : "Tool playbook",
    detail.source === "tool" ? (detail.connected ? "auto-loaded (connected)" : "loads when connected") : detail.enabled ? "enabled" : "disabled",
  ].join("  ·  ");

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSkill({ id: detail.id, name: detail.name, description: detail.description ?? "", body: draft });
      setEditing(false);
      await load();
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    await api.deleteSkill(detail.id);
    onChanged();
    onBack?.();
  };

  return (
    <div className="detail-wrap">
      {backBar}
      <div className="detail">
        <PanelHeader
          logo={detail.logo}
          title={detail.name}
          description={detail.description ?? (isCustom ? "Custom skill" : `Agent playbook for ${detail.name}`)}
          meta={meta}
        />

        {detail.source === "tool" && (
          <div className="skill-note">
            This playbook is injected into the agent automatically whenever <strong>{detail.name}</strong> is connected,
            so Claude / Codex knows exactly which endpoints to use.
          </div>
        )}

        <div className="skill-toolbar">
          {isCustom && !editing && (
            <>
              <button className="skill-btn" onClick={() => setEditing(true)}>Edit</button>
              <button className="skill-btn danger" onClick={remove}>Delete</button>
            </>
          )}
          {isCustom && editing && (
            <>
              <button className="skill-btn ghost" onClick={() => { setEditing(false); setDraft(detail.body); }}>Cancel</button>
              <button className="skill-btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </>
          )}
        </div>

        {editing ? (
          <textarea className="skill-edit-body" value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} />
        ) : (
          <div className="skill-body"><Markdown text={detail.body} /></div>
        )}
      </div>
    </div>
  );
}
