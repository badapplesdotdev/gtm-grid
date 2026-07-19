"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CONSENT_REOPEN_EVENT,
  openConsentSettings,
  readConsent,
  writeConsent,
} from "../lib/consent";
import { posthogEnabled } from "../lib/env";

/**
 * Cookie-consent banner for the marketing site.
 *
 * Renders only when the visitor has made no choice yet. Accepting turns on
 * PostHog persistence; rejecting leaves it opted out with in-memory persistence,
 * so no analytics cookie is ever written. Both buttons are given equal visual
 * weight — a "reject" that is harder to find than "accept" is not free consent
 * under the ICO's guidance.
 */
export function CookieConsent() {
  // Starts false so the server-rendered markup and the first client render
  // match: the server cannot know the stored choice, and rendering the banner
  // before the effect reads localStorage would be a hydration mismatch.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // With no PostHog token there are no analytics cookies to consent to, so
    // asking would be theatre — and would imply tracking that is not happening.
    if (!posthogEnabled) return;
    setVisible(readConsent() === null);
    const reopen = () => setVisible(true);
    window.addEventListener(CONSENT_REOPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_REOPEN_EVENT, reopen);
  }, []);

  if (!visible) return null;

  const choose = (choice: "granted" | "denied") => () => {
    writeConsent(choice);
    setVisible(false);
  };

  return (
    // Deliberately `role="region"`, not `role="dialog"`. A dialog implies a
    // modal contract — focus trapping, Escape to dismiss, inert background —
    // that this banner does not implement, and announcing one without it is
    // worse for screen-reader users than not claiming it. The banner is a
    // non-blocking landmark the user can reach in normal tab order.
    <div
      className="cookie-banner"
      role="region"
      aria-labelledby="cookie-banner-title"
      aria-describedby="cookie-banner-body"
    >
      <div className="cookie-banner__inner">
        <div className="cookie-banner__copy">
          <p className="cookie-banner__title" id="cookie-banner-title">
            Cookies
          </p>
          <p className="cookie-banner__body" id="cookie-banner-body">
            We use cookies that are strictly necessary to run this site. With your
            permission we would also use analytics cookies to understand how the
            product is used. No advertising, and we never record your screen. See our{" "}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>
        </div>
        <div className="cookie-banner__actions">
          <button type="button" className="btn btn--ghost" onClick={choose("denied")}>
            Reject analytics
          </button>
          <button type="button" className="btn btn--primary" onClick={choose("granted")}>
            Accept analytics
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Withdrawal control. Clears the stored choice, opts PostHog back out, and
 * re-opens the banner. Used from the footer and from §10 of the privacy policy
 * so the right to withdraw consent is actually exercisable.
 */
export function CookieSettingsButton({ className }: { className?: string }) {
  if (!posthogEnabled) return null;
  return (
    <button
      type="button"
      className={className ?? "linklike"}
      onClick={() => openConsentSettings()}
    >
      Cookie settings
    </button>
  );
}
