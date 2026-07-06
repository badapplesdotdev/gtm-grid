// The redesigned update flow (Claude Design "Update Flow"): three surfaces
// sharing one visual language —
//
//   1. UpdateDialog   — offered update with version chips (current → new),
//                       categorized notes, a live download progress zone
//                       (downloading → verifying → ready), and phase-aware
//                       footer actions.
//   2. WhatsNewDialog — celebratory post-update "You're on vX" with the same
//                       categorized notes and a Full-changelog link.
//   3. ChangelogModal — every release, version rail + timeline cards.
//
// Notes come from the bundled changesets CHANGELOG.md (What's new/changelog)
// or the incoming GitHub release body (UpdateDialog), both categorized as
// Minor→"New" and Patch→"Improved & fixed" — the honest mapping for
// changesets-authored notes.

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { changelogAll, type ChangelogEntry } from "./changelog";
import { electron } from "./electron";
import type { UpdateCheck } from "./useUpdateCheck";

// ── Icons ─────────────────────────────────────────────────────────────────────

const DownloadIcon = ({ size = 20, bob = false }: { size?: number; bob?: boolean }) => (
  <svg className={bob ? "upd-bob" : undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
);
const StarIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.1L20.5 10l-6.3 1.9L12 18l-2.2-6.1L3.5 10l6.3-1.9z" /></svg>
);
const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
);
const ArrowRight = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
);
const RestartIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
);
const DocIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>
);
const XIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
);

// ── Shared: one categorized note section ──────────────────────────────────────

function NoteSection({
  kind,
  items,
  delay,
}: {
  kind: "new" | "fixed";
  items: readonly string[];
  delay?: number;
}) {
  if (items.length === 0) return null;
  return (
    <div className="upd-section upd-rise" style={delay !== undefined ? { animationDelay: `${delay}ms` } : undefined}>
      <span className={`upd-section-icon upd-section-icon-${kind}`}>
        {kind === "new" ? <StarIcon /> : <CheckIcon />}
      </span>
      <div className="upd-section-body">
        <div className="upd-section-title">{kind === "new" ? "New" : "Improved & fixed"}</div>
        <ul className="upd-section-list">
          {items.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>
    </div>
  );
}

// ── 1. Update dialog ──────────────────────────────────────────────────────────

export function UpdateDialog({
  check,
  currentVersion,
  error,
  onClose,
}: {
  check: UpdateCheck;
  currentVersion: string;
  /** Merged install/download failure copy (App owns the messaging). */
  error: string | null;
  onClose: () => void;
}) {
  const { update, phase, progress, download, install } = check;
  if (!update) return null;
  const busy = phase === "downloading" || phase === "verifying";
  const showProgress = busy || phase === "ready" || phase === "installing";
  const statusLabel =
    phase === "downloading" ? "Downloading update…"
      : phase === "verifying" ? "Verifying signature…"
        : phase === "ready" ? "Update ready — restart to install"
          : phase === "installing" ? "Restarting to install…" : "";
  const hasNotes = update.added.length > 0 || update.fixed.length > 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy && phase !== "installing") onClose(); }}>
      <DialogContent className="modal upd-modal" style={{ width: 472 }} srTitle="Update available">
        <div className="upd-head">
          <span className="upd-head-glow" aria-hidden />
          <span className="upd-head-icon"><DownloadIcon bob={phase === "available"} /></span>
          <div className="upd-head-text">
            <div className="upd-head-title">Update available</div>
            <div className="upd-chips">
              <span className="upd-chip">v{currentVersion}</span>
              <span className="upd-chip-arrow"><ArrowRight /></span>
              <span className="upd-chip upd-chip-accent">v{update.version}</span>
            </div>
          </div>
          <button className="upd-close" onClick={onClose} aria-label="Close" disabled={busy || phase === "installing"}><XIcon /></button>
        </div>

        {hasNotes && (
          <div className="upd-notes">
            <div className="upd-notes-label">In this release</div>
            <NoteSection kind="new" items={update.added} delay={60} />
            <NoteSection kind="fixed" items={update.fixed} delay={140} />
          </div>
        )}

        {showProgress && (
          <div className="upd-progress upd-rise">
            <div className="upd-progress-row">
              {phase === "ready" ? (
                <span className="upd-check-pop">
                  <span className="upd-check-ring" aria-hidden />
                  <span className="upd-check-dot">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path className="upd-check-draw" d="M20 6 9 17l-5-5" /></svg>
                  </span>
                </span>
              ) : (
                <span className="upd-spinner" aria-hidden />
              )}
              <span className={`upd-progress-label ${phase === "ready" ? "upd-progress-label-ready" : ""}`}>{statusLabel}</span>
              {phase === "downloading" && <span className="upd-progress-pct">{progress}%</span>}
            </div>
            <div className="upd-bar">
              <div
                className="upd-bar-fill"
                style={{ width: `${phase === "ready" || phase === "installing" || phase === "verifying" ? 100 : progress}%` }}
              >
                {busy && <span className="upd-bar-shimmer" aria-hidden />}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="upd-error" role="alert">
            {error}{" "}
            <button
              className="crmw-link"
              onClick={() => {
                const url = "https://www.gtmgrid.dev/download";
                const api = electron();
                if (api) void api.openExternal(url);
                else window.open(url, "_blank", "noopener");
              }}
            >
              Download it manually
            </button>{" "}
            and drag it into Applications — that clears anything blocking in-place updates.
          </div>
        )}

        <div className="upd-footer">
          {phase === "available" && (
            <>
              <button className="btn btn-outline" onClick={onClose}>Later</button>
              <button className="btn btn-primary upd-cta" onClick={download}>
                <DownloadIcon size={14} /> Download &amp; restart
              </button>
            </>
          )}
          {busy && (
            <button className="btn btn-primary upd-cta" disabled>
              <span className="upd-spinner upd-spinner-onaccent" aria-hidden />
              {phase === "verifying" ? "Verifying…" : `Downloading ${progress}%`}
            </button>
          )}
          {phase === "ready" && (
            <>
              <button className="btn btn-outline" onClick={onClose}>Later</button>
              <button className="btn btn-primary upd-cta upd-rise" onClick={() => void install()}>
                <RestartIcon /> Restart now
              </button>
            </>
          )}
          {phase === "installing" && (
            <button className="btn btn-primary upd-cta" disabled>
              <span className="upd-spinner upd-spinner-onaccent" aria-hidden />
              Restarting…
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── 2. What's new dialog ──────────────────────────────────────────────────────

export function WhatsNewDialog({
  version,
  entry,
  onOpenChangelog,
  onClose,
}: {
  version: string;
  entry: ChangelogEntry;
  onOpenChangelog: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal upd-modal" style={{ width: 452 }} srTitle={`What's new in version ${version}`}>
        <div className="upd-hero">
          <span className="upd-hero-glow" aria-hidden />
          <button className="upd-close upd-hero-close" onClick={onClose} aria-label="Close"><XIcon /></button>
          <span className="upd-hero-badge">
            <span className="upd-hero-ring" aria-hidden />
            <span className="upd-hero-spark" aria-hidden><StarIcon size={15} /></span>
            <svg className="upd-check-pop" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path className="upd-check-draw" d="M20 6 9 17l-5-5" /></svg>
          </span>
          <div className="upd-hero-title">You&rsquo;re on GTM Grid v{version}</div>
          <div className="upd-hero-sub">Here&rsquo;s what changed since your last update.</div>
        </div>

        <div className="upd-hero-divider" />

        <div className="upd-notes upd-notes-whatsnew">
          <NoteSection kind="new" items={entry.added} delay={100} />
          <NoteSection kind="fixed" items={entry.fixed} delay={180} />
        </div>

        <div className="upd-footer upd-footer-split">
          <button className="upd-changelog-link" onClick={onOpenChangelog}>
            Full changelog <ArrowRight size={12} />
          </button>
          <button className="btn btn-primary upd-cta" onClick={onClose}>Got it</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── 3. Full changelog modal ───────────────────────────────────────────────────

export function ChangelogModal({ currentVersion, onClose }: { currentVersion: string; onClose: () => void }) {
  const entries = useMemo(() => changelogAll(), []);
  const [selected, setSelected] = useState(currentVersion);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  // Rail click highlights + scrolls the matching timeline card into view.
  useEffect(() => {
    const el = timelineRef.current?.querySelector(`[data-version="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal upd-modal upd-changelog" srTitle="Changelog">
        <div className="upd-cl-head">
          <span className="upd-cl-head-icon"><DocIcon /></span>
          <div className="upd-cl-head-text">
            <div className="upd-head-title">Changelog</div>
            <div className="upd-cl-head-sub">Every GTM Grid desktop release</div>
          </div>
          <span className="upd-cl-current"><span className="upd-cl-current-dot" aria-hidden />You&rsquo;re on v{currentVersion}</span>
          <button className="upd-close" onClick={onClose} aria-label="Close"><XIcon size={16} /></button>
        </div>

        <div className="upd-cl-body">
          <nav className="upd-cl-rail" aria-label="Versions">
            <div className="upd-cl-rail-label">Versions</div>
            {entries.map((e) => {
              const active = e.version === selected;
              const current = e.version === currentVersion;
              return (
                <button
                  key={e.version}
                  className={`upd-cl-rail-item ${active ? "upd-cl-rail-item-on" : ""}`}
                  onClick={() => setSelected(e.version)}
                >
                  <span className={`upd-cl-dot ${current || active ? "upd-cl-dot-accent" : ""}`} aria-hidden />
                  <span className="upd-cl-rail-v">v{e.version}</span>
                  {current && <span className="upd-cl-now">Now</span>}
                </button>
              );
            })}
          </nav>

          <div className="upd-cl-timeline" ref={timelineRef}>
            {entries.map((e) => {
              const active = e.version === selected;
              const current = e.version === currentVersion;
              return (
                <div key={e.version} className="upd-cl-entry" data-version={e.version}>
                  <span className={`upd-cl-entry-dot ${current || active ? "upd-cl-entry-dot-accent" : ""}`} aria-hidden />
                  <div className={`upd-cl-card ${active ? "upd-cl-card-on" : ""}`}>
                    <div className="upd-cl-card-head">
                      <span className="upd-cl-card-v">v{e.version}</span>
                      {current && <span className="upd-cl-installed">Installed</span>}
                    </div>
                    <NoteSection kind="new" items={e.added} />
                    <NoteSection kind="fixed" items={e.fixed} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
