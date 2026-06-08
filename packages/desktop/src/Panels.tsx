// Detail panels rendered in the main area when an Extension or AI Provider
// is selected. Layout mirrors the connections design: a header, Personal/Team/
// Local scope tabs, a "CONNECTIONS" add-card, and collapsible info sections.

import { useState, useEffect, useCallback, ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, ExtensionDetail, ExtensionInfo, AiProviderInfo, CredentialScope, SkillInfo, SkillDetail } from "./api";
import { aiProviderCredId } from "./cloud/credentials";
import { Markdown } from "./AgentPanel";

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
  Search: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
};

const SCOPES: { id: CredentialScope; label: string; icon: ReactNode }[] = [
  { id: "personal", label: "Personal", icon: <I.Lock /> },
  { id: "team", label: "Team", icon: <I.Globe /> },
  { id: "local", label: "Local", icon: <I.Home /> },
];

/**
 * The shared (cloud) workspace scope tab, prepended to {@link SCOPES} only when a
 * workspace is active. Saving under it routes to Convex `saveCredential`.
 */
const WORKSPACE_SCOPE: { id: "workspace"; label: string; icon: ReactNode } = {
  id: "workspace",
  label: "Workspace",
  icon: <I.Users />,
};

function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "··";
}

/** Brand logo with a graceful fallback to monogram initials if it fails to load. */
export function BrandIcon({ logo, name, size = 18 }: { logo: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logo]);
  if (logo && !failed) {
    return (
      <img className="brand-img" src={logo} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
    );
  }
  return <span className="brand-fallback" style={{ width: size, height: size }}>{initials(name)}</span>;
}

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
  const tabs: { id: PanelScope; label: string; icon: ReactNode }[] = showWorkspace
    ? [WORKSPACE_SCOPE, ...SCOPES]
    : SCOPES;
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
    <div className="collapse">
      <button className="collapse-head" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <span className={`collapse-caret${open ? " open" : ""}`}><I.Caret /></span>
      </button>
      {open && <div className="collapse-body">{children}</div>}
    </div>
  );
}

/**
 * The shared CONNECTIONS block: scope tabs + a dashed add-card. Reused by both
 * the extension and AI-provider panels. `onSave` stores the key for `scope`.
 */
function ConnectionsSection({
  name,
  connectedScopes,
  onSave,
  workspace,
}: {
  name: string;
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
  // Default to the shared workspace tab when available (cloud sharing is the
  // headline of T11); otherwise the existing local default.
  const [scope, setScope] = useState<PanelScope>(showWorkspace ? "workspace" : "personal");
  const [adding, setAdding] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const isWorkspace = scope === "workspace";
  const connectedHere = isWorkspace
    ? (workspace?.connected ?? false)
    : connectedScopes.includes(scope);

  const reset = () => { setAdding(false); setKeyDraft(""); setErr(""); };

  const save = async () => {
    if (!keyDraft.trim()) { setErr("Enter an API key"); return; }
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

  return (
    <div className="detail-section">
      <ScopeTabs scope={scope} showWorkspace={showWorkspace} onScope={(s) => { setScope(s); reset(); }} />
      <div className="conn-label">Connections</div>

      <div className={`conn-card${adding ? " editing" : ""}`}>
        {adding ? (
          <div className="conn-add-form">
            <label className="form-label">{name} API key · {scope}</label>
            <input
              className="form-input"
              type="password"
              placeholder={`${name} API key`}
              value={keyDraft}
              autoFocus
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") reset(); }}
            />
            {err && <div className="conn-err">{err}</div>}
            <div className="conn-add-actions">
              <button className="btn btn-outline btn-sm" onClick={reset} disabled={saving}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save key"}
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
                  <>Shared with the <b>workspace</b> · encrypted server-side.</>
                ) : (
                  <>Key stored under <b>{scope}</b> · encrypted on this device.</>
                )}
              </span>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => setAdding(true)}>Replace key</button>
          </div>
        ) : (
          <div className="conn-empty">
            <div className="conn-plus"><I.Plus /></div>
            <div className="conn-empty-title">No {name} credentials yet</div>
            <div className="conn-empty-sub">Add one to connect {name}.</div>
            <button className="btn btn-primary btn-sm conn-add-btn" onClick={() => setAdding(true)}>
              <I.Plus /> Add connection
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Extension detail ────────────────────────────────────

export function ExtensionPanel({ id, onConnected, onBack, workspaceCreds }: { id: string; onConnected: () => void; onBack?: () => void; workspaceCreds?: WorkspaceCredSource }) {
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

      <ConnectionsSection
        name={detail.name}
        connectedScopes={detail.connectedScopes}
        onSave={onSave}
        workspace={workspaceCtxFor(workspaceCreds, detail.id, detail.name)}
      />

      {/* Endpoints stay hidden until a key is connected. */}
      <Collapsible title={`Available methods · ${methodCount}`} defaultOpen={detail.connected}>
        {detail.connected ? (
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
          <div className="method-locked">🔒 Connect an API key to see {detail.name}'s methods.</div>
        )}
      </Collapsible>

      {detail.auth?.header && (
        <Collapsible title="Where the key is used">
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
  // Portal to <body> so the overlay escapes the main-area stacking context
  // (otherwise it's trapped below the sidebar — a partial dim + dead click-off).
  return createPortal(
    <div className="ppm-scrim" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="ppm" role="dialog" aria-modal="true" aria-label="Partner perks" onMouseDown={(ev) => ev.stopPropagation()}>
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
      </div>
    </div>,
    document.body,
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

  const onSave = async (apiKey: string, scope: CredentialScope) => {
    await api.connectAiProvider(provider.id, { apiKey, scope });
    onConnected();
  };

  return (
    <div className="detail">
      <PanelHeader logo={provider.logo} title={provider.name} description={provider.description} meta={meta} />

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
