"use client";

/**
 * CopyCode — client-side copy-to-clipboard control for the invite code.
 *
 * The invite landing page (./page.tsx) is a server component, but the fallback
 * "paste this code" affordance needs `onClick` + `navigator.clipboard`, both of
 * which only exist in the browser. We isolate that interactivity here so the page
 * itself stays a server component (no client JS for the rest of the route).
 *
 * Renders the invite token in a monospace field with a copy button that flips to
 * a transient "copied" state. Falls back gracefully if the Clipboard API is
 * unavailable (older browsers / insecure contexts) by selecting nothing and
 * leaving the visible code for manual selection.
 */

import { useState } from "react";
import posthog from "posthog-js";

export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      posthog.capture("invite_code_copied");
    } catch {
      // Clipboard API blocked (insecure context / permissions): leave the code
      // visible so it can still be selected and copied by hand.
      setCopied(false);
    }
  }

  return (
    <div className="invite-code">
      <code className="invite-code__value">{code}</code>
      <button
        type="button"
        className="invite-code__copy"
        onClick={handleCopy}
        aria-label="Copy invite code"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
