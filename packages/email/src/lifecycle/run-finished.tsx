/**
 * Lifecycle email #12 — "Your run finished" (design: highest priority).
 *
 * Trigger: a long column run / import / Social Signals sync completes while the
 * app is closed (owner's last_active_at older than the presence window).
 * Subject: `✅ {done_count} rows enriched in {table}`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  FnChip,
  Headline,
  ListRows,
  MonoInline,
  Para,
  StatRow,
  SuccessEyebrow,
  type ShellLinks,
} from "./_components.js";
import { DANGER, INK_2, SANS, SUCCESS } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface RunFinishedProps {
  readonly to: string;
  /** Rows completed successfully. */
  readonly doneCount: number;
  /** Rows that errored (0 hides the stat's red tint). */
  readonly errorCount: number;
  /** Table display name (e.g. "Q3 Outbound"). */
  readonly table: string;
  /** Connector/method chip, e.g. "trigify.enrichProfile". */
  readonly fn: string;
  /** Column display name the run targeted. */
  readonly column: string;
  /** Human duration, e.g. "2m 14s". */
  readonly duration: string;
  /** Cloud actions consumed. */
  readonly creditsUsed: number;
  /** Up to ~3 sample completed rows ("Dana Lin · Ramp"). */
  readonly sampleRows: readonly string[];
  /** Deep link to the table results. */
  readonly viewUrl: string;
  readonly links?: ShellLinks;
}

export function runFinishedSubject(p: Pick<RunFinishedProps, "doneCount" | "table">): string {
  return `✅ ${p.doneCount} rows enriched in ${p.table}`;
}

function RunFinished(props: RunFinishedProps): ReactNode {
  const extra = props.doneCount - props.sampleRows.length;
  return (
    <EmailShell
      preview={`${props.doneCount} rows enriched in ${props.table} while you were away.`}
      links={props.links}
    >
      <SuccessEyebrow>Run complete</SuccessEyebrow>
      <Headline>
        {props.doneCount} rows enriched in <MonoInline accent>{props.table}</MonoInline>
      </Headline>
      <Para>Ran while you were away. Here&rsquo;s what landed.</Para>
      <StatRow
        caption={
          <>
            <FnChip>ƒ {props.fn}</FnChip>
            <span style={{ marginLeft: "8px", fontFamily: SANS, fontSize: "12.5px", color: INK_2 }}>
              on column &ldquo;{props.column}&rdquo;
            </span>
          </>
        }
        stats={[
          { value: String(props.doneCount), label: "done", color: SUCCESS },
          {
            value: String(props.errorCount),
            label: "errored",
            color: props.errorCount > 0 ? DANGER : undefined,
          },
          { value: props.duration, label: "duration" },
          { value: String(props.creditsUsed), label: "credits" },
        ]}
      />
      <ListRows
        items={[
          ...props.sampleRows.map((title) => ({ title, chip: "done", mono: true })),
          ...(extra > 0
            ? [{ title: `+ ${extra} more rows`, chip: "done", mono: true }]
            : []),
        ]}
      />
      <Cta href={props.viewUrl}>View results</Cta>
    </EmailShell>
  );
}

export function runFinishedEmail(props: RunFinishedProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: runFinishedSubject(props),
    element: <RunFinished {...props} />,
  });
}
