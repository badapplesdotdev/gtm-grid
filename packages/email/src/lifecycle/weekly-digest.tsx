/**
 * Lifecycle email #14 — "Weekly workspace digest".
 *
 * Trigger: cron, Monday 9am (clones the `send-trial-reminders` Inngest pattern).
 * Subject: `your week in gtm grid`.
 */

import type { CSSProperties, ReactNode } from "react";
import { Cta, EmailShell, Headline, type ShellLinks } from "./_components.js";
import {
  ACCENT,
  BORDER,
  GREEN_TINT,
  GREEN_TINT_BORDER,
  INK,
  INK_2,
  INK_3,
  MONO,
  SANS,
  SUCCESS,
} from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface WeeklyDigestStats {
  readonly rowsEnriched: number;
  readonly runsCompleted: number;
  readonly creditsUsed: number;
  readonly teammatesActive: number;
}

/** Optional week-over-week delta captions under each stat (already formatted). */
export interface WeeklyDigestDeltas {
  /** e.g. "▲ 18% vs last week". */
  readonly rowsEnriched?: string;
  /** e.g. "▲ 9 vs last week". */
  readonly runsCompleted?: string;
  /** e.g. "— 12,400 left". */
  readonly creditsUsed?: string;
  /** e.g. "▲ 1 new this week". */
  readonly teammatesActive?: string;
}

export interface WeeklyDigestTopTable {
  readonly name: string;
  readonly rowsAdded: number;
}

export interface WeeklyDigestProps {
  readonly to: string;
  /** Workspace display name, e.g. "Northbeam GTM". */
  readonly workspace: string;
  /** Header-right week range, e.g. "Mar 3 – Mar 9". */
  readonly weekRange: string;
  readonly stats: WeeklyDigestStats;
  readonly deltas?: WeeklyDigestDeltas;
  /** Most active table(s) this week; the mock shows one. */
  readonly topTables: readonly WeeklyDigestTopTable[];
  /** Deep link to the workspace. */
  readonly openUrl: string;
  readonly links?: ShellLinks;
}

export function weeklyDigestSubject(): string {
  return "your week in gtm grid";
}

const nf = new Intl.NumberFormat("en-US");

/** Delta caption is green when it opens with the ▲ up-marker, muted otherwise. */
function deltaColor(delta: string): string {
  return delta.trimStart().startsWith("▲") ? SUCCESS : INK_2;
}

const statBox: CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: "8px",
  padding: "16px",
};

function StatCard(props: {
  label: string;
  value: number;
  delta?: string;
}): ReactNode {
  return (
    <div style={statBox}>
      <span style={{ fontFamily: SANS, fontSize: "11.5px", color: INK_3 }}>{props.label}</span>
      <br />
      <span
        style={{
          display: "inline-block",
          margin: "6px 0",
          fontFamily: MONO,
          fontSize: "24px",
          color: INK,
        }}
      >
        {nf.format(props.value)}
      </span>
      {props.delta ? (
        <>
          <br />
          <span
            style={{
              fontFamily: SANS,
              fontSize: "11.5px",
              fontWeight: 600,
              color: deltaColor(props.delta),
            }}
          >
            {props.delta}
          </span>
        </>
      ) : null}
    </div>
  );
}

function WeeklyDigest(props: WeeklyDigestProps): ReactNode {
  const { stats, deltas } = props;
  return (
    <EmailShell
      preview={`Your week in gtm grid — ${nf.format(stats.rowsEnriched)} rows enriched.`}
      links={props.links}
    >
      {/* eyebrow + week range (design puts the range in the header; kept in-body
          here because the shared shell header is fixed) */}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
        <tbody>
          <tr>
            <td style={{ verticalAlign: "middle" }}>
              <span
                style={{
                  fontFamily: SANS,
                  fontSize: "10.5px",
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: ACCENT,
                }}
              >
                Weekly digest
              </span>
            </td>
            <td align="right" style={{ verticalAlign: "middle" }}>
              <span style={{ fontFamily: SANS, fontSize: "11.5px", color: INK_3 }}>
                {props.weekRange}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <Headline>{props.workspace} had a busy week.</Headline>

      {/* 2×2 stat grid (gaps simulated with cell padding for email safety) */}
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        style={{ marginTop: "22px", borderCollapse: "separate" }}
      >
        <tbody>
          <tr>
            <td width="50%" style={{ paddingRight: "6px", paddingBottom: "6px" }}>
              <StatCard label="Rows enriched" value={stats.rowsEnriched} delta={deltas?.rowsEnriched} />
            </td>
            <td width="50%" style={{ paddingLeft: "6px", paddingBottom: "6px" }}>
              <StatCard label="Runs completed" value={stats.runsCompleted} delta={deltas?.runsCompleted} />
            </td>
          </tr>
          <tr>
            <td width="50%" style={{ paddingRight: "6px", paddingTop: "6px" }}>
              <StatCard label="Credits used" value={stats.creditsUsed} delta={deltas?.creditsUsed} />
            </td>
            <td width="50%" style={{ paddingLeft: "6px", paddingTop: "6px" }}>
              <StatCard label="Active teammates" value={stats.teammatesActive} delta={deltas?.teammatesActive} />
            </td>
          </tr>
        </tbody>
      </table>

      {/* top table(s) highlight box */}
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        style={{
          marginTop: "14px",
          backgroundColor: GREEN_TINT,
          border: `1px solid ${GREEN_TINT_BORDER}`,
          borderRadius: "8px",
          borderCollapse: "separate",
        }}
      >
        <tbody>
          {props.topTables.map((t, i) => (
            <tr key={i}>
              <td style={{ padding: "14px 16px", verticalAlign: "middle" }}>
                {i === 0 ? (
                  <>
                    <span style={{ fontFamily: SANS, fontSize: "11.5px", color: ACCENT }}>
                      Top table this week
                    </span>
                    <br />
                  </>
                ) : null}
                <span
                  style={{
                    display: "inline-block",
                    marginTop: i === 0 ? "2px" : 0,
                    fontFamily: MONO,
                    fontSize: "14px",
                    color: INK,
                  }}
                >
                  {t.name}
                </span>
              </td>
              <td align="right" style={{ padding: "14px 16px", verticalAlign: "middle" }}>
                <span style={{ fontFamily: MONO, fontSize: "13px", color: ACCENT }}>
                  {nf.format(t.rowsAdded)} rows
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Cta href={props.openUrl}>Open workspace</Cta>
    </EmailShell>
  );
}

export function weeklyDigestEmail(props: WeeklyDigestProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: weeklyDigestSubject(),
    element: <WeeklyDigest {...props} />,
  });
}
