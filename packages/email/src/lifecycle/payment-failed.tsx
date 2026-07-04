/**
 * Lifecycle email #17 — "Your payment didn't go through" (dunning).
 *
 * Trigger: `subscription_payment_failed` — a Stripe charge is declined. The same
 * template is re-sent across the Day 0 → 3 → 7 escalation window; `attempt`
 * selects which node of the timeline is highlighted (0 = first notice,
 * 3 = auto-retry, 7 = sync pauses).
 * Subject: `Your payment didn't go through`.
 *
 * Transactional: EmailShell links may omit `unsubscribeUrl`.
 */

import type { CSSProperties, ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Eyebrow,
  Headline,
  MonoInline,
  Para,
  type ShellLinks,
} from "./_components.js";
import { BORDER, DANGER, INK, INK_2, INK_3, MONO, SANS } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

/** Escalation stage — the dunning day this send represents. */
export type DunningAttempt = 0 | 3 | 7;

export interface PaymentFailedProps {
  readonly to: string;
  /** Workspace whose cloud sync is at risk (e.g. "Northbeam GTM"). */
  readonly workspace: string;
  /** Last four digits of the declined card. */
  readonly cardLast4: string;
  /** Dunning stage: 0 (today), 3 (auto-retry), 7 (sync pauses). */
  readonly attempt: DunningAttempt;
  /** Billing page to re-enter card details. */
  readonly updatePaymentUrl: string;
  readonly links?: ShellLinks;
}

// Danger accents used only by this template's timeline (the shared tokens keep a
// single DANGER ink; the mock's active node adds a lighter ring + tint).
const DANGER_RING = "#ef4444";
const DANGER_TINT = "#fef2f2";

interface TimelineNode {
  readonly day: DunningAttempt;
  readonly label: string;
  readonly sub: string;
}

const TIMELINE: readonly TimelineNode[] = [
  { day: 0, label: "Today", sub: "first notice" },
  { day: 3, label: "Day 3", sub: "auto-retry" },
  { day: 7, label: "Day 7", sub: "sync pauses" },
];

function EscalationTimeline(props: { attempt: DunningAttempt }): ReactNode {
  const connector: CSSProperties = {
    verticalAlign: "top",
    paddingTop: "12px",
    width: "40px",
  };
  return (
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
      }}
    >
      <tbody>
        <tr>
          <td style={{ padding: "18px 16px" }}>
            <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
              <tbody>
                <tr>
                  {TIMELINE.flatMap((node, i) => {
                    const active = node.day === props.attempt;
                    const nodeCell = (
                      <td key={`n${i}`} align="center" style={{ verticalAlign: "top" }}>
                        <span
                          style={{
                            display: "inline-block",
                            width: "26px",
                            height: "26px",
                            lineHeight: "26px",
                            textAlign: "center",
                            borderRadius: "50%",
                            backgroundColor: active ? DANGER_TINT : "#ffffff",
                            border: `2px solid ${active ? DANGER_RING : BORDER}`,
                            color: active ? DANGER : INK_3,
                            fontFamily: MONO,
                            fontSize: "11px",
                            fontWeight: 700,
                          }}
                        >
                          {node.day}
                        </span>
                        <br />
                        <span
                          style={{
                            display: "inline-block",
                            marginTop: "8px",
                            fontFamily: SANS,
                            fontSize: "12px",
                            fontWeight: 600,
                            color: active ? INK : INK_2,
                          }}
                        >
                          {node.label}
                        </span>
                        <br />
                        <span
                          style={{
                            display: "inline-block",
                            marginTop: "2px",
                            fontFamily: SANS,
                            fontSize: "11px",
                            color: INK_3,
                          }}
                        >
                          {node.sub}
                        </span>
                      </td>
                    );
                    if (i === 0) return [nodeCell];
                    return [
                      <td key={`c${i}`} style={connector}>
                        <div
                          style={{
                            height: "2px",
                            lineHeight: "2px",
                            fontSize: 0,
                            backgroundColor: BORDER,
                          }}
                        >
                          &nbsp;
                        </div>
                      </td>,
                      nodeCell,
                    ];
                  })}
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function paymentFailedSubject(): string {
  return "Your payment didn't go through";
}

function PaymentFailed(props: PaymentFailedProps): ReactNode {
  return (
    <EmailShell
      preview={`Update the card ending •••• ${props.cardLast4} to keep ${props.workspace}'s cloud sync running.`}
      links={props.links}
    >
      <Eyebrow color={DANGER}>Action needed</Eyebrow>
      <Headline>We couldn&rsquo;t process your payment.</Headline>
      <Para>
        The card ending <MonoInline>•••• {props.cardLast4}</MonoInline> for{" "}
        <MonoInline>{props.workspace}</MonoInline> was declined. Update it to keep your
        team&rsquo;s cloud sync running &mdash; your local grids keep working regardless.
      </Para>
      <EscalationTimeline attempt={props.attempt} />
      <Cta href={props.updatePaymentUrl}>Update payment method</Cta>
    </EmailShell>
  );
}

export function paymentFailedEmail(props: PaymentFailedProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: paymentFailedSubject(),
    element: <PaymentFailed {...props} />,
  });
}
