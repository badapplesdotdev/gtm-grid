/**
 * Lifecycle email #15 — "Dormant re-engagement".
 *
 * Trigger: no `app_opened` for 7 days (content is fully dynamic per workspace).
 * Subject: `Your table {table} is waiting`.
 */

import type { ReactNode } from "react";
import { Cta, EmailShell, Headline, MonoInline, Para, Eyebrow, type ShellLinks } from "./_components.js";
import { BORDER, INK, SANS } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

// Status-dot colors (design uses the brighter green/amber signal dots, distinct
// from the CTA/success inks in tokens).
const DOT_GREEN = "#22c55e";
const DOT_AMBER = "#f59e0b";

export interface DormantProps {
  readonly to: string;
  /** Table display name, e.g. "Q3 Outbound". */
  readonly table: string;
  /** Cells recomputed while away (headline + "N cells recomputed"). */
  readonly cellsChanged: number;
  /** New Social Signals rows picked up. */
  readonly newRows: number;
  /** Columns the recompute spanned. */
  readonly columnsRecomputed: number;
  /** Rows needing a re-run after edits (amber row). */
  readonly rowsNeedRerun: number;
  /** Deep link back into the table. */
  readonly jumpUrl: string;
  readonly links?: ShellLinks;
}

export function dormantSubject(p: Pick<DormantProps, "table">): string {
  return `Your table ${p.table} is waiting`;
}

function StatusRow(props: { dot: string; children: ReactNode }): ReactNode {
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ marginTop: "8px", border: `1px solid ${BORDER}`, borderRadius: "8px", borderCollapse: "separate" }}
    >
      <tbody>
        <tr>
          <td width={26} style={{ padding: "12px 0 12px 14px", verticalAlign: "middle" }}>
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: props.dot,
              }}
            />
          </td>
          <td style={{ padding: "12px 14px 12px 12px", verticalAlign: "middle" }}>
            <span style={{ fontFamily: SANS, fontSize: "13.5px", color: INK }}>{props.children}</span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Dormant(props: DormantProps): ReactNode {
  return (
    <EmailShell
      preview={`${props.cellsChanged} cells changed in ${props.table} while you were away.`}
      links={props.links}
    >
      <Eyebrow>Welcome back</Eyebrow>
      <Headline>{props.cellsChanged} cells changed since you left.</Headline>
      <Para>
        It&rsquo;s been a week. While you were gone, <MonoInline>{props.table}</MonoInline> kept
        working — signals kept matching and syncs kept running.
      </Para>
      <div style={{ marginTop: "16px" }}>
        <StatusRow dot={DOT_GREEN}>
          Social Signals picked up <b style={{ fontWeight: 600 }}>{props.newRows} new rows</b>
        </StatusRow>
        <StatusRow dot={DOT_GREEN}>
          <b style={{ fontWeight: 600 }}>{props.cellsChanged} cells</b> recomputed across{" "}
          {props.columnsRecomputed} columns
        </StatusRow>
        <StatusRow dot={DOT_AMBER}>
          <b style={{ fontWeight: 600 }}>{props.rowsNeedRerun} rows</b> need a re-run after edits
        </StatusRow>
      </div>
      <Cta href={props.jumpUrl}>Jump back in</Cta>
    </EmailShell>
  );
}

export function dormantEmail(props: DormantProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: dormantSubject(props),
    element: <Dormant {...props} />,
  });
}
