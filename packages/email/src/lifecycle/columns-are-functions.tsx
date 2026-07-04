/**
 * Lifecycle email #9 — "Columns are functions".
 *
 * Trigger: has a table, no function/AI column after 48h.
 * Subject: `A column can do more than store text`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Eyebrow,
  Headline,
  InfoBox,
  Para,
  type ShellLinks,
} from "./_components.js";
import {
  ACCENT,
  BORDER,
  GREEN_TINT,
  GREEN_TINT_BORDER,
  HAIRLINE,
  INK,
  INK_2,
  INK_3,
  MONO,
  SANS,
  SURFACE_2,
} from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface ColumnsAreFunctionsProps {
  readonly to: string;
  /** Greeting personalization — unused by the current mock copy; kept to
   * document the available merge var. */
  readonly firstName?: string;
  /** Table display name — declared as a merge var in the design; the final copy
   * does not interpolate it, so it is currently unused. */
  readonly table?: string;
  /** "Add your AI key" CTA target (opens AI providers settings). */
  readonly ctaUrl: string;
  readonly links?: ShellLinks;
}

export function columnsAreFunctionsSubject(): string {
  return "A column can do more than store text";
}

/** Local one-off before/after block: a plain "Title" column transformed into an
 * AI-backed "Opener" column. Two bordered panels in a single table row. */
function BeforeAfter(): ReactNode {
  const titleRows = ["VP Sales", "Head of Growth", "RevOps Lead"];
  const openers = [
    `"Saw Ramp shipped bill pay — how's it landing with finance?"`,
    `"Vercel's DX bar is unreal — curious how growth thinks about it."`,
    `"Notion RevOps at your scale is a craft — what's breaking first?"`,
  ];
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ marginTop: "24px" }}
    >
      <tbody>
        <tr>
          <td width="42%" style={{ verticalAlign: "top" }}>
            <table
              role="presentation"
              width="100%"
              cellPadding={0}
              cellSpacing={0}
              border={0}
              style={{
                border: `1px solid ${BORDER}`,
                borderRadius: "8px",
                borderCollapse: "separate",
                overflow: "hidden",
              }}
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      padding: "8px 10px",
                      backgroundColor: SURFACE_2,
                      borderBottom: `1px solid ${BORDER}`,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: "10px",
                        color: INK_3,
                        marginRight: "6px",
                      }}
                    >
                      T
                    </span>
                    <span style={{ fontFamily: SANS, fontSize: "12px", fontWeight: 500, color: INK }}>
                      Title
                    </span>
                  </td>
                </tr>
                {titleRows.map((t, i) => (
                  <tr key={i}>
                    <td
                      style={{
                        padding: "9px 10px",
                        fontFamily: MONO,
                        fontSize: "12px",
                        color: INK_2,
                        borderBottom:
                          i === titleRows.length - 1 ? "none" : `1px solid ${HAIRLINE}`,
                      }}
                    >
                      {t}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
          <td
            align="center"
            style={{
              verticalAlign: "middle",
              padding: "0 8px",
              fontFamily: SANS,
              fontSize: "20px",
              color: INK_3,
            }}
          >
            →
          </td>
          <td style={{ verticalAlign: "top" }}>
            <table
              role="presentation"
              width="100%"
              cellPadding={0}
              cellSpacing={0}
              border={0}
              style={{
                border: `1px solid ${GREEN_TINT_BORDER}`,
                borderRadius: "8px",
                borderCollapse: "separate",
                overflow: "hidden",
              }}
            >
              <tbody>
                <tr>
                  <td
                    style={{
                      padding: "8px 10px",
                      backgroundColor: GREEN_TINT,
                      borderBottom: `1px solid ${GREEN_TINT_BORDER}`,
                    }}
                  >
                    <span style={{ fontFamily: SANS, fontSize: "12px", fontWeight: 500, color: INK }}>
                      Opener
                    </span>
                    <span
                      style={{
                        marginLeft: "6px",
                        fontFamily: MONO,
                        fontSize: "10px",
                        color: ACCENT,
                        backgroundColor: "#ffffff",
                        border: `1px solid ${GREEN_TINT_BORDER}`,
                        borderRadius: "4px",
                        padding: "1px 5px",
                      }}
                    >
                      ƒ ai.generate
                    </span>
                  </td>
                </tr>
                {openers.map((o, i) => (
                  <tr key={i}>
                    <td
                      style={{
                        padding: "9px 10px",
                        fontFamily: MONO,
                        fontSize: "11.5px",
                        lineHeight: 1.4,
                        color: INK,
                        borderBottom:
                          i === openers.length - 1 ? "none" : `1px solid ${HAIRLINE}`,
                      }}
                    >
                      {o}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function ColumnsAreFunctions(props: ColumnsAreFunctionsProps): ReactNode {
  return (
    <EmailShell
      preview="Every column in gtm grid is a function — point one at an AI prompt and it fills itself, row by row."
      links={props.links}
    >
      <Eyebrow>The core idea</Eyebrow>
      <Headline>A column can do more than store text.</Headline>
      <Para>
        In gtm grid, every column is a function. Point one at an AI prompt or a connector and it
        fills itself — row by row. Here&rsquo;s the same column, before and after.
      </Para>
      <BeforeAfter />
      <InfoBox>
        To run AI columns, gtm grid needs your AI key. It&rsquo;s the one switch that turns your
        grid from a list into a machine.
      </InfoBox>
      <Cta href={props.ctaUrl}>Add your AI key</Cta>
    </EmailShell>
  );
}

export function columnsAreFunctionsEmail(
  props: ColumnsAreFunctionsProps,
): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: columnsAreFunctionsSubject(),
    element: <ColumnsAreFunctions {...props} />,
  });
}
