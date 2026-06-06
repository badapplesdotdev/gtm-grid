/**
 * Onboarding preview pane (C28) — the right-hand "live mini-grid" canvas.
 *
 * Ported from the design's grid-preview.jsx: a dark canvas with a mini
 * spreadsheet whose function cells cycle pending → running → done on a stagger,
 * materialising the workspace as the user configures it — the workspace name hits
 * the titlebar, invited teammates appear as avatar chips, and the chosen AI
 * provider lights up. Pure presentation (plain React + CSS animations); driven by
 * the flow state the parent passes in.
 */

import { useEffect, useState } from "react";
import type { OnboardingScreen } from "./flow-logic.js";

const SEED_ROWS = [
  "Ramp",
  "Clay",
  "Vanta",
  "Mercury",
  "Linear",
  "Brex",
] as const;

const PEOPLE = [
  "Eric Glyman",
  "Kareem Amin",
  "Christina Cacioppo",
  "Immad Akhund",
  "Karri Saarinen",
  "Henrique Dubugras",
] as const;

const OPENERS = [
  "Saw Ramp shipped agentic spend controls.",
  "Clay's templating maps to ours.",
  "Vanta's compliance-as-code is right.",
  "Mercury's API-first banking is a wedge.",
  "Linear's pace per engineer is unreal.",
  "Brex scaling spend infra mirrors us.",
] as const;

type CellState = "pending" | "running" | "done";

/** A single cell cycling pending → running → done on a repeating stagger. */
function FnCell({ delay, value }: { delay: number; value: string }) {
  const [state, setState] = useState<CellState>("pending");
  useEffect(() => {
    let t1: ReturnType<typeof setTimeout>;
    let t2: ReturnType<typeof setTimeout>;
    const run = () => {
      setState("pending");
      t1 = setTimeout(() => setState("running"), delay);
      t2 = setTimeout(() => setState("done"), delay + 900);
    };
    run();
    const loop = setInterval(run, 7000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearInterval(loop);
    };
  }, [delay]);

  if (state === "done") {
    return (
      <span className="ob-cell-state done">
        <span className="ob-sdot" />
        <span className="ob-sval">{value}</span>
      </span>
    );
  }
  if (state === "running") {
    return (
      <span className="ob-cell-state running">
        <span className="ob-sdot" />
        <span className="ob-sval">running…</span>
      </span>
    );
  }
  return (
    <span className="ob-cell-state pending">
      <span className="ob-sdot" />
      <span className="ob-sval">pending</span>
    </span>
  );
}

/** The mini spreadsheet card — "every column is a function". */
function MiniGrid({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="ob-mini-grid">
      <div className="ob-mini-titlebar">
        <span className="ob-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="ob-mt-name">
          {workspaceName || "Untitled workspace"} / Q3 outbound
        </span>
        <span className="ob-mt-rows">{SEED_ROWS.length} rows</span>
      </div>
      <table className="ob-mini-table">
        <thead>
          <tr>
            <th className="ob-rownum" style={{ width: 26 }} />
            <th style={{ width: "22%" }}>
              <div className="ob-th-row">
                <span className="ob-ttype">T</span>Company
              </div>
            </th>
            <th style={{ width: "26%" }}>
              <div className="ob-th-row">
                <span className="ob-fnbadge">trigify.enrich</span>
              </div>
            </th>
            <th style={{ width: "16%" }}>
              <div className="ob-th-row">
                <span className="ob-fnbadge">findEmail</span>
              </div>
            </th>
            <th style={{ width: "auto" }}>
              <div className="ob-th-row">
                <span className="ob-fnbadge">ai.generate</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {SEED_ROWS.map((co, i) => (
            <tr key={co}>
              <td className="ob-rownum">{i + 1}</td>
              <td>{co}</td>
              <td className="ob-mono">
                <FnCell delay={250 + i * 220} value={PEOPLE[i]} />
              </td>
              <td className="ob-mono">
                <FnCell delay={600 + i * 220} value="✓ valid" />
              </td>
              <td>
                <FnCell delay={950 + i * 220} value={OPENERS[i]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The value line beneath the grid. */
function PreviewQuote() {
  return (
    <div className="ob-pp-quote">
      <div className="ob-q-text">
        Every column is a <span className="ob-hl">function</span>. Template your
        inputs, hit run, and watch rows fill — enrichment, scoring and copy, all
        computed locally.
      </div>
      <div className="ob-q-meta">
        local-first · byo ai key · execution stays on your machine
      </div>
    </div>
  );
}

/** Teammate chips (invite step) — owner + each non-blank invite as an avatar. */
function TeamChips({
  invites,
  ownerName,
}: {
  invites: readonly { value: string; role: string }[];
  ownerName: string;
}) {
  const palette = ["", "green", "blue"];
  const valid = invites.filter((i) => i.value.trim().length > 0);
  return (
    <div className="ob-pp-chips">
      <span className="ob-pp-chip">
        <span className="ob-av">{(ownerName || "Y")[0]?.toUpperCase()}</span>
        you <span className="ob-role">owner</span>
      </span>
      {valid.map((inv, i) => {
        const name = inv.value.split("@")[0] || inv.value;
        return (
          <span className="ob-pp-chip" key={`${inv.value}-${i}`}>
            <span className={`ob-av ${palette[(i + 1) % palette.length]}`}>
              {(name[0] || "?").toUpperCase()}
            </span>
            {name} <span className="ob-role">{inv.role}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Provider chip (connect step) — lights up the chosen provider + key state. */
function ProviderChips({
  provider,
  keyEntered,
}: {
  provider: "anthropic" | "openai";
  keyEntered: boolean;
}) {
  const name = provider === "openai" ? "OpenAI" : "Anthropic";
  return (
    <div className="ob-pp-chips">
      <span className="ob-pp-chip">
        <span className="ob-av">{name[0]}</span>
        {name} <span className="ob-role">{keyEntered ? "key set" : "no key"}</span>
      </span>
    </div>
  );
}

/**
 * The right preview pane. Always shows the live mini-grid; layers teammate chips
 * on the invite step and the provider chip on the connect step.
 */
export function PreviewPane(props: {
  screen: OnboardingScreen;
  workspaceName: string;
  ownerName: string;
  invites: readonly { value: string; role: string }[];
  provider: "anthropic" | "openai";
  keyEntered: boolean;
}) {
  const { screen, workspaceName, ownerName, invites, provider, keyEntered } =
    props;
  return (
    <div className="ob-preview-pane">
      <div className="ob-glow" />
      <div className="ob-pp-stack">
        <MiniGrid workspaceName={workspaceName} />
        {screen === "invite" && (
          <TeamChips invites={invites} ownerName={ownerName} />
        )}
        {screen === "connect" && (
          <ProviderChips provider={provider} keyEntered={keyEntered} />
        )}
      </div>
      <PreviewQuote />
    </div>
  );
}
