/**
 * Lifecycle email #13 — "New signals waiting".
 *
 * Trigger: the hourly `poll-trigify-signals` job lands new Social Signals rows
 * while the app is unopened.
 * Subject: `{n} new signals matched {search} — {hot_count} look hot`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Headline,
  ListRows,
  MonoInline,
  Para,
  Eyebrow,
  type ShellLinks,
} from "./_components.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

/** One matched Social Signals row shown as a sample (data is per-send). */
export interface WaitingSignal {
  /** Person · company, e.g. "Marcus Feld · Datadog". */
  readonly name: string;
  /** Muted second line, e.g. "posted about scaling the SDR team". */
  readonly detail: string;
  /** Signal score shown in the "hot · NN" chip. */
  readonly score: number;
}

export interface SignalsWaitingProps {
  readonly to: string;
  /** New signals that landed this hour (headline + "N new rows" in body). */
  readonly n: number;
  /** The saved search query the signals matched, e.g. "VP Sales · hiring". */
  readonly search: string;
  /** How many of the new signals scored hot (subject "{hot} look hot"). */
  readonly hotCount: number;
  /** Up to ~3 sample rows; the rest roll into the "+ N more" footer. */
  readonly signals: readonly WaitingSignal[];
  /** Deep link to the Social Signals table. */
  readonly viewUrl: string;
  readonly links?: ShellLinks;
}

export function signalsWaitingSubject(
  p: Pick<SignalsWaitingProps, "n" | "search" | "hotCount">,
): string {
  return `${p.n} new signals matched ${p.search} — ${p.hotCount} look hot`;
}

function SignalsWaiting(props: SignalsWaitingProps): ReactNode {
  const extra = props.n - props.signals.length;
  return (
    <EmailShell
      preview={`${props.n} new signals matched ${props.search}.`}
      links={props.links}
    >
      <Eyebrow>Signals</Eyebrow>
      <Headline>{props.n} new signals just landed.</Headline>
      <Para>
        Your <MonoInline>Social Signals</MonoInline> table matched {props.n} new rows for{" "}
        <MonoInline accent>&ldquo;{props.search}&rdquo;</MonoInline>. Three scored above 80.
      </Para>
      <ListRows
        items={props.signals.map((s) => ({
          title: s.name,
          subtitle: s.detail,
          chip: `hot · ${s.score}`,
        }))}
        footer={extra > 0 ? `+ ${extra} more matched this hour` : undefined}
      />
      <Cta href={props.viewUrl}>Open Social Signals</Cta>
    </EmailShell>
  );
}

export function signalsWaitingEmail(props: SignalsWaitingProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: signalsWaitingSubject(props),
    element: <SignalsWaiting {...props} />,
  });
}
