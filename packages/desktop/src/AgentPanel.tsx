// Right-side agent panel — the Revcode "Claude Code / Codex" tabs. Drives the
// gtmgrid grid by chatting with the user's already-authed local CLI (their Max /
// Codex plan) through the server's SSE agent bridge. Renders markdown, shows
// tool calls + results inline, supports stop + multi-turn, and refreshes the
// grid live as the agent calls mutating tools.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, API_BASE, type AgentStatus } from "./api";

type AgentKind = "claude" | "codex";

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}
interface Message {
  role: "user" | "assistant";
  text: string;
  tools: ToolCall[];
  error?: boolean;
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };

// Brand logomarks for the agent tabs (inline SVG — no network, ships offline).
const AGENT_LOGO: Record<AgentKind, ReactNode> = {
  claude: (
    <svg className="agent-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#D97757"
        d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.541Zm-.3712 10.2456 2.2914-5.9456 2.2914 5.9456Z"
      />
    </svg>
  ),
  codex: (
    <svg className="agent-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  ),
};

/* ── Minimal, dependency-free markdown renderer (safe React nodes) ── */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) nodes.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(<a key={k} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ text }: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      const body = part.replace(/^[a-zA-Z]*\n/, "");
      out.push(<pre key={`pre-${pi}`} className="md-pre"><code>{body}</code></pre>);
      return;
    }
    const lines = part.split("\n");
    let list: ReactNode[] | null = null;
    const flush = () => {
      if (list) {
        out.push(<ul key={`ul-${pi}-${out.length}`} className="md-ul">{list}</ul>);
        list = null;
      }
    };
    lines.forEach((line, li) => {
      const key = `${pi}-${li}`;
      const h = /^(#{1,3})\s+(.*)/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)/.exec(line);
      if (bullet) {
        (list ??= []).push(<li key={key}>{renderInline(bullet[1], key)}</li>);
      } else if (h) {
        flush();
        out.push(<div key={key} className={`md-h md-h${h[1].length}`}>{renderInline(h[2], key)}</div>);
      } else if (line.trim()) {
        flush();
        out.push(<p key={key} className="md-p">{renderInline(line, key)}</p>);
      } else {
        flush();
      }
    });
    flush();
  });
  return <>{out}</>;
}

export default function AgentPanel({
  onGridChange,
  activeTable,
}: {
  onGridChange: () => void;
  activeTable: { name: string; columns: string[] } | null;
}) {
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [status, setStatus] = useState<{ claude?: AgentStatus; codex?: AgentStatus }>({});
  const [threads, setThreads] = useState<Record<AgentKind, Message[]>>({ claude: [], codex: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const sessionRef = useRef<Record<AgentKind, string | undefined>>({ claude: undefined, codex: undefined });
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = threads[agent];

  useEffect(() => {
    api.agents().then(setStatus).catch(() => setStatus({}));
  }, []);

  // Re-detect (after install) or connect a manually-specified CLI path.
  async function connect(path?: string) {
    setConnecting(true);
    try {
      setStatus(await api.connectAgent(agent, path));
      setPathInput("");
    } catch {
      /* ignore */
    } finally {
      setConnecting(false);
    }
  }
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [threads, agent]);

  const current = status[agent];
  const ready = current?.installed;

  const setMessages = (fn: (m: Message[]) => Message[]) =>
    setThreads((t) => ({ ...t, [agent]: fn(t[agent]) }));

  function stop() {
    abortRef.current?.abort();
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text, tools: [] }, { role: "assistant", text: "", tools: [] }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const updateLast = (fn: (m: Message) => Message) =>
      setMessages((msgs) => msgs.map((m, i) => (i === msgs.length - 1 ? fn(m) : m)));

    try {
      const res = await fetch(`${API_BASE}/api/agent/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent,
          message: text,
          sessionId: sessionRef.current[agent],
          context: activeTable ? { tableName: activeTable.name, columns: activeTable.columns } : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i).replace(/^data: /, "");
          buf = buf.slice(i + 2);
          if (!raw) continue;
          let e: any;
          try {
            e = JSON.parse(raw);
          } catch {
            continue;
          }
          if (e.type === "text") updateLast((m) => ({ ...m, text: m.text + e.text }));
          else if (e.type === "tool")
            updateLast((m) => ({ ...m, tools: [...m.tools, { name: e.name, input: e.input ?? {} }] }));
          else if (e.type === "tool_result")
            updateLast((m) => {
              const tools = [...m.tools];
              for (let j = tools.length - 1; j >= 0; j--)
                if (tools[j].result === undefined) {
                  tools[j] = { ...tools[j], result: e.result };
                  break;
                }
              return { ...m, tools };
            });
          else if (e.type === "grid") onGridChange();
          else if (e.type === "session") sessionRef.current[agent] = e.sessionId;
          else if (e.type === "done") {
            if (e.sessionId) sessionRef.current[agent] = e.sessionId;
            if (e.isError) updateLast((m) => ({ ...m, error: true }));
          } else if (e.type === "error") updateLast((m) => ({ ...m, text: m.text || e.message, error: true }));
        }
      }
    } catch (err) {
      if ((err as any)?.name === "AbortError") updateLast((m) => ({ ...m, text: m.text || "⏹ stopped" }));
      else updateLast((m) => ({ ...m, text: m.text || (err instanceof Error ? err.message : "stream failed"), error: true }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      onGridChange();
    }
  }

  return (
    <aside className="agent-panel">
      <div className="agent-tabs">
        {(["claude", "codex"] as AgentKind[]).map((k) => (
          <button key={k} className={`agent-tab ${agent === k ? "active" : ""}`} onClick={() => setAgent(k)}>
            <span
              className={`agent-logo-wrap ${status[k]?.installed ? "on" : "off"}`}
              title={status[k]?.installed ? `${AGENT_LABEL[k]} connected` : `${AGENT_LABEL[k]} not detected`}
            >
              {AGENT_LOGO[k]}
            </span>
            {AGENT_LABEL[k]}
          </button>
        ))}
        {messages.length > 0 && (
          <button className="agent-clear" title="New conversation" onClick={() => { sessionRef.current[agent] = undefined; setMessages(() => []); }}>
            Clear
          </button>
        )}
      </div>

      {!ready ? (
        <div className="agent-empty">
          <div className="agent-empty-title">Connect {AGENT_LABEL[agent]}</div>
          <p>
            Sign in to your {agent === "claude" ? "Max" : "Codex"} plan in the {AGENT_LABEL[agent]} CLI — gtmgrid drives
            the CLI you've already authed. No keys stored.
          </p>
          <button className="agent-connect-btn" onClick={() => connect()} disabled={connecting}>
            {connecting ? "Detecting…" : `Detect ${AGENT_LABEL[agent]}`}
          </button>

          <div className="agent-connect-divider">not found automatically?</div>
          <div className="agent-connect-manual">
            <input
              value={pathInput}
              placeholder={`Path to ${agent} binary`}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pathInput.trim() && connect(pathInput.trim())}
              spellCheck={false}
            />
            <button onClick={() => connect(pathInput.trim())} disabled={connecting || !pathInput.trim()}>
              Connect
            </button>
          </div>
          <p className="agent-connect-hint">
            Find it with <code>which {agent}</code> in your terminal. Or install:{" "}
            <code>{agent === "claude" ? "npm i -g @anthropic-ai/claude-code" : "npm i -g @openai/codex"}</code>
          </p>
        </div>
      ) : (
        <>
          <div className="agent-stream" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="agent-hint">
                <strong>{AGENT_LABEL[agent]}</strong> can build &amp; run your grid. Try:
                <ul>
                  <li>"Create a table of 5 AI founders and enrich each with their Trigify profile"</li>
                  <li>"Add a column that drafts a one-line opener from their bio"</li>
                </ul>
                <span className="agent-plan">Using your {agent === "claude" ? "Max" : "Codex"} plan · {current?.version}</span>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`agent-msg ${m.role} ${m.error ? "error" : ""}`}>
                {m.role === "assistant" && <div className="agent-role">{AGENT_LABEL[agent]}</div>}
                {m.tools.map((t, j) => (
                  <div key={j} className="agent-tool-wrap">
                    <div className="agent-tool" title={JSON.stringify(t.input, null, 2)}>
                      <span className="agent-tool-dot" /> {t.name}
                      <span className="agent-tool-args">({Object.keys(t.input).join(", ")})</span>
                    </div>
                    {t.result && <pre className="agent-tool-result">{t.result.length > 240 ? t.result.slice(0, 240) + "…" : t.result}</pre>}
                  </div>
                ))}
                {m.text && (m.role === "assistant" ? <div className="agent-text"><Markdown text={m.text} /></div> : <div className="agent-text">{m.text}</div>)}
                {m.role === "assistant" && !m.text && !m.tools.length && busy && i === messages.length - 1 && (
                  <div className="agent-typing"><span /><span /><span /></div>
                )}
              </div>
            ))}
          </div>

          {activeTable && (
            <div className="agent-context-chip" title="The agent operates on this table by default">
              <span className="agent-context-dot" /> on <strong>{activeTable.name}</strong>
            </div>
          )}
          <div className="agent-input">
            <textarea
              value={input}
              placeholder={
                activeTable
                  ? `Ask ${AGENT_LABEL[agent]} about "${activeTable.name}"…`
                  : `Ask ${AGENT_LABEL[agent]} to build or run your grid…`
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              disabled={busy}
            />
            {busy ? (
              <button className="agent-send agent-stop" onClick={stop}>Stop</button>
            ) : (
              <button className="agent-send" onClick={send} disabled={!input.trim()}>Send</button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
