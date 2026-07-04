/**
 * Lifecycle email #20 — "You're on gtm grid {plan}" (subscription receipt).
 *
 * Trigger: `subscription_started`.
 * Subject: `You're on gtm grid {plan}`.
 *
 * Transactional receipt: EmailShell links may omit `unsubscribeUrl`.
 */

import type { CSSProperties, ReactNode } from "react";
import {
  EmailShell,
  Eyebrow,
  Headline,
  MonoInline,
  Para,
  SecondaryLink,
  type ShellLinks,
} from "./_components.js";
import { ACCENT, HAIRLINE, INK, INK_2, INK_3, MONO, SANS, SURFACE } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface SubscriptionConfirmedProps {
  readonly to: string;
  /** Plan name shown after the wordmark (e.g. "Team"). */
  readonly plan: string;
  /** Workspace the plan applies to (e.g. "Northbeam GTM"). */
  readonly workspace: string;
  /** Seat count on the plan. */
  readonly seats: number;
  /** Formatted charge, e.g. "$60.00". Used for the line total + "charged today". */
  readonly amount: string;
  /** Billing cadence label under the plan row. Defaults to "billed monthly". */
  readonly period?: string;
  /** Card on file, e.g. "Visa •••• 4242". Hides the Payment row when absent. */
  readonly paymentMethod?: string;
  /** Next renewal date, e.g. "Apr 3, 2026". Hides the row when absent. */
  readonly nextCharge?: string;
  /** Invoice reference, e.g. "INV-2041". Shown mono beside the eyebrow. */
  readonly invoiceId?: string;
  /** Billing page (primary CTA). */
  readonly billingUrl: string;
  /** Hosted invoice / PDF link (secondary). */
  readonly receiptUrl?: string;
  readonly links?: ShellLinks;
}

const rowCell: CSSProperties = {
  padding: "12px 16px",
  verticalAlign: "middle",
  borderBottom: `1px solid ${HAIRLINE}`,
};

export function subscriptionConfirmedSubject(
  p: Pick<SubscriptionConfirmedProps, "plan">,
): string {
  return `You're on gtm grid ${p.plan}`;
}

function SubscriptionConfirmed(props: SubscriptionConfirmedProps): ReactNode {
  const period = props.period ?? "billed monthly";
  return (
    <EmailShell
      preview={`Your gtm grid ${props.plan} subscription for ${props.workspace} is confirmed.`}
      links={props.links}
    >
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
        <tbody>
          <tr>
            <td style={{ verticalAlign: "middle" }}>
              <Eyebrow>Receipt</Eyebrow>
            </td>
            {props.invoiceId ? (
              <td align="right" style={{ verticalAlign: "middle" }}>
                <span style={{ fontFamily: MONO, fontSize: "11px", color: INK_3 }}>
                  #{props.invoiceId}
                </span>
              </td>
            ) : null}
          </tr>
        </tbody>
      </table>
      <Headline>Subscription confirmed.</Headline>
      <Para>
        You&rsquo;re on <b style={{ fontWeight: 600, color: INK }}>gtm grid {props.plan}</b>. Cloud
        sync and multiplayer are live for <MonoInline>{props.workspace}</MonoInline> &mdash;
        execution still runs local on every machine.
      </Para>

      {/* receipt card */}
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        border={0}
        style={{
          marginTop: "24px",
          border: `1px solid ${HAIRLINE}`,
          borderRadius: "8px",
          borderCollapse: "separate",
          overflow: "hidden",
        }}
      >
        <tbody>
          <tr>
            <td style={{ ...rowCell, padding: "14px 16px" }}>
              <span style={{ fontFamily: SANS, fontSize: "13.5px", fontWeight: 600, color: INK }}>
                {props.plan} plan
              </span>
              <br />
              <span style={{ fontFamily: SANS, fontSize: "12px", color: INK_3 }}>
                {props.seats} seats · {period}
              </span>
            </td>
            <td align="right" style={{ ...rowCell, padding: "14px 16px" }}>
              <span style={{ fontFamily: MONO, fontSize: "14px", color: INK }}>{props.amount}</span>
            </td>
          </tr>
          {props.paymentMethod ? (
            <tr>
              <td style={rowCell}>
                <span style={{ fontFamily: SANS, fontSize: "12.5px", color: INK_2 }}>Payment</span>
              </td>
              <td align="right" style={rowCell}>
                <span style={{ fontFamily: MONO, fontSize: "12.5px", color: INK }}>
                  {props.paymentMethod}
                </span>
              </td>
            </tr>
          ) : null}
          {props.nextCharge ? (
            <tr>
              <td style={rowCell}>
                <span style={{ fontFamily: SANS, fontSize: "12.5px", color: INK_2 }}>
                  Next charge
                </span>
              </td>
              <td align="right" style={rowCell}>
                <span style={{ fontFamily: MONO, fontSize: "12.5px", color: INK }}>
                  {props.nextCharge}
                </span>
              </td>
            </tr>
          ) : null}
          <tr>
            <td style={{ padding: "14px 16px", verticalAlign: "middle", backgroundColor: SURFACE }}>
              <span style={{ fontFamily: SANS, fontSize: "13px", fontWeight: 600, color: INK }}>
                Charged today
              </span>
            </td>
            <td
              align="right"
              style={{ padding: "14px 16px", verticalAlign: "middle", backgroundColor: SURFACE }}
            >
              <span style={{ fontFamily: MONO, fontSize: "15px", fontWeight: 600, color: ACCENT }}>
                {props.amount}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

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
                        href={props.billingUrl}
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
                        View billing
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
            {props.receiptUrl ? (
              <td style={{ verticalAlign: "middle", paddingLeft: "16px" }}>
                <SecondaryLink href={props.receiptUrl}>download invoice (PDF)</SecondaryLink>
              </td>
            ) : null}
          </tr>
        </tbody>
      </table>
    </EmailShell>
  );
}

export function subscriptionConfirmedEmail(
  props: SubscriptionConfirmedProps,
): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: subscriptionConfirmedSubject(props),
    element: <SubscriptionConfirmed {...props} />,
  });
}
