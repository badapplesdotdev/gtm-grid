// Command-palette project switcher: search the active workspace's CLOUD projects
// (Postgres-backed, live multiplayer), open one, or create a new one. The desktop
// is cloud-only — there is no local project list — so the switcher is driven
// entirely by the `cloud` section.

import { useState, useMemo } from "react";
import type { CloudProject } from "./cloud/useCloudGrid";

const SearchIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const CheckIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
/** Cloud glyph — reused by the unified Tables list (TRI-3313-C) to mark cloud /
 *  synced rows. */
export const CloudIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  </svg>
);

/** The cloud-projects section the switcher lists/selects (workspace-scoped). */
export interface CloudProjectsSection {
  /** The active workspace's cloud projects, or `undefined` while loading. */
  readonly projects: readonly CloudProject[] | undefined;
  /** The currently-open cloud project id (for the check mark), if any. */
  readonly activeId: string | null;
  /** Open a cloud project (route the app to its live grid). */
  readonly onSelect: (project: CloudProject) => void;
  /** Create a new cloud project in the active workspace. */
  readonly onCreate: (name: string) => Promise<void>;
}

export function ProjectSwitcher({
  onClose,
  cloud,
}: {
  onClose: () => void;
  /** The cloud-projects section that drives the switcher. */
  cloud: CloudProjectsSection;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [creatingCloud, setCreatingCloud] = useState(false);
  const [newCloudName, setNewCloudName] = useState("");
  const [cloudError, setCloudError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();

  const filteredCloud = useMemo(
    () =>
      cloud.projects
        ? q
          ? cloud.projects.filter((p) => p.name.toLowerCase().includes(q))
          : cloud.projects
        : [],
    [cloud.projects, q],
  );

  const createCloud = async () => {
    const name = newCloudName.trim();
    if (!name) return;
    setBusy(true);
    setCloudError(null);
    try {
      await cloud.onCreate(name);
      setNewCloudName("");
      setCreatingCloud(false);
    } catch (e) {
      // Keep the create form open and show the failure instead of closing as
      // if it had succeeded.
      setCloudError(e instanceof Error ? e.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay overlay-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="palette-search-icon">{SearchIcon}</span>
          <input
            className="palette-input"
            placeholder="Search projects…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && filteredCloud[0]) cloud.onSelect(filteredCloud[0]);
            }}
          />
          <button className="palette-esc" onClick={onClose}>ESC</button>
        </div>

        <div className="palette-body">
          <div className="palette-label">Workspace (cloud)</div>
          {cloud.projects === undefined ? (
            <div style={{ padding: "4px 16px", fontSize: 12, color: "var(--text-3)" }}>Loading…</div>
          ) : filteredCloud.length === 0 ? (
            <div style={{ padding: "4px 16px", fontSize: 12, color: "var(--text-3)" }}>No cloud projects yet</div>
          ) : (
            filteredCloud.map((p) => (
              <button
                key={p._id}
                className="palette-row"
                onClick={() => cloud.onSelect(p)}
                disabled={busy}
              >
                <span className="palette-row-icon">{CloudIcon}</span>
                <span className="palette-row-text">
                  <span className="palette-row-name">{p.name}</span>
                  <span className="palette-row-path">Live multiplayer</span>
                </span>
                {p._id === cloud.activeId && <span className="palette-row-check">{CheckIcon}</span>}
              </button>
            ))
          )}
          {creatingCloud ? (
            <>
              <div className="palette-create">
                <span className="palette-row-icon">{CloudIcon}</span>
                <input
                  className="palette-create-input"
                  placeholder="Cloud project name…"
                  value={newCloudName}
                  autoFocus
                  onChange={(e) => setNewCloudName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createCloud();
                    if (e.key === "Escape") { setCreatingCloud(false); setNewCloudName(""); setCloudError(null); }
                  }}
                />
                <button className="btn btn-primary btn-sm" onClick={() => void createCloud()} disabled={busy || !newCloudName.trim()}>
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
              {cloudError && (
                <div className="account-menu-error" role="alert" style={{ margin: "4px 16px" }}>
                  {cloudError}
                </div>
              )}
            </>
          ) : (
            <button className="palette-row" onClick={() => setCreatingCloud(true)} disabled={busy}>
              <span className="palette-row-icon">{PlusIcon}</span>
              <span className="palette-row-name">New cloud project…</span>
            </button>
          )}
        </div>

        <div className="palette-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
