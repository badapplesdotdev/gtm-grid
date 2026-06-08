/**
 * Pending workspace-invite token capture.
 *
 * An invite link reaches the desktop two ways:
 *   - a deep link `gtmgrid://invite/<token>` (the web /invite page's "Open in GTM
 *     Grid" button, or a direct email link when no web base is configured), and
 *   - a launch URL `?invite=<token>` / `#invite=<token>` (web build / dev).
 *
 * Both are persisted here (localStorage) as the SINGLE pending-invite token so the
 * app can (a) FORCE the sign-in / sign-up flow even if the user previously chose
 * "continue locally", and (b) auto-accept the invite once authenticated. Cleared
 * after a successful accept (or an explicit dismiss).
 *
 * A tiny subscriber list lets React components (the auth gate, the accept banner)
 * re-render when a deep link arrives mid-session.
 */

import { useSyncExternalStore } from "react";

const KEY = "gtmgrid:pendingInviteToken";
const listeners = new Set<() => void>();

/** Read an invite token from the launch URL (`?invite=` query or `#invite=` hash). */
function tokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("invite");
    if (q) return q;
    const hash = window.location.hash.replace(/^#/, "");
    return new URLSearchParams(hash).get("invite");
  } catch {
    return null;
  }
}

/** Extract the token from a `gtmgrid://invite/<token>` deep link, or null. */
export function inviteTokenFromDeepLink(url: string): string | null {
  const m = /^gtmgrid:\/\/invite\/([^/?#]+)/i.exec(url.trim());
  return m ? decodeURIComponent(m[1]) : null;
}

/** The current pending invite token (localStorage, falling back to the URL). */
export function getPendingInviteToken(): string | null {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
  } catch {
    /* no storage */
  }
  return tokenFromUrl();
}

/** Persist a pending invite token and notify subscribers. */
export function setPendingInviteToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* no storage — it still lives for this session via the URL fallback */
  }
  for (const l of listeners) l();
}

/** Clear the pending invite token (after accept / dismiss) and notify. */
export function clearPendingInviteToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  // Also strip it from the URL so a reload doesn't resurrect it.
  if (typeof window !== "undefined") {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("invite");
      if (u.hash.includes("invite=")) u.hash = "";
      window.history.replaceState({}, "", u.toString());
    } catch {
      /* ignore */
    }
  }
  for (const l of listeners) l();
}

/** Subscribe to pending-invite changes; returns an unsubscribe fn. */
export function subscribePendingInvite(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive read of the pending invite token (re-renders when a deep link lands). */
export function usePendingInviteToken(): string | null {
  return useSyncExternalStore(
    subscribePendingInvite,
    getPendingInviteToken,
    getPendingInviteToken,
  );
}
