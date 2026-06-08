"use client";

// Quick-start terminal card. Tabs reflect how the app is ACTUALLY distributed
// (verified against README.md): run from source, drive it from Claude Code over
// the real MCP server, or grab the signed desktop build. No fabricated
// brew/winget/curl one-liners — those don't exist for this project.

import { useState } from "react";

interface Tab {
  readonly id: string;
  readonly label: string;
  readonly comment: string;
  readonly cmd: string;
}

const TABS: readonly Tab[] = [
  {
    id: "source",
    label: "From source",
    comment: "# Clone and run from source. Needs Node 20+ and pnpm.",
    cmd: "git clone https://github.com/badapplesdotdev/gtm-grid.git && cd gtm-grid && pnpm install && pnpm tauri:dev",
  },
  {
    id: "claude",
    label: "Claude Code",
    comment: "# Drive the grid from your terminal Claude Code over MCP.",
    cmd: 'claude mcp add gtmgrid -s user -e GTMGRID_PROJECT=default -- "$HOME/dev/gtmgrid/bin/gtmgrid-mcp"',
  },
  {
    id: "app",
    label: "Desktop app",
    comment: "# Prefer a click? Grab the signed build for macOS, Windows or Linux.",
    cmd: "open https://gtmgrid.com/download",
  },
];

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function QuickStart() {
  const [active, setActive] = useState<string>(TABS[0].id);
  const [copied, setCopied] = useState(false);
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];

  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(tab.cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="qs-card">
      <div className="qs-bar">
        <div className="traffic"><i /><i /><i /></div>
        <div className="qs-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`qs-tab${t.id === active ? " active" : ""}`}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="qs-bar-right">
          <span className="qs-beta">β BETA</span>
        </div>
      </div>
      <div className="qs-body">
        <div className="qs-comment">{tab.comment}</div>
        <div className="qs-cmd-row">
          <span className="qs-prompt">$</span>
          <code className="qs-cmd">{tab.cmd}</code>
          <button type="button" className="qs-copy" title="Copy" aria-label="Copy command" onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}
