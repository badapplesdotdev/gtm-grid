/**
 * Lifecycle email #19 — "{teammate} joined {workspace}".
 *
 * Trigger: an invite is accepted — sent to the inviter.
 * Subject: `{firstName} joined {workspace}`.
 *
 * Transactional: EmailShell links may omit `unsubscribeUrl`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Eyebrow,
  Headline,
  Para,
  type ShellLinks,
} from "./_components.js";
import {
  ACCENT,
  BORDER,
  GREEN_TINT,
  GREEN_TINT_BORDER,
  INK,
  INK_2,
  MONO,
  SANS,
  SUCCESS,
  SUCCESS_TINT,
  SUCCESS_TINT_BORDER,
} from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface TeammateJoinedProps {
  readonly to: string;
  /** Full name of the teammate who accepted (e.g. "Sam Rivera"). */
  readonly teammateName: string;
  /** Their email, shown mono under the name. */
  readonly teammateEmail?: string;
  /** Workspace they joined (e.g. "Northbeam GTM"). */
  readonly workspace: string;
  /** Referral reward granted for growing the team; hides the box when absent. */
  readonly rewardCredits?: number;
  /** Deep link into the workspace members view (primary CTA). */
  readonly openWorkspaceUrl: string;
  readonly links?: ShellLinks;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function teammateJoinedSubject(
  p: Pick<TeammateJoinedProps, "teammateName" | "workspace">,
): string {
  const first = p.teammateName.split(/\s+/)[0] ?? p.teammateName;
  return `${first} joined ${p.workspace}`;
}

function TeammateJoined(props: TeammateJoinedProps): ReactNode {
  const first = props.teammateName.split(/\s+/)[0] ?? props.teammateName;
  return (
    <EmailShell
      preview={`The invite you sent was accepted — ${first} is now in ${props.workspace}.`}
      links={props.links}
    >
      <Eyebrow>Team</Eyebrow>
      <Headline>
        {first} joined {props.workspace}.
      </Headline>
      <Para>
        The invite you sent was accepted. {first} can now see your tables, add columns, and
        run functions alongside you.
      </Para>

      {/* member card */}
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
            <td style={{ padding: "14px 16px", verticalAlign: "middle", width: "42px" }}>
              <span
                style={{
                  display: "inline-block",
                  width: "42px",
                  height: "42px",
                  lineHeight: "42px",
                  textAlign: "center",
                  borderRadius: "50%",
                  backgroundColor: ACCENT,
                  color: "#ffffff",
                  fontFamily: SANS,
                  fontSize: "15px",
                  fontWeight: 600,
                }}
              >
                {initials(props.teammateName)}
              </span>
            </td>
            <td style={{ padding: "14px 12px", verticalAlign: "middle" }}>
              <span style={{ fontFamily: SANS, fontSize: "14.5px", fontWeight: 600, color: INK }}>
                {props.teammateName}
              </span>
              {props.teammateEmail ? (
                <>
                  <br />
                  <span style={{ fontFamily: MONO, fontSize: "12px", color: INK_2 }}>
                    {props.teammateEmail}
                  </span>
                </>
              ) : null}
            </td>
            <td align="right" style={{ padding: "14px 16px", verticalAlign: "middle" }}>
              <span
                style={{
                  fontFamily: SANS,
                  fontSize: "10.5px",
                  fontWeight: 600,
                  color: SUCCESS,
                  backgroundColor: SUCCESS_TINT,
                  border: `1px solid ${SUCCESS_TINT_BORDER}`,
                  borderRadius: "20px",
                  padding: "3px 9px",
                  whiteSpace: "nowrap",
                }}
              >
                member
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {props.rewardCredits ? (
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
            <tr>
              <td style={{ padding: "12px 16px", verticalAlign: "middle", width: "20px" }}>
                <span style={{ fontFamily: SANS, fontSize: "15px", color: ACCENT }}>★</span>
              </td>
              <td style={{ padding: "12px 16px 12px 0", verticalAlign: "middle" }}>
                <span style={{ fontFamily: SANS, fontSize: "13px", color: ACCENT }}>
                  <b style={{ fontWeight: 600 }}>+{props.rewardCredits} cloud actions</b> added for
                  growing your team.
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      ) : null}

      <Cta href={props.openWorkspaceUrl}>See who&rsquo;s in</Cta>
    </EmailShell>
  );
}

export function teammateJoinedEmail(props: TeammateJoinedProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: teammateJoinedSubject(props),
    element: <TeammateJoined {...props} />,
  });
}
