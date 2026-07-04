/**
 * Lifecycle email #8 — "Create your first table".
 *
 * Trigger: signed up, no table after 24h.
 * Subject: `Your grid is empty — start with a CSV`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Eyebrow,
  Headline,
  MiniGrid,
  MonoNote,
  Para,
  SecondaryLink,
  type ShellLinks,
} from "./_components.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface FirstTableProps {
  readonly to: string;
  /** Greeting personalization — the mock copy goes straight to the headline, so
   * this is currently unused; kept to document the available merge var. */
  readonly firstName?: string;
  /** "Import a CSV" CTA target (opens the import flow). */
  readonly ctaUrl: string;
  /** "or start from a blank table" link target; defaults to {@link FirstTableProps.ctaUrl}. */
  readonly blankTableUrl?: string;
  readonly links?: ShellLinks;
}

export function firstTableSubject(): string {
  return "Your grid is empty — start with a CSV";
}

function FirstTable(props: FirstTableProps): ReactNode {
  return (
    <EmailShell
      preview="Drop in a CSV and gtm grid turns it into a live table — every column ready to become a function."
      links={props.links}
    >
      <Eyebrow>Get started</Eyebrow>
      <Headline>Your grid is empty. Let&rsquo;s fix that.</Headline>
      <Para>
        The fastest way in is a CSV. Drop in a list of leads or companies and gtm grid turns it
        into a live table — every column ready to become a function.
      </Para>
      <MiniGrid
        columns={[{ label: "Name" }, { label: "Company" }, { label: "Title" }]}
        rows={[
          ["Dana Lin", "Ramp", "VP Sales"],
          ["Omar Reyes", "Vercel", "Head of Growth"],
          ["Priya Nair", "Notion", "RevOps Lead"],
        ]}
      />
      <Cta href={props.ctaUrl}>Import a CSV</Cta>
      <div style={{ marginTop: "14px" }}>
        <SecondaryLink href={props.blankTableUrl ?? props.ctaUrl}>
          or start from a blank table
        </SecondaryLink>
      </div>
      <MonoNote>takes ~30 seconds · your data stays local</MonoNote>
    </EmailShell>
  );
}

export function firstTableEmail(props: FirstTableProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: firstTableSubject(),
    element: <FirstTable {...props} />,
  });
}
