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

/** Fired when consent changes so mounted components can re-read it. */
export const CONSENT_CHANGED_EVENT = "gtmgrid:consent-changed";

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
export function applyConsent(choice: ConsentChoice): void {
  if (choice === "granted") {
    posthog.set_config({ persistence: "localStorage+cookie" });
    posthog.opt_in_capturing();
    return;
  }
  posthog.opt_out_capturing();
  posthog.set_config({ persistence: "memory" });
  posthog.reset();
}

/** Persist a choice, apply it, and notify listeners. */
export function writeConsent(choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // If we cannot persist the choice we still honour it for this page view.
  }
  applyConsent(choice);
  window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT));
}

/** Clear the stored choice and re-open the banner (withdrawal of consent). */
export function resetConsent(): void {
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Ignore — the reopen event below still surfaces the banner.
  }
  applyConsent("denied");
  window.dispatchEvent(new CustomEvent(CONSENT_REOPEN_EVENT));
}
