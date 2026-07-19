"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  CONSENT_REOPEN_EVENT,
  CONSENT_STORAGE_KEY,
  openConsentSettings,
  readConsent,
  writeConsent,
} from "../lib/consent";
import { posthogEnabled } from "../lib/env";

/**
 * Cookie-consent banner for the marketing site.
 *
 * Renders only when the visitor has made no choice yet, or when they re-open it
 * from a "Cookie settings" control. Accepting turns on PostHog persistence;
 * rejecting leaves it opted out with in-memory persistence. Both buttons are
 * given equal visual weight — a "reject" that is harder to find than "accept" is
 * not free consent under the ICO's guidance.
 */
export function CookieConsent() {
  // Starts false so the server-rendered markup and the first client render
  // match: the server cannot know the stored choice, and rendering the banner
  // before the effect reads localStorage would be a hydration mismatch.
  const [visible, setVisible] = useState(false);
  // True when opened from "Cookie settings" rather than by having no choice.
  // Only then is dismissing without choosing meaningful — there is already a
  // stored preference to fall back on.
  const [dismissable, setDismissable] = useState(false);

  useEffect(() => {
    // With no PostHog token there are no analytics cookies to consent to, so
    // asking would be theatre — and would imply tracking that is not happening.
    if (!posthogEnabled) return;

    setVisible(readConsent() === null);

    const reopen = () => {
      setDismissable(readConsent() !== null);
      setVisible(true);
    };
    // Another tab wrote a choice: honour it here rather than letting a stale
    // banner overwrite the newer decision when this tab is eventually clicked.
    const sync = (event: StorageEvent) => {
      if (event.key !== CONSENT_STORAGE_KEY) return;
      if (readConsent() !== null) setVisible(false);
    };

    window.addEventListener(CONSENT_REOPEN_EVENT, reopen);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CONSENT_REOPEN_EVENT, reopen);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const choose = useCallback(
    (choice: "granted" | "denied") => () => {
      writeConsent(choice);
      setVisible(false);
      setDismissable(false);
    },
    [],
  );

  if (!visible) return null;

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
          {dismissable ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setVisible(false)}
            >
              Cancel
            </button>
          ) : null}
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
 * Withdrawal control. Re-opens the banner so the visitor can change their mind.
 * Renders nothing when analytics are unconfigured — there is no choice to make.
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

/**
 * The §10 "you can change your mind" paragraph.
 *
 * Lives here rather than inline in the policy because it must disappear WHOLE
 * when analytics are unconfigured (a supported deployment — see §12 on
 * self-hosting). Inlining just the button left a broken sentence with a dangling
 * dash on those builds.
 */
export function ConsentSettingsParagraph() {
  if (!posthogEnabled) return null;
  return (
    <p>
      You can change your mind at any time — <CookieSettingsButton /> re-opens the
      banner. Declining opts you out, clears the identifiers our analytics tool was
      holding, and stops anything further being written to your device, apart from a
      single flag recording your refusal.
    </p>
  );
}
