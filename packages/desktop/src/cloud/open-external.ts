/**
 * Open a URL in the SYSTEM browser (TRI: oauth-adapter).
 *
 * One copy. This function existed three times over — `CrmSyncWizard`,
 * `CrmStatusStrip` and `AccountBar` each had their own, byte-identical modulo
 * formatting, and `Panels.tsx` imported the wizard's (making a modal component
 * a utility module by accident).
 *
 * It matters most for OAuth: the desktop's auth is bearer-based, so an
 * `openExternal` navigation deliberately carries NO gtmgrid.dev session — the
 * signed `state` minted over tRPC is the trust for the callback. The fallbacks
 * matter because the same components run in three hosts:
 *   - packaged Electron  → the preload's `openExternal` IPC (a real browser)
 *   - `pnpm desktop` dev → no Electron bridge, so a new tab
 *   - popup blocked      → same-tab navigation, which is worse UX but still
 *                          completes the handshake rather than dead-ending
 */

import { electron } from "../electron";

export async function openExternalUrl(url: string): Promise<void> {
  try {
    const api = electron();
    if (api) {
      await api.openExternal(url);
      return;
    }
  } catch {
    /* fall through to a browser tab */
  }
  const w = (globalThis as { window?: Window }).window;
  if (!w) return;
  const tab = w.open(url, "_blank", "noopener");
  if (!tab) w.location.assign(url);
}
