/**
 * `/google/picker?state=…` — the Google Picker, hosted.
 *
 * Under the `drive.file` scope this page is not a convenience, it is the ONLY
 * way a spreadsheet becomes reachable: Google grants per-file access when the
 * user selects a file in this widget, and no server-side call can stand in for
 * that. Choosing the narrow scope (no verification review, no annual security
 * assessment) is what buys this page.
 *
 * Hosted on apps/web rather than rendered inside the desktop because the Picker
 * checks the JavaScript origin against the OAuth client's registered list, and
 * a stable https origin is far easier to register than an Electron renderer's.
 * The desktop opens it with `openExternal` and converges via its own poll.
 *
 * NO SESSION. The browser carries no gtmgrid.dev cookie, so `?state` — signed,
 * provider-bound, 15-minute — is the whole trust boundary, exactly as for the
 * OAuth callback. Every request below forwards it.
 *
 * Server state (the config fetch, the save) is owned by React Query; local
 * state is only what React Query cannot know — whether the user has finished.
 * The retry policy is the reason that split is worth it: see {@link isRetryable}.
 */

"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { errorCode, errorCopy, isRetryable, PickerError } from "./picker-errors";

interface PickerConfig {
  readonly accessToken: string;
  readonly developerKey: string;
  readonly appId: string;
  readonly clientId: string;
}

interface PickedFile {
  readonly id: string;
  readonly name: string;
}

/** Google's loader is injected rather than bundled — it must come from their origin. */
const GSI_SRC = "https://apis.google.com/js/api.js";

const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new PickerError(null));
    document.head.append(el);
  });

/** Narrow the config off an untrusted body without a cast (CLAUDE.md). */
const readConfig = (raw: unknown): PickerConfig => {
  if (typeof raw !== "object" || raw === null) throw new PickerError(null);
  const accessToken = Reflect.get(raw, "accessToken");
  const developerKey = Reflect.get(raw, "developerKey");
  const appId = Reflect.get(raw, "appId");
  const clientId = Reflect.get(raw, "clientId");
  if (
    typeof accessToken !== "string" ||
    typeof developerKey !== "string" ||
    typeof appId !== "string" ||
    typeof clientId !== "string"
  ) {
    throw new PickerError(null);
  }
  return { accessToken, developerKey, appId, clientId };
};

export default function GooglePickerPage() {
  /**
   * The signed state, read from the URL after mount.
   *
   * `null` means "not read yet" and is distinct from `""` (genuinely absent),
   * which is why the query stays disabled until it resolves — otherwise the
   * first render fires a request with an empty state and paints the expired-link
   * error for a frame before correcting itself.
   *
   * Deliberately NOT `useSearchParams`: that hook requires a `<Suspense>`
   * boundary, and `Suspense` is currently unusable in this app's typecheck —
   * there are two copies of `@types/react` in the tree (18 and 19), which makes
   * every built-in component type as `bigint` and produces ~108 TS2786s
   * repo-wide. Reading the URL directly costs one trivial effect and avoids
   * adding the 109th. Revisit once the types are deduped.
   */
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    setState(new URLSearchParams(window.location.search).get("state") ?? "");
  }, []);

  const [savedCount, setSavedCount] = useState<number | null>(null);

  const config = useQuery({
    queryKey: ["google-picker-config", state],
    retry: isRetryable,
    // Not until the URL is read, and never for a missing state — that can only
    // fail, so don't spend a request proving it.
    enabled: state !== null && state !== "",
    queryFn: async (): Promise<PickerConfig> => {
      // Unreachable — `enabled` gates on this — but narrowed rather than cast,
      // so the invariant is enforced by the compiler instead of asserted.
      if (state === null) throw new PickerError(null);
      const res = await fetch(`/api/oauth/google/picker?state=${encodeURIComponent(state)}`).catch(
        () => {
          throw new PickerError(null);
        },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new PickerError(errorCode(body));
      const parsed = readConfig(body);
      // The script is part of "ready to open the picker": the config alone is
      // useless without it, and folding it in means one loading state rather
      // than two that can disagree.
      await loadScript(GSI_SRC);
      return parsed;
    },
  });

  const save = useMutation({
    retry: isRetryable,
    mutationFn: async (files: readonly PickedFile[]): Promise<number> => {
      // Also unreachable: this only fires from the Picker callback, which only
      // exists once the config query succeeded — which required a state.
      if (state === null) throw new PickerError(null);
      const res = await fetch(`/api/oauth/google/picker?state=${encodeURIComponent(state)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
      }).catch(() => {
        throw new PickerError(null);
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new PickerError(errorCode(body));
      return files.length;
    },
    onSuccess: (count) => setSavedCount(count),
  });

  const openPicker = useCallback(() => {
    if (config.data === undefined) return;
    const { accessToken, developerKey, appId } = config.data;
    // `gapi` and `google.picker` are injected by Google's loader at runtime.
    const gapi = Reflect.get(window, "gapi");
    if (typeof gapi !== "object" || gapi === null) return;
    const load = Reflect.get(gapi, "load");
    if (typeof load !== "function") return;

    load("picker", () => {
      const picker = Reflect.get(Reflect.get(window, "google") ?? {}, "picker");
      if (typeof picker !== "object" || picker === null) return;

      // Google's Picker builder is an untyped runtime global; there is no
      // published type package, so this is dynamic by necessity rather than by
      // choice. Everything crossing back OUT of it is narrowed below.
      const p: Record<string, any> = picker;
      const view = new p.DocsView(p.ViewId.SPREADSHEETS)
        // Shared drives matter for real teams; without this a user simply cannot
        // see the sheet they were told to connect.
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);

      new p.PickerBuilder()
        .enableFeature(p.Feature.MULTISELECT_ENABLED)
        .setAppId(appId)
        .setOAuthToken(accessToken)
        .setDeveloperKey(developerKey)
        .addView(view)
        .setCallback((data: Record<string, unknown>) => {
          if (data[p.Response.ACTION] !== p.Action.PICKED) return;
          const docs: unknown = data[p.Response.DOCUMENTS];
          const files: PickedFile[] = Array.isArray(docs)
            ? docs.flatMap((d: unknown) => {
                if (d === null || typeof d !== "object") return [];
                const id = Reflect.get(d, "id");
                const name = Reflect.get(d, "name");
                if (typeof id !== "string") return [];
                return [{ id, name: typeof name === "string" ? name : id }];
              })
            : [];
          if (files.length > 0) save.mutate(files);
        })
        .build()
        .setVisible(true);
    });
  }, [config.data, save]);

  // Open automatically once ready — the user already expressed intent by
  // clicking "Select spreadsheets" in the app; making them click again here
  // would be a second confirmation of the same decision.
  useEffect(() => {
    if (config.isSuccess) openPicker();
    // Keyed on readiness, NOT on `openPicker`: that callback's identity changes
    // whenever the mutation re-renders, which would reopen the picker on top of
    // itself every time the user's selection is saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.isSuccess]);

  // A URL with no `state` at all is a dead link — the same class of failure as
  // an expired one, and reported the same way rather than left spinning.
  const failure =
    config.error ?? save.error ?? (state === "" ? new PickerError("invalid_or_expired_state") : null);

  return (
    <Shell>
      {savedCount !== null ? (
        <>
          <h1 style={titleStyle}>
            {savedCount === 1 ? "1 spreadsheet connected" : `${savedCount} spreadsheets connected`}
          </h1>
          <p style={bodyStyle}>You can close this tab and return to GTM Grid.</p>
        </>
      ) : failure !== null ? (
        <>
          <h1 style={titleStyle}>Couldn’t open the picker</h1>
          <p style={bodyStyle}>{errorCopy(failure)}</p>
        </>
      ) : save.isPending ? (
        <p style={bodyStyle}>Saving your selection…</p>
      ) : state === null || config.isPending ? (
        // `isPending` is also true while the query is DISABLED, so the null-state
        // check is what stops a dead link showing "Loading…" forever.
        <p style={bodyStyle}>Loading your Google Drive…</p>
      ) : (
        <>
          <h1 style={titleStyle}>Choose your spreadsheets</h1>
          <p style={bodyStyle}>GTM Grid can only open the files you select here.</p>
          <button type="button" onClick={openPicker} style={buttonStyle}>
            Open file picker
          </button>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: "32rem" }}>{children}</div>
    </main>
  );
}

const titleStyle: React.CSSProperties = { fontSize: "1.25rem", marginBottom: "0.5rem" };
const bodyStyle: React.CSSProperties = { color: "#555", marginBottom: "1.5rem" };
const buttonStyle: React.CSSProperties = {
  background: "#22C55E",
  color: "#fff",
  border: "none",
  borderRadius: "0.5rem",
  padding: "0.75rem 1.25rem",
  fontSize: "1rem",
  cursor: "pointer",
};
