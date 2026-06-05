// Command-palette project switcher: search recent projects, open one, or
// create a new project. Projects live in ~/gtmgrid/ and switch in-process.

import { useState, useEffect, useMemo } from "react";
import { api, ProjectInfo } from "./api";

const DbIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" />
  </svg>
);
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

export function ProjectSwitcher({
  current,
  onClose,
  onSwitched,
}: {
  current: string;
  onClose: () => void;
  onSwitched: (name: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects),
    [projects, q],
  );

  const open = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.switchProject(name);
      onSwitched(name);
    } catch {
      setBusy(false);
    }
  };

  const create = async () => {
    const name = newName.trim().replace(/[/\\]/g, "");
    if (!name) return;
    setBusy(true);
    try {
      await api.createProject(name);
      onSwitched(name);
    } catch {
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
              if (e.key === "Enter" && filtered[0]) open(filtered[0].name);
            }}
          />
          <button className="palette-esc" onClick={onClose}>ESC</button>
        </div>

        <div className="palette-body">
          {filtered.length > 0 && <div className="palette-label">Recent</div>}
          {filtered.map((p) => (
            <button key={p.name} className="palette-row" onClick={() => open(p.name)} disabled={busy}>
              <span className="palette-row-icon">{DbIcon}</span>
              <span className="palette-row-text">
                <span className="palette-row-name">{p.name}</span>
                <span className="palette-row-path">{p.path}</span>
              </span>
              {p.name === current && <span className="palette-row-check">{CheckIcon}</span>}
            </button>
          ))}

          <div className="palette-sep" />

          {creating ? (
            <div className="palette-create">
              <span className="palette-row-icon">{PlusIcon}</span>
              <input
                className="palette-create-input"
                placeholder="Project name…"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                  if (e.key === "Escape") { setCreating(false); setNewName(""); }
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={create} disabled={busy || !newName.trim()}>
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          ) : (
            <button className="palette-row" onClick={() => setCreating(true)} disabled={busy}>
              <span className="palette-row-icon">{PlusIcon}</span>
              <span className="palette-row-name">New Project…</span>
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
