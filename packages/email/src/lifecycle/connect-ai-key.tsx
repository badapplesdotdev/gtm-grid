/**
 * Lifecycle email #10 — "Connect your AI key" nudge.
 *
 * Trigger: ran a function column with no credentials (needs credential_connected).
 * Subject: `One step to run that column`.
 */

import type { ReactNode } from "react";
import {
  Cta,
  EmailShell,
  Eyebrow,
  Headline,
  MonoNote,
  Para,
  StepList,
  type ShellLinks,
} from "./_components.js";
import { BORDER, INK, SANS, WARNING } from "./tokens.js";
import { renderLifecycleEmail } from "./render.js";
import type { OutboundEmail } from "../templates.js";

export interface ConnectAiKeyProps {
  readonly to: string;
  /** Greeting personalization — unused by the current mock copy; kept to
   * document the available merge var. */
  readonly firstName?: string;
  /** "Open AI providers" CTA target (deep link into Settings → AI providers). */
  readonly ctaUrl: string;
  readonly links?: ShellLinks;
}

export function connectAiKeySubject(): string {
  return "One step to run that column";
}

/** Plain-text provider chips (no remote favicons — blocked in email clients). */
const providerChips: ReactNode = (
  <span style={{ display: "inline-block", marginTop: "2px" }}>
    {["Anthropic", "OpenAI"].map((name, i) => (
      <span
        key={name}
        style={{
          display: "inline-block",
          marginRight: i === 0 ? "8px" : 0,
          fontFamily: SANS,
          fontSize: "12.5px",
          color: INK,
          backgroundColor: "#ffffff",
          border: `1px solid ${BORDER}`,
          borderRadius: "6px",
          padding: "6px 11px",
        }}
      >
        {name}
      </span>
    ))}
  </span>
);

function ConnectAiKey(props: ConnectAiKeyProps): ReactNode {
  return (
    <EmailShell
      preview="Add an AI key and that column runs instantly — you bring your own, and it never leaves your machine."
      links={props.links}
    >
      <Eyebrow color={WARNING}>Action needed</Eyebrow>
      <Headline>One step to run that column.</Headline>
      <Para>
        You just tried to run a function that needs an AI provider. Add a key and it runs
        instantly — you bring your own, and it never leaves your machine.
      </Para>
      <StepList
        steps={[
          { title: "Grab a key from your provider", detail: providerChips },
          {
            title: "Paste it into Settings → AI providers",
            detail: "Stored locally, encrypted with AES-256-GCM.",
          },
        ]}
      />
      <Cta href={props.ctaUrl}>Open AI providers</Cta>
      <MonoNote>keys are stored on your device, encrypted — never on our servers</MonoNote>
    </EmailShell>
  );
}

export function connectAiKeyEmail(props: ConnectAiKeyProps): Promise<OutboundEmail> {
  return renderLifecycleEmail({
    to: props.to,
    subject: connectAiKeySubject(),
    element: <ConnectAiKey {...props} />,
  });
}
