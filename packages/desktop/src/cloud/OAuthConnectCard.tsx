/**
 * `OAuthConnectCard` — connect / reconnect / disconnect for ANY OAuth provider
 * (TRI: oauth-adapter).
 *
 * The flow this owns is the same for every provider and is NOT obvious:
 *   1. Ask the server for an authorize URL. The state is minted SERVER-side,
 *      because desktop auth is bearer-based — an `openExternal` navigation
 *      carries no gtmgrid.dev cookie, so a browser-minted state would dead-end
 *      on the web route's session gate.
 *   2. Open it in the system browser and POLL, because the browser completes the
 *      handshake out-of-process and the deep link back is best-effort (the OS
 *      may not hand off, or the user may just switch back manually). The poll is
 *      the reliable signal; the deep link is the fast one.
 *   3. Stop polling after a bounded window, so a user who abandons the consent
 *      screen doesn't leave a timer running forever.
 *
 * Everything provider-specific arrives as props. The markup keeps the existing
 * `crm-oauth-*` class names on purpose: they are already styled, and
 * `packages/desktop/e2e/crm.spec.ts` selects on `.crm-oauth-card`. The names are
 * a legacy artifact now that a non-CRM provider uses them — renaming is a
 * cosmetic follow-up, not worth breaking the E2E selectors for here.
 *
 * Plain React: no Effect in the view layer (CLAUDE.md).
 */

import { useCallback, useEffect, useState } from "react";
import { openExternalUrl } from "./open-external";

/** How long to keep polling after opening the consent screen. */
const POLL_WINDOW_MS = 120_000;
const POLL_EVERY_MS = 2_000;

export type OAuthCardStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected"; readonly configured: boolean }
  | { readonly kind: "connected"; readonly byName: string; readonly accountLabel: string }
  /**
   * The status read FAILED — we do not know whether this deployment is
   * configured or this workspace connected.
   *
   * This variant exists because without it the caller's `catch` had no way to say
   * "unknown" and had to pick a lie: it picked `{ disconnected, configured:
   * false }`, which renders "isn't set up on this deployment yet" and DISABLES
   * Connect. A transient fault therefore accused the operator of never having
   * installed the app, and removed the only control that could recover. Not
   * knowing is a real state, so it gets a real case.
   */
  | { readonly kind: "error" };

export interface OAuthConnectCardProps {
  /** Heading, e.g. "CRM sync · OAuth connection" or "Slack · OAuth connection". */
  readonly headText: string;
  /** Product name for button/status copy ("Attio", "Slack"). */
  readonly providerName: string;
  readonly status: OAuthCardStatus;
  /** Re-read the status. Called on mount and on every poll tick. */
  readonly refresh: () => Promise<void>;
  /** Resolve the authorize URL (server-minted state). */
  readonly authorizeUrl: () => Promise<string>;
  /** Disconnect; returns the note to show. */
  readonly disconnect: () => Promise<string>;
  /** Sub-copy under "Connected · <account>". */
  readonly connectedSub: string;
  /** Sub-copy under "Not connected". */
  readonly disconnectedSub: string;
  /** Optional trailing note (e.g. "the API key below is separate"). */
  readonly footerNote?: string;
}

export function OAuthConnectCard(props: OAuthConnectCardProps) {
  const { headText, providerName, status, refresh, authorizeUrl, disconnect } = props;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Poll only WHILE a round-trip is in flight, and give up after a bounded
  // window — the user may simply have closed the consent tab.
  useEffect(() => {
    if (!busy) return;
    const tick = setInterval(() => {
      void refresh();
    }, POLL_EVERY_MS);
    const stop = setTimeout(() => setBusy(false), POLL_WINDOW_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [busy, refresh]);

  useEffect(() => {
    if (busy && status.kind === "connected") {
      setBusy(false);
      setNote(`${providerName} connected.`);
    }
  }, [busy, status, providerName]);

  const authorize = useCallback(async () => {
    setNote(null);
    try {
      const url = await authorizeUrl();
      // Set busy BEFORE handing off: on a fast local round-trip the connection
      // can land before the browser even returns focus.
      setBusy(true);
      await openExternalUrl(url);
    } catch (e) {
      setBusy(false);
      setNote(e instanceof Error ? e.message : `Could not start the ${providerName} connection.`);
    }
  }, [authorizeUrl, providerName]);

  const onDisconnect = useCallback(async () => {
    setConfirming(false);
    setNote(null);
    try {
      setNote(await disconnect());
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : `Could not disconnect ${providerName}.`);
    }
  }, [disconnect, refresh, providerName]);

  return (
    <div className="crm-oauth-card">
      <div className="crm-oauth-head">{headText}</div>
      <div className="crm-oauth-body">
        {status.kind === "loading" ? (
          <span className="cell-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
        ) : status.kind === "error" ? (
          <>
            <span className="crm-oauth-dot off" />
            <span className="crm-oauth-text">
              Couldn&rsquo;t check {providerName}
              <span className="crm-oauth-sub">
                Something went wrong reading the connection status. This says nothing about
                whether {providerName} is connected.
              </span>
            </span>
            {/* Retry, not a disabled Connect: the user has to be able to get out
                of this state, and the previous rendering took that away. */}
            <button className="skill-btn" disabled={busy} onClick={() => void refresh()}>
              Retry
            </button>
          </>
        ) : status.kind === "connected" ? (
          <>
            <span className="crm-oauth-dot" />
            <span className="crm-oauth-text">
              Connected · {status.accountLabel}
              <span className="crm-oauth-sub">
                {props.connectedSub}
                {status.byName ? ` · connected by ${status.byName}` : ""}
              </span>
            </span>
            <button className="skill-btn" disabled={busy} onClick={() => void authorize()}>
              {busy ? `Waiting for ${providerName}…` : "Reconnect"}
            </button>
            {confirming ? (
              <>
                <button className="skill-btn danger" onClick={() => void onDisconnect()}>
                  Confirm disconnect
                </button>
                <button className="skill-btn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="skill-btn" onClick={() => setConfirming(true)}>
                Disconnect
              </button>
            )}
          </>
        ) : (
          <>
            <span className="crm-oauth-dot off" />
            <span className="crm-oauth-text">
              Not connected
              <span className="crm-oauth-sub">
                {status.configured
                  ? props.disconnectedSub
                  : // "Configured" and "connected" are different things: a
                    // self-hosted deployment with no OAuth app can never
                    // connect, so say so rather than offering a dead button.
                    `${providerName} isn't set up on this deployment yet.`}
              </span>
            </span>
            <button
              className="skill-btn primary"
              disabled={busy || !status.configured}
              onClick={() => void authorize()}
            >
              {busy ? `Waiting for ${providerName}…` : `Connect ${providerName}`}
            </button>
          </>
        )}
      </div>
      {note ? <div className="crm-oauth-note">{note}</div> : null}
      {props.footerNote ? <div className="crm-oauth-note subtle">{props.footerNote}</div> : null}
    </div>
  );
}
