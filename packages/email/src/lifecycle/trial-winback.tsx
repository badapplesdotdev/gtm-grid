/**
 * Lifecycle email #16 — "Trial win-back".
 *
 * Trigger: +7 and +30 days after trial expiry.
 * Subject: `Your grids are still here`.
 */

import type { ReactNode } from "react";
import { Link } from "@react-email/components";
import {
  EmailShell,
  Headline,
  Para,
  SecondaryLink,
  Eyebrow,
  type ShellLinks,
} from "./_components.js";
import { ACCENT, BORDER, HAIRLINE, INK, INK_2, INK_3, MONO, SANS, SURFACE, webOrigin } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface TrialWinbackProps {
  readonly to: string;
  /** Tables still saved in the workspace. */
  readonly tableCount: number;
  /** Enriched rows still saved (highlighted green in the mock). */
  readonly rowsEnriched: number;
  /** Function columns still saved. */
  readonly columnCount: number;
  /** Deep link to reactivate the paid plan. */
  readonly reactivateUrl: string;
  /** Secondary "keep using local, free" link; defaults to the download page. */
  readonly keepLocalUrl?: string;
  readonly links?: ShellLinks;
}

export function trialWinbackSubject(): string {
  return "Your grids are still here";
}

const nf = new Intl.NumberFormat("en-US");

function TrialWinback(props: TrialWinbackProps): ReactNode {
  const keepLocal = props.keepLocalUrl ?? `${webOrigin()}/download`;
  const cells: readonly { value: number; label: string; accent?: boolean }[] = [
    { value: props.tableCount, label: "tables" },
    { value: props.rowsEnriched, label: "enriched rows", accent: true },
    { value: props.columnCount, label: "function columns" },
  ];
  return (
    <EmailShell
      preview={`Your ${props.tableCount} tables and ${nf.format(props.rowsEnriched)} enriched rows are saved.`}
      links={props.links}
    >
      <Eyebrow color={INK_3}>Your trial ended</Eyebrow>
      <Headline>
        Your {props.tableCount} tables and {nf.format(props.rowsEnriched)} enriched rows are saved.
      </Headline>
      <Para>
        Your trial wrapped up 7 days ago — but nothing&rsquo;s gone. Everything you built is exactly
        where you left it, ready the moment you come back.
      </Para>

      {/* "Still in your workspace" stat block */}
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        style={{
          marginTop: "24px",
          border: `1px solid ${BORDER}`,
          borderRadius: "8px",
          borderCollapse: "separate",
          overflow: "hidden",
        }}
      >
        <tbody>
          <tr>
            <td
              colSpan={3}
              style={{
                padding: "11px 16px",
                backgroundColor: SURFACE,
                borderBottom: `1px solid ${BORDER}`,
                fontFamily: SANS,
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: INK_2,
              }}
            >
              Still in your workspace
            </td>
          </tr>
          <tr>
            {cells.map((c, i) => (
              <td
                key={i}
                width="33%"
                style={{
                  padding: "16px",
                  borderRight: i === cells.length - 1 ? "none" : `1px solid ${HAIRLINE}`,
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: "22px", color: c.accent ? ACCENT : INK }}>
                  {nf.format(c.value)}
                </span>
                <br />
                <span style={{ fontFamily: SANS, fontSize: "11.5px", color: INK_3 }}>{c.label}</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {/* primary + secondary CTA row (button inlined so it aligns with the
          secondary link; the shared Cta carries its own top margin) */}
      <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={{ marginTop: "26px" }}>
        <tbody>
          <tr>
            <td
              style={{
                backgroundColor: ACCENT,
                borderRadius: "6px",
                boxShadow: "0 1px 3px rgba(34,197,94,.35)",
                verticalAlign: "middle",
              }}
            >
              <Link
                href={props.reactivateUrl}
                style={{
                  display: "inline-block",
                  padding: "12px 24px",
                  fontFamily: SANS,
                  fontSize: "14.5px",
                  fontWeight: 600,
                  color: "#ffffff",
                  borderRadius: "6px",
                }}
              >
                Reactivate your plan
              </Link>
            </td>
            <td style={{ paddingLeft: "16px", verticalAlign: "middle" }}>
              <SecondaryLink href={keepLocal}>keep using local, free</SecondaryLink>
            </td>
          </tr>
        </tbody>
      </table>
    </EmailShell>
  );
}

export function trialWinbackEmail(props: TrialWinbackProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: trialWinbackSubject(),
    element: <TrialWinback {...props} />,
  });
}
