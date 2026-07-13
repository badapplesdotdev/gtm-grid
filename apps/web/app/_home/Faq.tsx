"use client";

// FAQ accordion. One item open at a time; the open panel animates its height via
// max-height (the design's `.faq-a` transition). React owns the open index instead
// of toggling classes imperatively.

import { useState } from "react";

const ITEMS: ReadonlyArray<{ q: string; a: React.ReactNode }> = [
  {
    q: 'What do you mean by "headless"?',
    a: "The engine isn't tied to a dashboard. The same tables, function columns, and connectors are driven from Claude Code, an MCP client, the CLI, a REST call, or a webhook — and the desktop grid is just one head on top, so you can watch every row fill as it runs.",
  },
  {
    q: "Where does my data live?",
    a: (
      <>
        In Postgres — your own self-hosted instance (a local Docker image or your own server) for free, or our managed cloud. Either way your connector and AI keys stay in a local encrypted vault, column logic runs in a local QuickJS sandbox, and the only outbound traffic is the connector and AI calls <em>you</em> trigger, sent directly to those providers.
      </>
    ),
  },
  {
    q: "Do I have to use the cloud?",
    a: "No. Grid is source-available (FSL-1.1-MIT) and free to self-host — point it at your own Postgres and you're unlimited, local and solo. Cloud is an optional layer you turn on only when a grid needs to run without you: scheduled refreshes while your laptop's closed, webhook triggers, team workspaces, and shared credentials. If you never need those, you never pay.",
  },
  {
    q: 'What does "bring your own key" mean for cost?',
    a: "You add your own Anthropic / OpenAI key and your existing connector keys. Grid adds no markup — you pay providers their list price, and the app itself is free. AI columns can also run on your own Claude Code or Codex subscription.",
  },
  {
    q: "How do I add a connector that isn't bundled?",
    a: (
      <>
        Drop a JSON manifest into <code>extensions/</code> with a <code>baseUrl</code>, an <code>auth</code> block, and your <code>methods</code>. It immediately becomes an <code>sdk.&lt;id&gt;.&lt;method&gt;()</code> call, an MCP tool the agent can use, and a connection form in the UI.
      </>
    ),
  },
  {
    q: "Do I have to use the AI agent?",
    a: "No. The grid works fully on its own — add columns, pick functions, hit Run. The Claude Code / Codex panel is there when you'd rather describe what you want than click through it.",
  },
  {
    q: "Which platforms are supported?",
    a: "It's a Tauri v2 desktop app. Signed builds ship for macOS, Windows, and Linux; the CLI and MCP server run anywhere Node does.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="faq-list" id="faq">
      {ITEMS.map((item, i) => {
        const isOpen = open === i;
        return (
          <div className={`faq-item${isOpen ? " open" : ""}`} key={i}>
            <button className="faq-q" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}>
              {item.q}
              <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <div className="faq-a" style={{ maxHeight: isOpen ? 600 : undefined }}>
              <div className="faq-a-inner">{item.a}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
