/**
 * Webhook setup form (cloud-only) — the desktop recreation of the design's
 * `flow/webhook.jsx` `WebhookTrigger`, bound to the real Convex backend.
 *
 * A cloud table gets a unique inbound POST endpoint: POST JSON → the field
 * mapping projects payload paths onto columns → a row is created (or upserted) →
 * the table's function columns auto-run (when enabled). This component is the
 * member-facing config surface for that webhook.
 *
 * It reuses the CSV import's full-screen {@link Shell} so it matches the rest of
 * the table-creation flows, and the `import-toggle` switch markup for every
 * Switch. Every control is LIVE-on-change: toggling enable calls `toggleEnabled`,
 * rotating calls `rotateSecret`, mapping edits call `updateWebhookMapping`, and
 * the behaviour controls call `updateWebhookConfig`. "Save trigger" just closes —
 * there is nothing buffered to commit.
 *
 * Deliveries: the "Recent deliveries" section is bound to REAL data — the
 * per-event `webhookDeliveries` log via `listDeliveriesPaged` (the
 * {@link useWebhookDeliveries} hook, cursor-paginated with a "Load more"
 * control). No fabricated/optimistic delivery rows.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { Column } from "../api";
import { Shell } from "../ImportCsvModal";
import { INNGEST_URL } from "./convex";
import {
  type CloudWebhook,
  type WebhookMappingEntry,
  useWebhookDeliveries,
  useWebhookMutations,
  useWebhooks,
} from "./useCloudGrid";

// ── Local icons (the shared Icon set lacks these; stroke-2, currentColor) ────
const WI = {
  Webhook: ({ s = 18 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17a4 4 0 0 1 3.6-3.98" /><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" /></svg>
  ),
  RotateCw: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
  ),
  Eye: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>
  ),
  EyeOff: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
  ),
  Copy: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
  ),
  Check: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
  ),
  Zap: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
  ),
  ChevronDown: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
  ),
  ArrowRight: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
  ),
  ArrowLeft: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
  ),
  Table: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
  ),
  Plus: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
  ),
  X: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
  ),
};

/** Mono type glyph + colour per column type — mirrors the CSV import's TYPE_META. */
function typeGlyph(type: string): { glyph: string; color: string } {
  switch (type) {
    case "number":
      return { glyph: "#", color: "#2563eb" };
    case "boolean":
      return { glyph: "◑", color: "var(--accent)" };
    case "date":
      return { glyph: "▦", color: "#d97706" };
    default:
      return { glyph: "T", color: "var(--text-3)" };
  }
}

/** Copy-to-clipboard button with a transient "Copied" confirmation. */
function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable — silently no-op */
    }
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <button className={`copy-btn${done ? " done" : ""}`} onClick={copy} title="Copy">
      {done ? <WI.Check s={13} /> : <WI.Copy s={13} />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

/** The desktop Switch — same markup/CSS as the CSV import header toggle. */
function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`import-toggle${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="import-toggle-knob" />
    </button>
  );
}

export interface WebhookModalProps {
  /** The cloud table this webhook drives. */
  tableId: Id<"tables">;
  /** Columns of the table (for the mapping select + type glyphs). */
  columns: Column[];
  /** Table display name (header eyebrow / footer meta). */
  tableName: string;
  /** Row count for the footer meta. */
  rowCount: number;
  /** Close the form. */
  onClose: () => void;
}

export function WebhookModal({
  tableId,
  columns,
  tableName,
  rowCount,
  onClose,
}: WebhookModalProps) {
  const webhooks = useWebhooks(tableId);
  const {
    createWebhook,
    updateMapping,
    updateConfig,
    toggleEnabled,
    rotateSecret,
  } = useWebhookMutations();

  // The single webhook for this table (the panel manages exactly one). When the
  // table has none yet, lazily create one the first time the panel needs it.
  const webhook: CloudWebhook | undefined = webhooks?.[0];

  // Real, member-gated per-event delivery log for this webhook (newest first),
  // cursor-paginated: 20 to start, "Load more" pages 20 at a time.
  const {
    results: deliveries,
    status: deliveriesStatus,
    loadMore: loadMoreDeliveries,
  } = useWebhookDeliveries(webhook?._id);

  const [creating, setCreating] = useState(false);
  const [revealSecret, setRevealSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable mapping rows, seeded from the persisted mapping and flushed back to
  // Convex on change. Kept in local state so a path edit doesn't re-validate on
  // every keystroke (only valid {path, columnId} pairs are persisted).
  const [mapRows, setMapRows] = useState<WebhookMappingEntry[]>([]);
  useEffect(() => {
    if (webhook) setMapRows(webhook.mapping);
  }, [webhook?._id, webhook?.mapping]);

  const handle = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
      } catch (e: unknown) {
        const data = (e as { data?: { message?: string } })?.data;
        setError(
          data?.message ??
            (e instanceof Error ? e.message : "Something went wrong."),
        );
      }
    },
    [],
  );

  // Toggle enable. Creating the webhook lazily on first enable means a table only
  // gets an endpoint once the user opts in (matches "Turn on to generate…").
  const onToggleEnable = useCallback(
    (next: boolean) => {
      if (!webhook) {
        if (!next || creating) return;
        setCreating(true);
        void handle(async () => {
          await createWebhook(tableId);
        }).finally(() => setCreating(false));
        return;
      }
      void handle(() => toggleEnabled(webhook._id, next));
    },
    [webhook, creating, handle, createWebhook, tableId, toggleEnabled],
  );

  const enabled = webhook?.enabled ?? false;
  const mode = webhook?.mode ?? "create";
  const autoRun = webhook?.autoRun ?? true;
  const upsertKey = webhook?.upsertKey ?? null;
  const token = webhook?.token ?? "whk_pending";
  const signingSecret = webhook?.signingSecret ?? "whsec_pending";

  const url = `${INNGEST_URL}/api/webhooks/${token}`;
  const maskedSecret = `whsec_${"•".repeat(24)}`;

  const sampleBody = useMemo(() => {
    const sample = (c: Column): string => {
      if (c.type === "number") return "180";
      if (c.type === "boolean") return "true";
      return `"${c.name === "Domain" ? "perplexity.ai" : "Perplexity"}"`;
    };
    const lines = columns.slice(0, 3).map((c) => `  "${c.name}": ${sample(c)}`);
    return `{\n${lines.join(",\n")}\n}`;
  }, [columns]);

  const curl = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -H "X-GTMGrid-Signature: $SIG" \\
  -d '${sampleBody.replace(/\s+/g, " ")}'`;

  // ── Mapping editing (live-persisted on valid change) ──
  const persistMapping = useCallback(
    (rows: WebhookMappingEntry[]) => {
      if (!webhook) return;
      const valid = rows.filter((r) => r.path.trim() !== "");
      void handle(() => updateMapping(webhook._id, valid));
    },
    [webhook, handle, updateMapping],
  );

  const setMapPath = (i: number, path: string) => {
    setMapRows((rows) => {
      const next = rows.map((r, idx) => (idx === i ? { ...r, path } : r));
      persistMapping(next);
      return next;
    });
  };
  const setMapCol = (i: number, columnId: Id<"columns">) => {
    setMapRows((rows) => {
      const next = rows.map((r, idx) => (idx === i ? { ...r, columnId } : r));
      persistMapping(next);
      return next;
    });
  };
  const addMapRow = () => {
    const firstCol = columns[0];
    if (!firstCol) return;
    setMapRows((rows) => {
      const next = [...rows, { path: "", columnId: firstCol.id as Id<"columns"> }];
      return next;
    });
  };
  const removeMapRow = (i: number) => {
    setMapRows((rows) => {
      const next = rows.filter((_, idx) => idx !== i);
      persistMapping(next);
      return next;
    });
  };

  const onSetMode = (next: "create" | "upsert") => {
    if (!webhook) return;
    if (next === "upsert") {
      const key = upsertKey ?? (columns[0]?.id as Id<"columns"> | undefined);
      if (!key) {
        setError("Add a column before upserting.");
        return;
      }
      void handle(() => updateConfig(webhook._id, { mode: "upsert", upsertKey: key }));
    } else {
      void handle(() => updateConfig(webhook._id, { mode: "create" }));
    }
  };

  return (
    <Shell
      topRight={
        <a className="import-link" onClick={onClose}>
          Done
        </a>
      }
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>
            <WI.ArrowLeft s={14} /> Back
          </button>
          <span className="import-foot-meta">
            <WI.Table s={12} /> {tableName} ·{" "}
            <span className="import-mono">{rowCount}</span> rows
          </span>
          <span className="import-foot-spacer" />
          <button className="btn btn-primary btn-lg" onClick={onClose}>
            Save trigger <WI.Check s={15} />
          </button>
        </>
      }
    >
      <div className="wh-wrap">
        <div className="import-eyebrow">Table · {tableName}</div>
        <div className="wh-head">
          <h1 className="import-title" style={{ marginBottom: 6 }}>
            Webhook trigger
          </h1>
          <p className="import-sub" style={{ margin: 0, maxWidth: 560 }}>
            POST JSON to this table's endpoint to create a row. Every function
            column runs automatically — enrichment, scoring and copy, computed the
            moment data lands.
          </p>
        </div>

        {error && <div className="import-error">{error}</div>}

        {/* enable card */}
        <div className={`wh-enable${enabled ? " on" : ""}`}>
          <span className="whe-ico">
            <WI.Webhook s={18} />
          </span>
          <div className="whe-text">
            <div className="whe-title">Inbound webhook</div>
            <div className="whe-sub">
              {enabled
                ? "Listening — POST to the endpoint below to add rows."
                : "Turn on to generate this table's endpoint."}
            </div>
          </div>
          <span className={`wh-status ${enabled ? "live" : "off"}`}>
            <span className="ws-dot" />
            {enabled ? "Active" : "Disabled"}
          </span>
          <Switch checked={enabled} onChange={onToggleEnable} />
        </div>

        {enabled && webhook && (
          <div className="wh-body">
            {/* endpoint */}
            <div className="wh-field">
              <label className="field-label">
                Endpoint <span className="verb-badge">POST</span>
              </label>
              <div className="code-row">
                <code className="code-inline">{url}</code>
                <CopyBtn text={url} />
                <button
                  className="copy-btn"
                  title="Rotate URL & secret"
                  onClick={() => handle(() => rotateSecret(webhook._id))}
                >
                  <WI.RotateCw s={13} />
                </button>
              </div>
            </div>

            {/* signing secret */}
            <div className="wh-field">
              <label className="field-label">
                Signing secret <span className="opt">· HMAC-SHA256</span>
              </label>
              <div className="code-row">
                <code className="code-inline">
                  {revealSecret ? signingSecret : maskedSecret}
                </code>
                <button
                  className="copy-btn"
                  onClick={() => setRevealSecret((v) => !v)}
                  title={revealSecret ? "Hide" : "Reveal"}
                >
                  {revealSecret ? <WI.EyeOff s={14} /> : <WI.Eye s={14} />}
                </button>
                <CopyBtn text={signingSecret} />
              </div>
              <div className="field-hint">
                We sign every request — verify the{" "}
                <span className="import-mono">X-GTMGrid-Signature</span> header to
                confirm it came from us.
              </div>
            </div>

            <div className="wh-cols">
              {/* left: behaviour + mapping */}
              <div className="wh-col">
                <div className="form-section-label">On receive</div>
                <div className="wh-radio-group">
                  <button
                    className={`wh-radio${mode === "create" ? " on" : ""}`}
                    onClick={() => onSetMode("create")}
                  >
                    <span className="whr-dot" />
                    <span>
                      <span className="whr-name">Create a new row</span>
                      <span className="whr-sub">
                        Append every payload as a new record
                      </span>
                    </span>
                  </button>
                  <button
                    className={`wh-radio${mode === "upsert" ? " on" : ""}`}
                    onClick={() => onSetMode("upsert")}
                  >
                    <span className="whr-dot" />
                    <span>
                      <span className="whr-name">Upsert by column</span>
                      <span className="whr-sub">
                        Update if a match exists, else create
                      </span>
                    </span>
                  </button>
                </div>
                {mode === "upsert" && (
                  <div className="wh-upsert">
                    <span className="field-hint" style={{ margin: 0 }}>
                      Match on
                    </span>
                    <div className="role-select">
                      <select
                        value={upsertKey ?? ""}
                        onChange={(e) =>
                          handle(() =>
                            updateConfig(webhook._id, {
                              mode: "upsert",
                              upsertKey: e.target.value as Id<"columns">,
                            }),
                          )
                        }
                      >
                        {columns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <span className="chev">
                        <WI.ChevronDown s={13} />
                      </span>
                    </div>
                  </div>
                )}

                <label className="wh-autorun">
                  <Switch
                    checked={autoRun}
                    onChange={(v) =>
                      handle(() => updateConfig(webhook._id, { autoRun: v }))
                    }
                  />
                  <span className="whar-text">
                    <span className="whar-name">
                      <WI.Zap s={12} /> Auto-run function columns
                    </span>
                    <span className="whar-sub">
                      Recompute enrichment &amp; AI columns on every new row
                    </span>
                  </span>
                </label>

                <div className="form-section-label" style={{ marginTop: 20 }}>
                  Field mapping
                </div>
                <div className="wh-map">
                  {mapRows.length === 0 && (
                    <div className="wh-map-empty">
                      No mappings yet. Add one to route payload fields to columns.
                    </div>
                  )}
                  {mapRows.map((row, i) => {
                    const col = columns.find((c) => c.id === row.columnId);
                    const g = typeGlyph(col?.type ?? "text");
                    return (
                      <div className="wh-map-row" key={i}>
                        <input
                          className="map-key-input"
                          value={row.path}
                          placeholder="payload.field"
                          onChange={(e) => setMapPath(i, e.target.value)}
                        />
                        <span className="map-arrow">
                          <WI.ArrowRight s={12} />
                        </span>
                        <div className="map-col-select">
                          <span className="mc-type" style={{ color: g.color }}>
                            {g.glyph}
                          </span>
                          <select
                            value={row.columnId}
                            onChange={(e) =>
                              setMapCol(i, e.target.value as Id<"columns">)
                            }
                          >
                            {columns.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          className="map-remove"
                          title="Remove mapping"
                          onClick={() => removeMapRow(i)}
                        >
                          <WI.X s={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  className="wh-map-add"
                  onClick={addMapRow}
                  disabled={columns.length === 0}
                >
                  <WI.Plus s={12} /> Add mapping
                </button>
              </div>

              {/* right: try it + deliveries */}
              <div className="wh-col">
                <div className="form-section-label">Try it</div>
                <div className="code-block">
                  <div className="cb-bar">
                    <span>POST · cURL</span>
                    <CopyBtn text={curl} label="Copy" />
                  </div>
                  <pre className="cb-pre">{curl}</pre>
                </div>

                <div className="form-section-label" style={{ marginTop: 20 }}>
                  Recent deliveries
                </div>
                {deliveries.length === 0 ? (
                  <div className="wh-empty">
                    No deliveries yet. POST to the endpoint to see them here.
                  </div>
                ) : (
                  <>
                    <div className="wh-deliveries">
                      {deliveries.map((d) => {
                        const ok = d.status >= 200 && d.status < 300;
                        return (
                          <div className="wh-delivery" key={d._id}>
                            <span className={`wd-pill ${ok ? "ok" : "err"}`}>
                              <span className="wd-dot" />
                              Status Code: {d.status}
                            </span>
                            <span className="wd-meta">
                              POST · +{d.rowsAffected} row
                            </span>
                            <span className="wd-time import-mono">
                              {new Date(d.receivedAt).toLocaleTimeString(
                                "en-US",
                                { hour12: false },
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {deliveriesStatus === "CanLoadMore" && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => loadMoreDeliveries(20)}
                      >
                        Load more
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
