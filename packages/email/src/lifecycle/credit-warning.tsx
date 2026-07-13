/**
 * Lifecycle email #18 — "You've used 80% of your cloud actions".
 *
 * Trigger: cloud-action usage crosses 80% of the monthly cap (mirrors the
 * in-app `cloudActionsLow` bell to email).
 * Subject: `You've used {percent}% of your cloud actions`.
 *
 * The usage bar is a two-cell table (filled amber cell + muted remainder) so it
 * survives clients that drop `<div>` widths.
 */

import type { ReactNode } from "react";
import {
  EmailShell,
  Eyebrow,
  Headline,
  Para,
  SecondaryLink,
  type ShellLinks,
} from "./_components.js";
import { ACCENT, INK, INK_3, MONO, SANS, SURFACE_2, WARNING } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface CreditWarningProps {
  readonly to: string;
  /** Cloud actions consumed this period (e.g. 8000). */
  readonly used: number;
  /** Monthly cap (e.g. 10000). */
  readonly limit: number;
  /** Percent of cap used (e.g. 80). Drives the bar fill + subject. */
  readonly percent: number;
  /** Renewal label, e.g. "Apr 1". */
  readonly resetsAt: string;
  /** Billing/plan page (primary CTA). */
  readonly manageUrl: string;
  /** Optional one-off top-up link (secondary). */
  readonly topUpUrl?: string;
  readonly links?: ShellLinks;
}

// Amber bar fill (mock uses amber-500; the shared WARNING ink is darker for text).
const BAR_FILL = "#f59e0b";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function UsageBar(props: { percent: number }): ReactNode {
  const pct = Math.max(0, Math.min(100, props.percent));
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{
        borderRadius: "20px",
        borderCollapse: "separate",
        overflow: "hidden",
        backgroundColor: SURFACE_2,
      }}
    >
      <tbody>
        <tr>
          <td
            width={`${pct}%`}
            style={{
              height: "10px",
              lineHeight: "10px",
              fontSize: 0,
              backgroundColor: BAR_FILL,
            }}
          >
            &nbsp;
          </td>
          <td style={{ height: "10px", lineHeight: "10px", fontSize: 0 }}>&nbsp;</td>
        </tr>
      </tbody>
    </table>
  );
}

export function creditWarningSubject(p: Pick<CreditWarningProps, "percent">): string {
  return `You've used ${p.percent}% of your cloud actions`;
}

function CreditWarning(props: CreditWarningProps): ReactNode {
  const remaining = Math.max(0, props.limit - props.used);
  return (
    <EmailShell
      preview={`${fmt(remaining)} cloud actions left before your cap resets ${props.resetsAt}.`}
      links={props.links}
    >
      <Eyebrow color={WARNING}>Usage</Eyebrow>
      <Headline>You&rsquo;ve used {props.percent}% of this month&rsquo;s cloud actions.</Headline>
      <Para>
        At your current pace you&rsquo;ll hit the cap before it resets. Top up or upgrade to
        keep runs flowing &mdash; nothing pauses until you&rsquo;re out.
      </Para>

      <div style={{ marginTop: "24px" }}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
          <tbody>
            <tr>
              <td style={{ verticalAlign: "baseline" }}>
                <span style={{ fontFamily: MONO, fontSize: "14px", color: INK }}>
                  {fmt(props.used)} <span style={{ color: INK_3 }}>/ {fmt(props.limit)}</span>
                </span>
              </td>
              <td align="right" style={{ verticalAlign: "baseline" }}>
                <span style={{ fontFamily: SANS, fontSize: "12.5px", fontWeight: 600, color: WARNING }}>
                  {props.percent}% used
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: "8px" }}>
          <UsageBar percent={props.percent} />
        </div>
        <div
          style={{
            marginTop: "8px",
            fontFamily: SANS,
            fontSize: "12px",
            color: INK_3,
          }}
        >
          {fmt(remaining)} actions left · resets {props.resetsAt}
        </div>
      </div>

      <table
        role="presentation"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        style={{ marginTop: "26px" }}
      >
        <tbody>
          <tr>
            <td style={{ verticalAlign: "middle" }}>
              <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
                <tbody>
                  <tr>
                    <td
                      style={{
                        backgroundColor: ACCENT,
                        borderRadius: "6px",
                        boxShadow: "0 1px 3px rgba(34,197,94,.35)",
                      }}
                    >
                      <a
                        href={props.manageUrl}
                        style={{
                          display: "inline-block",
                          padding: "12px 24px",
                          fontFamily: SANS,
                          fontSize: "14.5px",
                          fontWeight: 600,
                          color: "#ffffff",
                          textDecoration: "none",
                          borderRadius: "6px",
                        }}
                      >
                        Manage plan
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
            {props.topUpUrl ? (
              <td style={{ verticalAlign: "middle", paddingLeft: "16px" }}>
                <SecondaryLink href={props.topUpUrl}>buy a top-up</SecondaryLink>
              </td>
            ) : null}
          </tr>
        </tbody>
      </table>
    </EmailShell>
  );
}

export function creditWarningEmail(props: CreditWarningProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: creditWarningSubject(props),
    element: <CreditWarning {...props} />,
  });
}
