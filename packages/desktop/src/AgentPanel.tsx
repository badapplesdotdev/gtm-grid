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

export default function AgentPanel({ onGridChange }: { onGridChange: () => void }) {
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [status, setStatus] = useState<{ claude?: AgentStatus; codex?: AgentStatus }>({});
  const [threads, setThreads] = useState<Record<AgentKind, Message[]>>({ claude: [], codex: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<Record<AgentKind, string | undefined>>({ claude: undefined, codex: undefined });
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = threads[agent];

  useEffect(() => {
    api.agents().then(setStatus).catch(() => setStatus({}));
  }, []);
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
        body: JSON.stringify({ agent, message: text, sessionId: sessionRef.current[agent] }),
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
            <span className={`agent-dot ${status[k]?.installed ? "on" : "off"}`} />
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
            {AGENT_LABEL[agent]} isn't detected on your PATH. Install it and sign in to your{" "}
            {agent === "claude" ? "Max" : "Codex"} plan — gtmgrid drives the CLI you've already authed. No keys stored.
          </p>
          <code>{agent === "claude" ? "npm i -g @anthropic-ai/claude-code" : "npm i -g @openai/codex"}</code>
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

          <div className="agent-input">
            <textarea
              value={input}
              placeholder={`Ask ${AGENT_LABEL[agent]} to build or run your grid…`}
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
