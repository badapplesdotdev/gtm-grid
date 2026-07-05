// "From your CRM" — the 3-step wizard that connects a CRM (read-only OAuth;
// Attio or HubSpot), picks an object/list + its fields + filters + dedupe
// rule, then creates a synced grid table backed by a CRM binding the Inngest
// worker keeps refreshed.
//
// The server side is complete (the `crm` tRPC router); this modal only drives
// the UI. Every user-visible error comes straight from the server (already
// human, non-technical) and is shown verbatim.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "./client";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { BrandIcon } from "../BrandIcon";
import { electron } from "../electron";

/** Attribute types the sync supports (the server's neutral union — every provider maps into it). */
const SUPPORTED_ATTR_TYPES = [
  "text",
  "personal-name",
  "email-address",
  "domain",
  "phone-number",
  "number",
  "currency",
  "date",
  "timestamp",
  "checkbox",
  "select",
  "status",
  "rating",
  "location",
  "record-reference",
  "actor-reference",
] as const;

export type CrmProviderId = "attio" | "hubspot";

/** Per-provider display bits — the only provider-specific knowledge this modal holds. */
const PROVIDERS: Record<CrmProviderId, {
  readonly name: string;
  readonly logo: string;
  readonly pickSub: string;
  readonly readScope: string;
}> = {
  attio: {
    name: "Attio",
    logo: "https://www.google.com/s2/favicons?domain=attio.com&sz=128",
    pickSub: "People, Companies, Deals, custom objects and lists",
    readScope: "Read people, companies, deals & lists",
  },
  hubspot: {
    name: "HubSpot",
    logo: "https://www.google.com/s2/favicons?domain=hubspot.com&sz=128",
    pickSub: "Contacts, Companies and saved lists",
    readScope: "Read contacts, companies & lists",
  },
};

/** The six filter operators, in the order the design lists them. */
const FILTER_OPS = ["is", "is not", "contains", "is known", "is unknown", "after"] as const;
type FilterOp = (typeof FILTER_OPS)[number];
/** Operators that take no value input (presence checks). */
const VALUELESS_OPS = new Set<FilterOp>(["is known", "is unknown"]);

type SourceKind = "object" | "list";

/** One syncable Attio source (crm.listSources). */
interface CrmSource {
  readonly kind: SourceKind;
  readonly id: string;
  readonly label: string;
  readonly parentObject: string | null;
}

/** One attribute of a source (crm.describeSource). */
interface CrmField {
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly recommended: boolean;
  readonly sample: string;
}

/** A draft filter row (mapped to the server `CrmFilter` on submit). */
interface DraftFilter {
  readonly id: number;
  attrSlug: string;
  op: FilterOp;
  value: string;
}

type DedupeMode = "update" | "skip" | "create";

/**
 * The exact `filters` payload the crm procedures accept (its `attrType` is a
 * strict Attio-attribute-type union, not `string`). Derived from the client so
 * we never redeclare the server's union in the desktop.
 */
type CrmFilterPayload = NonNullable<Parameters<typeof apiClient.crm.estimate.query>[0]>["filters"];

interface DedupeOption {
  readonly id: DedupeMode;
  readonly label: string;
  /** `{k}` is replaced with the match-key field title. */
  readonly desc: string;
}
const DEDUPE_OPTIONS: readonly DedupeOption[] = [
  { id: "update", label: "Update existing", desc: "Match on {k}, refresh changed fields" },
  { id: "skip", label: "Skip existing", desc: "Only add records not already in the grid" },
  { id: "create", label: "Always create", desc: "Import every record as a new row" },
];

const StepDot = ({ n, state }: { n: number; state: "done" | "active" | "todo" }) => (
  <span className={`crmw-step-dot crmw-step-${state}`}>
    {state === "done" ? (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
    ) : (
      n
    )}
  </span>
);

export function CrmSyncWizard({
  workspaceId,
  createTable,
  deleteTable,
  onClose,
  onCreated,
  connectedSignal,
}: {
  /** The active workspace (all crm procedures are member-gated on it). */
  workspaceId: string;
  /** Create the empty cloud table the binding fills; returns its id. */
  createTable: (name: string) => Promise<string>;
  /** Best-effort rollback when binding creation fails after the table exists. */
  deleteTable: (tableId: string) => Promise<void>;
  onClose: () => void;
  /** Navigate to the freshly-created synced table. */
  onCreated: (tableId: string) => void;
  /**
   * Bumped by App when the `crm-connected` deep link lands, so a wizard sitting
   * on the Connect step re-checks the connection immediately (rather than
   * waiting for the next 2s poll tick).
   */
  connectedSignal?: number;
}) {
  type Step = "pick" | "connect" | "configure";
  const [step, setStep] = useState<Step>("pick");

  // The CRM being connected/configured; every crm.* call threads it through.
  const [provider, setProvider] = useState<CrmProviderId>("attio");
  const providerDef = PROVIDERS[provider];

  // Connection
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connectedMeta, setConnectedMeta] = useState<{ connectedByName: string; workspaceLabel: string } | null>(null);
  const [authorizing, setAuthorizing] = useState(false);

  // Sources + selection
  const [sourceTab, setSourceTab] = useState<SourceKind>("object");
  const [sources, setSources] = useState<CrmSource[]>([]);
  const [selected, setSelected] = useState<CrmSource | null>(null);
  const [fields, setFields] = useState<CrmField[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [suggestedMatchKey, setSuggestedMatchKey] = useState<string | null>(null);
  const [matchKeyAttr, setMatchKeyAttr] = useState<string | null>(null);
  const [filters, setFilters] = useState<DraftFilter[]>([]);
  const [dedupe, setDedupe] = useState<DedupeMode>("update");

  const [estimate, setEstimate] = useState<{ count: number; isLowerBound: boolean } | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const filterIdRef = useRef(1);

  // ── Connection status: on open, learn whether the CRM is configured + connected.
  const refetchConnection = useCallback(async (p: CrmProviderId) => {
    try {
      const s = await apiClient.crm.connectionStatus.query({ workspaceId, provider: p });
      if (s == null) {
        // Older/mock server without the crm router: treat as unconfigured.
        setConfigured(false);
        setConnectedMeta(null);
        return false;
      }
      setConfigured(s.configured);
      if (s.connected) {
        setConnectedMeta({
          connectedByName: s.connectedByName,
          // Servers predating the neutral field only send the attio alias.
          workspaceLabel: s.workspaceLabel ?? s.attioWorkspaceName,
        });
        return true;
      }
      setConnectedMeta(null);
      return false;
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not check the ${PROVIDERS[p].name} connection.`);
      return false;
    }
  }, [workspaceId]);

  // ── Load a source's fields + suggested match key, seed the recommended set.
  const loadSource = useCallback(
    async (src: CrmSource) => {
      setSelected(src);
      setLoadingSource(true);
      setError(null);
      setEstimate(null);
      setFilters([]);
      try {
        const r = await apiClient.crm.describeSource.query({
          workspaceId,
          provider,
          kind: src.kind,
          id: src.id,
          label: src.label,
        });
        const fs = r.fields as CrmField[];
        setFields(fs);
        setChosen(new Set(fs.filter((f) => f.recommended).map((f) => f.slug)));
        setSuggestedMatchKey(r.suggestedMatchKey);
        setMatchKeyAttr(r.suggestedMatchKey);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load this source.");
        setFields([]);
        setChosen(new Set());
      } finally {
        setLoadingSource(false);
      }
    },
    [workspaceId, provider],
  );

  // ── Enter the Configure step: fetch sources, auto-select the first object.
  const enterConfigure = useCallback(async () => {
    setStep("configure");
    setError(null);
    try {
      const list = (await apiClient.crm.listSources.query({ workspaceId, provider })) as CrmSource[];
      setSources(list);
      const firstObject = list.find((s) => s.kind === "object") ?? list[0];
      if (firstObject) {
        setSourceTab(firstObject.kind);
        await loadSource(firstObject);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your CRM sources.");
    }
  }, [workspaceId, provider, loadSource]);

  // Pick a CRM: if already connected jump to Configure, else the Connect step.
  const pickProvider = useCallback(async (p: CrmProviderId) => {
    setProvider(p);
    const connected = await refetchConnection(p);
    if (connected) void enterConfigure();
    else setStep("connect");
  }, [refetchConnection, enterConfigure]);

  // ── Connect: open the CRM's OAuth externally, then poll until connected.
  const connect = useCallback(async () => {
    setError(null);
    try {
      const { url } = await apiClient.crm.authorizeUrl.query({ workspaceId, provider });
      await openExternalUrl(url);
      setAuthorizing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not start the ${providerDef.name} connection.`);
    }
  }, [workspaceId, provider, providerDef.name]);

  // Poll connectionStatus every 2s while authorizing; advance once connected.
  useEffect(() => {
    if (!authorizing) return;
    let cancelled = false;
    const tick = async () => {
      const connected = await refetchConnection(provider);
      if (cancelled) return;
      if (connected) {
        setAuthorizing(false);
        void enterConfigure();
      }
    };
    const h = setInterval(() => void tick(), 2000);
    return () => { cancelled = true; clearInterval(h); };
  }, [authorizing, provider, refetchConnection, enterConfigure]);

  // The `crm-connected` deep link accelerates the poll: re-check immediately.
  const lastConnectedSignal = useRef(connectedSignal ?? 0);
  useEffect(() => {
    const sig = connectedSignal ?? 0;
    if (sig === lastConnectedSignal.current) return;
    lastConnectedSignal.current = sig;
    if (step !== "connect") return;
    void (async () => {
      const connected = await refetchConnection(provider);
      if (connected) { setAuthorizing(false); void enterConfigure(); }
    })();
  }, [connectedSignal, step, provider, refetchConnection, enterConfigure]);

  // ── Estimate (debounced) whenever the source or its filters change.
  const validFilters = useMemo<CrmFilterPayload>(
    () =>
      filters
        .filter((f) => f.attrSlug && (VALUELESS_OPS.has(f.op) || f.value.trim() !== ""))
        .map((f) => ({
          attrSlug: f.attrSlug,
          attrType: fields.find((x) => x.slug === f.attrSlug)?.type ?? "text",
          op: f.op,
          value: VALUELESS_OPS.has(f.op) ? "" : f.value,
        })) as CrmFilterPayload,
    [filters, fields],
  );
  useEffect(() => {
    if (step !== "configure" || !selected) return;
    let cancelled = false;
    const h = setTimeout(() => {
      void apiClient.crm.estimate
        .query({ workspaceId, provider, kind: selected.kind, id: selected.id, label: selected.label, filters: validFilters })
        .then((r) => { if (!cancelled) setEstimate({ count: r.count, isLowerBound: r.isLowerBound }); })
        .catch(() => { if (!cancelled) setEstimate(null); });
    }, 400);
    return () => { cancelled = true; clearTimeout(h); };
  }, [step, selected, workspaceId, provider, validFilters]);

  const switchTab = (tab: SourceKind) => {
    setSourceTab(tab);
    const first = sources.find((s) => s.kind === tab);
    if (first) void loadSource(first);
  };
  const toggleField = (slug: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  const resetFields = () => setChosen(new Set(fields.filter((f) => f.recommended).map((f) => f.slug)));

  const addFilter = () => {
    const first = fields[0];
    if (!first) return;
    setFilters((fs) => [...fs, { id: filterIdRef.current++, attrSlug: first.slug, op: "is", value: "" }]);
  };
  const updateFilter = (id: number, patch: Partial<DraftFilter>) =>
    setFilters((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const removeFilter = (id: number) => setFilters((fs) => fs.filter((f) => f.id !== id));

  const matchKeyTitle = fields.find((f) => f.slug === matchKeyAttr)?.title ?? "match key";
  const chosenCount = chosen.size;

  const startSync = async () => {
    if (!selected || chosenCount === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      // The binding needs a tableId, so the table is created first; if binding
      // creation then fails, roll the empty table back — otherwise every retry
      // would strand another orphan table in the sidebar.
      const tableId = await createTable(selected.label);
      const chosenFields = fields
        .filter((f) => chosen.has(f.slug))
        .flatMap((f) => {
          // Narrow the wire `type: string` to the router's attr-type union;
          // the server only returns supported types, so this never drops in
          // practice — it just proves it to the compiler without a cast.
          const attrType = SUPPORTED_ATTR_TYPES.find((t) => t === f.type);
          return attrType === undefined ? [] : [{ attrSlug: f.slug, attrType, title: f.title }];
        });
      try {
        await apiClient.crm.createBinding.mutate({
          workspaceId,
          provider,
          tableId,
          sourceKind: selected.kind,
          sourceId: selected.id,
          sourceLabel: selected.label,
          fields: chosenFields,
          filters: validFilters,
          dedupeMode: dedupe,
          matchKeyAttr: dedupe === "update" ? matchKeyAttr : null,
        });
      } catch (bindErr) {
        await deleteTable(tableId).catch(() => {}); // best-effort rollback
        throw bindErr;
      }
      onCreated(tableId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the sync.");
      setSubmitting(false);
    }
  };

  const stepState = (s: Step): "done" | "active" | "todo" => {
    const order: Step[] = ["pick", "connect", "configure"];
    const cur = order.indexOf(step);
    const idx = order.indexOf(s);
    return idx < cur ? "done" : idx === cur ? "active" : "todo";
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal crmw-modal" srTitle="Sync a table from your CRM">
        {/* Header + stepper */}
        <div className="crmw-head">
          <div className="crmw-head-row">
            <span className="crmw-title">Sync a table from your CRM</span>
            <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="crmw-stepper">
            <span className={`crmw-step ${stepState("pick") === "todo" ? "crmw-step-muted" : ""}`}>
              <StepDot n={1} state={stepState("pick")} />Choose CRM
            </span>
            <span className="crmw-step-line" />
            <span className={`crmw-step ${stepState("connect") === "todo" ? "crmw-step-muted" : ""}`}>
              <StepDot n={2} state={stepState("connect")} />Connect
            </span>
            <span className="crmw-step-line" />
            <span className={`crmw-step ${stepState("configure") === "todo" ? "crmw-step-muted" : ""}`}>
              <StepDot n={3} state={stepState("configure")} />Configure
            </span>
          </div>
        </div>

        <div className="crmw-body">
          {step === "pick" && (
            <div className="crmw-pick">
              <span className="crmw-pick-q">Which CRM do you want to pull records from?</span>
              {(Object.keys(PROVIDERS) as CrmProviderId[]).map((p) => (
                <button key={p} className="crmw-crm-card" onClick={() => void pickProvider(p)}>
                  <BrandIcon logo={PROVIDERS[p].logo} name={PROVIDERS[p].name} size={34} />
                  <span className="crmw-crm-text">
                    <span className="crmw-crm-name">{PROVIDERS[p].name}</span>
                    <span className="crmw-crm-sub">{PROVIDERS[p].pickSub}</span>
                  </span>
                  <span className="crmw-caret">›</span>
                </button>
              ))}
              <div className="crmw-reassure">
                <LockIcon />
                Read-only access. GTM Grid never writes back to your CRM.
              </div>
            </div>
          )}

          {step === "connect" && (
            <div className="crmw-connect">
              <BrandIcon logo={providerDef.logo} name={providerDef.name} size={48} />
              <span className="crmw-connect-title">Connect your {providerDef.name} account</span>
              <span className="crmw-connect-sub">
                You'll be sent to {providerDef.name} to authorize GTM Grid. We request a <strong>read-only</strong> scope
                so records can flow into the grid.
              </span>
              <div className="crmw-scopes">
                <span className="crmw-scopes-label">Requested access</span>
                <span className="crmw-scope"><CheckIcon />{providerDef.readScope}</span>
                <span className="crmw-scope"><CheckIcon />Object &amp; attribute schema</span>
                <span className="crmw-scope crmw-scope-no"><CrossIcon />No write / delete permissions</span>
              </div>
              {configured === false ? (
                <div className="crmw-error" role="alert">{providerDef.name} connection isn't available yet.</div>
              ) : authorizing ? (
                <button className="skill-btn primary crmw-connect-btn" disabled>
                  <span className="cell-spinner" style={{ width: 15, height: 15, borderWidth: 2 }} />
                  Authorizing with {providerDef.name}…
                </button>
              ) : (
                <button className="skill-btn primary crmw-connect-btn" onClick={() => void connect()}>
                  <BrandIcon logo={providerDef.logo} name={providerDef.name} size={18} />
                  Connect with {providerDef.name}
                </button>
              )}
              {error && <div className="crmw-error" role="alert">{error}</div>}
            </div>
          )}

          {step === "configure" && (
            <div className="crmw-config">
              {connectedMeta && (
                <div className="crmw-connected-banner">
                  <span className="crmw-connected-dot" />
                  <span className="crmw-connected-text">
                    Connected · {connectedMeta.workspaceLabel}
                    <span className="crmw-connected-by">connected by {connectedMeta.connectedByName}</span>
                  </span>
                  {/* Reauth path while healthy — e.g. after granting the app
                      new scopes in the CRM, re-consent picks them up. */}
                  <button className="crmw-link crmw-reconnect" onClick={() => void connect()}>
                    Reconnect
                  </button>
                  <BrandIcon logo={providerDef.logo} name={providerDef.name} size={16} />
                </div>
              )}

              {/* Source picker */}
              <div className="crmw-section">
                <div className="crmw-section-head">
                  <span className="crmw-section-label">What to sync</span>
                  <span className="crmw-tabs">
                    <button className={`crmw-tab ${sourceTab === "object" ? "crmw-tab-on" : ""}`} onClick={() => switchTab("object")}>Objects</button>
                    <button className={`crmw-tab ${sourceTab === "list" ? "crmw-tab-on" : ""}`} onClick={() => switchTab("list")}>Lists &amp; views</button>
                  </span>
                </div>
                <div className="crmw-source-grid">
                  {sources.filter((s) => s.kind === sourceTab).map((s) => {
                    const active = selected?.id === s.id && selected?.kind === s.kind;
                    return (
                      <button key={`${s.kind}:${s.id}`} className={`crmw-source ${active ? "crmw-source-on" : ""}`} onClick={() => void loadSource(s)}>
                        <BrandIcon logo={providerDef.logo} name={providerDef.name} size={18} />
                        <span className="crmw-source-text">
                          <span className="crmw-source-label">{s.label}</span>
                          <span className="crmw-source-sub">{s.kind === "list" ? "List" : "Object"}</span>
                        </span>
                        {active && <CheckIcon accent />}
                      </button>
                    );
                  })}
                  {sources.filter((s) => s.kind === sourceTab).length === 0 && (
                    <div className="crmw-empty">{sourceTab === "list" ? "No lists or views to sync." : "No objects to sync."}</div>
                  )}
                </div>
              </div>

              {loadingSource ? (
                <div className="crmw-loading"><span className="cell-spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /></div>
              ) : selected && fields.length > 0 ? (
                <>
                  {/* Fields → columns */}
                  <div className="crmw-section">
                    <div className="crmw-section-head">
                      <span className="crmw-section-label">Fields → columns · {chosenCount} of {fields.length}</span>
                      <button className="crmw-link" onClick={resetFields}>Reset to recommended</button>
                    </div>
                    <div className="crmw-fields">
                      {fields.map((f) => {
                        const on = chosen.has(f.slug);
                        return (
                          <button key={f.slug} className="crmw-field" onClick={() => toggleField(f.slug)}>
                            <span className={`crmw-check ${on ? "crmw-check-on" : ""}`}>
                              {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                            </span>
                            <span className="crmw-field-text">
                              <span className="crmw-field-title">{f.title}</span>
                              <span className="crmw-field-sample">{f.sample || "no sample values"}</span>
                            </span>
                            {f.recommended && <span className="crmw-chip crmw-chip-rec">Recommended</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Filters */}
                  <div className="crmw-section">
                    <div className="crmw-section-head">
                      <span className="crmw-section-label">Filters — what to pull</span>
                      <button className="crmw-link" onClick={addFilter}>+ Add filter</button>
                    </div>
                    {filters.length === 0 ? (
                      <div className="crmw-no-filters">No filters — every record in this source will be pulled.</div>
                    ) : (
                      <div className="crmw-filters">
                        {filters.map((f) => (
                          <div key={f.id} className="crmw-filter-row">
                            <select className="crmw-select crmw-filter-field" value={f.attrSlug} onChange={(e) => updateFilter(f.id, { attrSlug: e.target.value })}>
                              {fields.map((x) => <option key={x.slug} value={x.slug}>{x.title}</option>)}
                            </select>
                            <select className="crmw-select crmw-filter-op" value={f.op} onChange={(e) => updateFilter(f.id, { op: e.target.value as FilterOp })}>
                              {FILTER_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                            </select>
                            {!VALUELESS_OPS.has(f.op) && (
                              <input className="crmw-input crmw-filter-value" placeholder="Value" value={f.value} onChange={(e) => updateFilter(f.id, { value: e.target.value })} />
                            )}
                            <button className="crmw-filter-del" onClick={() => removeFilter(f.id)} aria-label="Remove filter">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Dedupe */}
                  <div className="crmw-section">
                    <span className="crmw-section-label">When a record already exists</span>
                    <div className="crmw-dedupe">
                      {DEDUPE_OPTIONS.map((d) => {
                        const active = dedupe === d.id;
                        return (
                          <button key={d.id} className={`crmw-radio-row ${active ? "crmw-radio-on" : ""}`} onClick={() => setDedupe(d.id)}>
                            <span className={`crmw-radio ${active ? "crmw-radio-fill" : ""}`} />
                            <span className="crmw-radio-text">
                              <span className="crmw-radio-title">{d.label}</span>
                              <span className="crmw-radio-desc">{d.desc.replace("{k}", matchKeyTitle)}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {dedupe === "update" && suggestedMatchKey === null && (
                      <div className="crmw-hint">This source has no obvious match key — "Update existing" will fall back to creating rows.</div>
                    )}
                  </div>
                </>
              ) : null}

              {error && <div className="crmw-error" role="alert">{error}</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        {step === "configure" && (
          <div className="crmw-footer">
            <span className="crmw-est">
              Est. <strong>{estimate ? `${estimate.count.toLocaleString()}${estimate.isLowerBound ? "+" : ""}` : "—"}</strong> records · <strong>{chosenCount}</strong> columns
            </span>
            <span style={{ flex: 1 }} />
            <button className="skill-btn ghost" onClick={onClose}>Cancel</button>
            <button className="skill-btn primary" onClick={() => void startSync()} disabled={submitting || !selected || chosenCount === 0}>
              {submitting ? "Starting…" : "Start sync"}
            </button>
          </div>
        )}
        {step === "connect" && (
          <div className="crmw-footer">
            <button className="skill-btn ghost" onClick={() => setStep("pick")}>‹ Back</button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Open a URL in the system browser (Electron when packaged, else a new tab). */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const api = electron();
    if (api) { await api.openExternal(url); return; }
  } catch {
    /* fall through to a browser tab */
  }
  const w = (globalThis as { window?: Window }).window;
  if (!w) return;
  const tab = w.open(url, "_blank", "noopener");
  if (!tab) w.location.assign(url);
}

const LockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
);
const CheckIcon = ({ accent }: { accent?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={accent ? "var(--accent)" : "var(--success)"} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12" /></svg>
);
const CrossIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
);
