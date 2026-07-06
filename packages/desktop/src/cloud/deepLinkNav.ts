/**
 * Pending in-app navigation captured from an `gtmgrid://open/...` deep link.
 *
 * Lifecycle emails link to a web bounce page whose CTAs redirect to
 * `gtmgrid://open/...` deep links; the OS routes those to the running desktop
 * app and the Electron main forwards EVERY `gtmgrid://` url to the renderer on
 * the `oauth-callback` IPC channel (warm delivery + cold-start replay). The
 * renderer's single listener ({@link useApiDeepLinkOAuth}) parses the url and,
 * for an `open/` link, records the resolved {@link DeepLinkDestination} here as
 * the SINGLE pending destination.
 *
 * This mirrors `pendingInvite.ts`: a tiny dependency-free module store with a
 * subscriber list so `App` re-renders when a deep link lands mid-session, reads
 * the destination once auth + workspace are ready, drives the matching UI, then
 * clears it. Unlike the invite token this is deliberately in-memory only — a
 * navigation intent is ephemeral, so it must never survive a reload and re-fire.
 *
 * {@link parseOpenDeepLink} is pure (exported for tests): it recognises exactly
 * the `open/` grammar and returns `null` for anything else — the OAuth callback,
 * an `invite/<token>` link, or garbage — so the existing auth/invite flows are
 * untouched and unknown destinations are ignored silently.
 */

import { useSyncExternalStore } from "react";

/**
 * A recognised in-app destination parsed from an `gtmgrid://open/...` deep link.
 *
 *  - `focus`        — bare `gtmgrid://open`: just surface the window (the main
 *                     process already does this on second-instance); no nav.
 *  - `table`        — open a specific cloud table, optionally switching workspace.
 *  - `new-table`    — open the new-table chooser.
 *  - `ai-providers` — open the AI-provider credentials panel.
 *  - `invite`       — open the invite / members UI (also the `members` alias).
 *  - `billing`      — open the billing / plan UI.
 *  - `crm-connected` — a CRM OAuth callback bounce (any provider): the CRM sync
 *                     wizard advances to Configure, reopening first if it had
 *                     been closed. `provider` is the CRM that was connected
 *                     (`?provider=`), or `null` when the link omits it.
 */
export type DeepLinkDestination =
  | { readonly kind: "focus" }
  | { readonly kind: "table"; readonly tableId: string; readonly workspaceId: string | null }
  | { readonly kind: "new-table" }
  | { readonly kind: "ai-providers" }
  | { readonly kind: "invite" }
  | { readonly kind: "billing" }
  | { readonly kind: "crm-connected"; readonly provider: string | null };

/**
 * Parse an `gtmgrid://open/...` deep link into a {@link DeepLinkDestination}, or
 * `null` when the url is not a recognised `open` link (wrong scheme/host, an
 * unknown or garbled destination, an OAuth callback, an `invite/<token>` link,
 * or malformed input). Pure + defensive so the caller can route unconditionally
 * and ignore non-matches. The scheme + destination keywords are matched
 * case-insensitively; ids (tableId / workspaceId) preserve their original case.
 */
export function parseOpenDeepLink(url: string): DeepLinkDestination | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // Scheme is always lowercased by the URL parser; the (non-special) host is not.
  if (parsed.protocol !== "gtmgrid:") return null;
  if (parsed.host.toLowerCase() !== "open") return null;

  const segments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  // Bare `gtmgrid://open` (or a trailing slash): show/focus the window only.
  if (segments.length === 0) return { kind: "focus" };

  const key = segments.map((s) => s.toLowerCase()).join("/");

  // `table/<tableId>[?workspace=<workspaceId>]` — exactly two segments; the id
  // keeps its original case. Extra path segments make it garbled → null.
  if (segments.length === 2 && segments[0].toLowerCase() === "table") {
    const tableId = segments[1];
    if (tableId.length === 0) return null;
    const workspaceId = parsed.searchParams.get("workspace");
    return {
      kind: "table",
      tableId,
      workspaceId: workspaceId && workspaceId.length > 0 ? workspaceId : null,
    };
  }

  switch (key) {
    case "new-table":
      return { kind: "new-table" };
    case "settings/ai-providers":
      return { kind: "ai-providers" };
    case "invite":
    case "members": // alias for the same invite / members UI
      return { kind: "invite" };
    case "billing":
      return { kind: "billing" };
    case "crm-connected": {
      const provider = parsed.searchParams.get("provider");
      return { kind: "crm-connected", provider: provider && provider.length > 0 ? provider : null };
    }
    default:
      return null;
  }
}

const listeners = new Set<() => void>();
let pending: DeepLinkDestination | null = null;

/** Record the pending destination (replacing any prior one) and notify subscribers. */
export function setPendingDestination(dest: DeepLinkDestination): void {
  pending = dest;
  for (const l of listeners) l();
}

/** The current pending destination, or `null` when there is none. */
export function getPendingDestination(): DeepLinkDestination | null {
  return pending;
}

/** Clear the pending destination (after it has been consumed) and notify. */
export function clearPendingDestination(): void {
  if (pending === null) return;
  pending = null;
  for (const l of listeners) l();
}

/** Subscribe to pending-destination changes; returns an unsubscribe fn. */
export function subscribePendingDestination(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive read of the pending destination (re-renders when a deep link lands). */
export function usePendingDestination(): DeepLinkDestination | null {
  return useSyncExternalStore(
    subscribePendingDestination,
    getPendingDestination,
    getPendingDestination,
  );
}
