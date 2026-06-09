/**
 * Share-a-table panel (cloud-only) — create + manage public share links for a
 * cloud table. Renders INLINE in the grid pane (like {@link WebhookModal}),
 * reusing the CSV import {@link Shell} so it matches the other table flows.
 *
 * A share link points at a FROZEN, read-only snapshot of the table (all columns
 * + all rows) at `${SITE_URL}/share/<token>`. Anyone with the link can open it
 * in a browser with no account, and hop into the desktop app to clone it. The
 * panel makes the "anyone with the link sees all data" trade-off explicit, and
 * lets the owner revoke a link at any time.
 */

import { useCallback, useState } from "react";
import type { Id } from "./ids";
import { Shell } from "../ImportCsvModal";
import { useShareMutations, useTableShares } from "./useCloudGrid";

// ── Local icons (stroke-2, currentColor) ────────────────────────────────────
const SI = {
  Share: ({ s = 18 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>
  ),
  Copy: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
  ),
  Check: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
  ),
  Trash: ({ s = 13 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
  ),
  ArrowLeft: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
  ),
  Table: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
  ),
};

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
    <button className={`copy-btn${done ? " done" : ""}`} onClick={copy} title="Copy link">
      {done ? <SI.Check s={13} /> : <SI.Copy s={13} />}
      {label && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

export interface ShareModalProps {
  /** The cloud table to share. */
  tableId: Id<"tables">;
  /** Table display name (header eyebrow + default share label). */
  tableName: string;
  /** Row count for the footer meta. */
  rowCount: number;
  /** Close the panel. */
  onClose: () => void;
  /** Render inline in the center pane (CloudGrid mounts it this way). */
  inline?: boolean;
}

export function ShareModal({
  tableId,
  tableName,
  rowCount,
  onClose,
  inline = true,
}: ShareModalProps) {
  const shares = useTableShares(tableId);
  const { createShare, revokeShare } = useShareMutations();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = useCallback(async (fn: () => Promise<unknown>) => {
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
  }, []);

  const onCreate = () => {
    if (creating) return;
    setCreating(true);
    void handle(() => createShare(tableId, { name: tableName })).finally(() =>
      setCreating(false),
    );
  };

  const liveShares = (shares ?? []).filter((s) => s.enabled);

  return (
    <Shell
      inline={inline}
      topRight={
        <a className="import-link" onClick={onClose}>
          Done
        </a>
      }
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>
            <SI.ArrowLeft s={14} /> Back
          </button>
          <span className="import-foot-meta">
            <SI.Table s={12} /> {tableName} ·{" "}
            <span className="import-mono">{rowCount}</span> rows
          </span>
          <span className="import-foot-spacer" />
          <button className="btn btn-primary btn-lg" onClick={onClose}>
            Done <SI.Check s={15} />
          </button>
        </>
      }
    >
      <div className="wh-wrap">
        <div className="import-eyebrow">Table · {tableName}</div>
        <div className="wh-head">
          <h1 className="import-title" style={{ marginBottom: 6 }}>
            Share this table
          </h1>
          <p className="import-sub" style={{ margin: 0, maxWidth: 580 }}>
            Create a public link to a read-only snapshot of this table — all
            columns and rows, frozen as they are now. Anyone with the link can
            open it in a browser, or pull it into their own GTM Grid project so
            their AI agent can rebuild the setup.
          </p>
        </div>

        {error && <div className="import-error">{error}</div>}

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "10px 14px",
            margin: "16px 0",
            borderRadius: 8,
            background: "rgba(217, 119, 6, 0.10)",
            border: "1px solid rgba(217, 119, 6, 0.30)",
            color: "var(--text-2, #b88)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <span aria-hidden style={{ fontSize: 15 }}>⚠️</span>
          <span>
            Anyone with the link can view <strong>all data</strong> in this
            table. It shows a snapshot frozen now — later edits won&apos;t change
            what they see. Connector credentials are never shared. Revoke a link
            anytime below.
          </span>
        </div>

        <button
          className="btn btn-primary"
          onClick={onCreate}
          disabled={creating}
        >
          <SI.Share s={14} /> {creating ? "Creating…" : "Create share link"}
        </button>

        <div className="form-section-label" style={{ marginTop: 22 }}>
          Active links
        </div>
        {liveShares.length === 0 ? (
          <div className="wh-empty">
            No share links yet. Create one to get a public URL.
          </div>
        ) : (
          liveShares.map((s) => (
            <div className="wh-field" key={s.id}>
              <div className="code-row">
                <code className="code-inline">{s.shareUrl}</code>
                <CopyBtn text={s.shareUrl} label="Copy" />
                <button
                  className="copy-btn"
                  title="Revoke this link"
                  onClick={() => handle(() => revokeShare(s.id, tableId))}
                >
                  <SI.Trash s={13} />
                </button>
              </div>
              <div className="field-hint">
                Created {new Date(s.createdAt).toLocaleString()}
                {s.expiresAt
                  ? ` · expires ${new Date(s.expiresAt).toLocaleString()}`
                  : " · never expires"}
              </div>
            </div>
          ))
        )}
      </div>
    </Shell>
  );
}
