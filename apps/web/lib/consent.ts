/**
 * Cookie-consent state for the marketing site.
 *
 * Under UK PECR / the EU ePrivacy Directive, non-essential storage (our PostHog
 * analytics cookies) needs *prior* consent — it may not be set on page load and
 * then withdrawn later. So PostHog boots opted-out with `persistence: "memory"`,
 * writing nothing to cookies or localStorage, and is only switched to persistent
 * storage once the visitor accepts.
 *
 * The consent choice itself is stored in localStorage rather than a cookie. It is
 * strictly necessary (it exists only to honour the visitor's own preference), so
 * it does not itself require consent.
 */
import posthog from "posthog-js";

export const CONSENT_STORAGE_KEY = "gtmgrid_cookie_consent";

/** Fired to re-open the banner so a visitor can change their mind. */
export const CONSENT_REOPEN_EVENT = "gtmgrid:consent-reopen";

export type ConsentChoice = "granted" | "denied";

/** `null` means the visitor has not chosen yet — analytics must stay off. */
export function readConsent(): ConsentChoice | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return stored === "granted" || stored === "denied" ? stored : null;
  } catch {
    // Private-browsing modes can throw on localStorage access. Treat an
    // unreadable store as "no consent given", which is the safe default.
    return null;
  }
}

/**
 * Apply a choice to the live PostHog instance.
 *
 * Granting switches persistence to cookies+localStorage and opts in. Denying
 * opts out and drops any identifying state PostHog is holding in memory.
 */
export function applyConsent(choice: ConsentChoice, options?: { silent?: boolean }): void {
  if (choice === "granted") {
    posthog.set_config({ persistence: "localStorage+cookie" });
    // `opt_in_capturing` emits an `$opt_in` event by default. That is right when
    // the visitor actively accepts, but re-applying a stored choice on every page
    // load would emit one per navigation, inflating the event stream.
    posthog.opt_in_capturing(options?.silent ? { captureEventName: false } : undefined);
    return;
  }
  // Order matters: opt out first so nothing is captured mid-teardown, then
  // `reset()` to drop the stored distinct id and any identifying state, and only
  // then switch to memory persistence so future state is never written to disk.
  posthog.opt_out_capturing();
  posthog.reset();
  posthog.set_config({ persistence: "memory" });
}

/** Persist an actively-made choice and apply it. */
export function writeConsent(choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // If we cannot persist the choice we still honour it for this page view.
  }
  applyConsent(choice);
}

/**
 * Re-open the banner so the visitor can change their mind.
 *
 * This deliberately does NOT revoke consent. Opening a settings control is not
 * the same as withdrawing — silently opting someone out (and resetting their
 * identity) merely for looking would be wrong, and would also mean an accidental
 * click quietly changed their preference. The existing choice stands until they
 * pick a different one in the banner.
 */
export function openConsentSettings(): void {
  window.dispatchEvent(new CustomEvent(CONSENT_REOPEN_EVENT));
}
