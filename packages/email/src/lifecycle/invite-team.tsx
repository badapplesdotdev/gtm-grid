/**
 * Lifecycle email #11 — "Invite your team".
 *
 * Trigger: activated (first column run) but solo after ~3 days.
 * Subject: `Grids are better with your team`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Eyebrow,
  Headline,
  MonoInline,
  MonoNote,
  Para,
  type ShellLinks,
} from "./_components.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface InviteTeamProps {
  readonly to: string;
  /** Greeting personalization — unused by the current mock copy; kept to
   * document the available merge var. */
  readonly firstName?: string;
  /** Workspace display name (e.g. "Northbeam GTM"). */
  readonly workspace: string;
  /** Open seats remaining on the plan. */
  readonly seatsOpen: number;
  /** "Invite your team" CTA target (opens the invite flow). */
  readonly ctaUrl: string;
  readonly links?: ShellLinks;
}

export function inviteTeamSubject(): string {
  return "Grids are better with your team";
}

function InviteTeam(props: InviteTeamProps): ReactNode {
  const seatWord = props.seatsOpen === 1 ? "seat" : "seats";
  return (
    <EmailShell
      preview={`Invite your team into ${props.workspace} — anyone you add joins the workspace instantly.`}
      links={props.links}
    >
      <Eyebrow>Better together</Eyebrow>
      <Headline>Grids are better with your team in them.</Headline>
      <Para>
        You&rsquo;ve built something real in <MonoInline>{props.workspace}</MonoInline>. Invite a
        teammate and they can watch rows fill, add columns, and pick up where you left off — anyone
        you invite joins the workspace instantly, no approval step.
      </Para>
      <Para>
        You have {props.seatsOpen} open {seatWord} on your plan — bring in whoever you want.
      </Para>
      <Cta href={props.ctaUrl}>Invite your team</Cta>
      <MonoNote>execution stays local for every seat — only sync runs in the cloud</MonoNote>
    </EmailShell>
  );
}

export function inviteTeamEmail(props: InviteTeamProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: inviteTeamSubject(),
    element: <InviteTeam {...props} />,
  });
}
