/**
 * Bridge from React Email elements to the package's {@link OutboundEmail}
 * contract, so lifecycle templates flow through the SAME `sendEmail()` Resend
 * seam (CID brand attachments, `AUTH_RESEND_KEY` gating) as the transactional
 * templates in ../templates.ts.
 */

import { render } from "@react-email/render";
import type { ReactElement } from "react";
import type { OutboundEmail } from "../templates.js";

export async function renderLifecycleEmail(opts: {
  to: string;
  subject: string;
  element: ReactElement;
}): Promise<OutboundEmail> {
  const [html, text] = await Promise.all([
    render(opts.element),
    render(opts.element, { plainText: true }),
  ]);
  return { to: opts.to, subject: opts.subject, html, text };
}
