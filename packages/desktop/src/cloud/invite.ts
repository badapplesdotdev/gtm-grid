/**
 * Invite + upgrade orchestration — client-side LOGIC as an Effect service.
 *
 * Inviting a member is by EMAIL and gated on seats (Autumn). The tRPC
 * `invitations.invite` mutation returns one of three results:
 *
 *   - `{ status: "invited", email, acceptUrl, emailSent }` — a pending invite
 *     was created and the accept link emailed (best-effort; `emailSent` is false
 *     when email isn't configured, in which case the UI surfaces the copyable
 *     `acceptUrl` from the pending list instead),
 *   - `{ status: "already_member", email }` — that email already belongs to the
 *     workspace; nothing changed, and
 *   - `{ status: "checkout", checkoutUrl }` — over the seat limit; nobody was
 *     invited and the UI must open the Autumn checkout to upgrade.
 *
 * This service owns that branch:
 *
 *   1. validate there is a signed-in session (typed error otherwise),
 *   2. delegate the invite to the injected {@link InviteRunner} (the tRPC
 *      mutation call), and
 *   3. on the over-limit (`checkout`) result, open the checkout URL via the
 *      injected {@link UrlOpener} (the SYSTEM browser) before reporting
 *      `"checkout"` so the UI can show its upgrade modal. The `invited` and
 *      `already_member` results pass through unchanged for the UI to message.
 *
 * Per the repo convention React components stay plain React; this orchestration
 * is an Effect service with typed errors + Layers so it is unit-tested by
 * providing FAKE `InviteRunner` / `UrlOpener` Layers — no real client, no real
 * browser. The thin React glue that binds it to component state lives in
 * WorkspaceSettings.tsx. Mirrors the ./cloud-run.ts pattern.
 */

import { Context, Data, Effect, Layer } from "effect";
import { useMemo } from "react";
import { apiClient } from "./client";
import { electron } from "../electron";

/** A workspace member role. */
export type MemberRole = "owner" | "admin" | "member";

/** A request to invite a user to a workspace by email. */
export interface InviteInput {
  /** The `workspaces.id` to invite the user to. */
  readonly workspaceId: string;
  /** The invitee's email address. */
  readonly email: string;
  /** The role to grant on accept. Defaults to `"member"` at the call site. */
  readonly role: MemberRole;
}

/**
 * The Convex `invitations.inviteByEmail` action result, mirrored from
 * convex/invitations.ts: a pending invite was created (`invited`), the email is
 * already a member (`already_member`), or the workspace is over its seat limit
 * and the caller must open `checkoutUrl` to upgrade (`checkout`).
 */
export type InviteActionResult =
  | {
      readonly status: "invited";
      readonly email: string;
      readonly acceptUrl: string;
      readonly emailSent: boolean;
    }
  | { readonly status: "already_member"; readonly email: string }
  | { readonly status: "checkout"; readonly checkoutUrl: string };

/**
 * The outcome the UI acts on:
 *   - `invited`        → a pending invite was created; the pending list updates
 *      live. `emailSent` tells the UI whether the accept link was emailed or the
 *      user should copy it from the pending list.
 *   - `already_member` → the email already belongs to the workspace; show a
 *      small "already a member" message.
 *   - `checkout`       → over the seat limit; the checkout URL has ALREADY been
 *      opened in the system browser, and `checkoutUrl` is returned so the UI can
 *      show its upgrade modal (with a manual "open" fallback link).
 */
export type InviteOutcome =
  | {
      readonly status: "invited";
      readonly email: string;
      readonly acceptUrl: string;
      readonly emailSent: boolean;
    }
  | { readonly status: "already_member"; readonly email: string }
  | { readonly status: "checkout"; readonly checkoutUrl: string };

/** Raised when the invite cannot be performed (no session, or a backend error). */
export class InviteError extends Data.TaggedError("InviteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Port: performs the Convex `invitations.inviteByEmail` action. Abstracted
 * behind a tag so the orchestration is testable without a real Convex client.
 * The Live Layer is built in WorkspaceSettings.tsx from the `useAction` hook
 * (React-bound), so no default Layer lives here.
 */
export interface InviteRunnerShape {
  readonly invite: (
    input: InviteInput,
  ) => Effect.Effect<InviteActionResult, InviteError>;
}

export class InviteRunner extends Context.Tag("InviteRunner")<
  InviteRunner,
  InviteRunnerShape
>() {}

/**
 * The single tRPC call this runner makes: `invitations.invite.mutate`. Abstracted
 * so the runner can be unit-tested with a fake mutate fn (no live client),
 * defaulting to the module `apiClient` in the app. Returns the
 * {@link InviteActionResult} (the tRPC `InviteByEmailResult` shares this shape —
 * `invited` / `already_member` / `checkout`).
 */
export type InviteMutate = (args: {
  readonly workspaceId: string;
  readonly email: string;
  readonly role: MemberRole;
}) => Promise<InviteActionResult>;

/**
 * Build an {@link InviteRunnerShape} backed by the NEW tRPC `invitations.invite`
 * mutation (TRI-3255). This is the strangler-fig replacement for the Convex
 * `useAction(api.invitations.inviteByEmail)`-derived runner the UI built inline:
 * the same port, fed by the vanilla tRPC client instead of Convex, so the
 * three-way invited/already_member/checkout branch in {@link InviteServiceLive}
 * is unchanged. Pure (no React) so the call site composes it into the Live Layer
 * directly and tests can inject a fake mutate. A tRPC error is normalized to a
 * typed {@link InviteError} so the orchestration's error channel is unchanged.
 *
 * `mutate` defaults to the module `apiClient`'s `invitations.invite.mutate`
 * (non-null on the `cloudViaApi` path — the only path that builds this runner);
 * tests pass a fake to exercise the call + error mapping without a live client.
 */
export function apiInviteRunner(
  mutate: InviteMutate = (args) =>
    apiClient!.invitations.invite.mutate(args) as Promise<InviteActionResult>,
): InviteRunnerShape {
  return {
    invite: (input: InviteInput) =>
      Effect.tryPromise({
        try: () =>
          mutate({
            workspaceId: input.workspaceId,
            email: input.email,
            role: input.role,
          }),
        catch: (cause) =>
          new InviteError({
            message: cause instanceof Error ? cause.message : "Invite failed.",
            cause,
          }),
      }),
  };
}

/**
 * Port: opens a URL in the user's SYSTEM browser (Autumn checkout). Abstracted
 * so the orchestration is testable without a real browser; the Live Layer
 * ({@link UrlOpenerLive}) delegates to the platform opener.
 */
export interface UrlOpenerShape {
  readonly open: (url: string) => Effect.Effect<void, InviteError>;
}

export class UrlOpener extends Context.Tag("UrlOpener")<
  UrlOpener,
  UrlOpenerShape
>() {}

/** The invite orchestration the UI calls. */
export interface InviteServiceShape {
  /**
   * Invite a user by email. Fails with {@link InviteError} when there is no
   * signed-in session or the backend call fails. On the over-limit (`checkout`)
   * path it opens the checkout URL in the system browser before resolving with
   * `"checkout"`; the `invited` and `already_member` results pass through.
   */
  readonly inviteMember: (
    hasSession: boolean,
    input: InviteInput,
  ) => Effect.Effect<InviteOutcome, InviteError>;
}

export class InviteService extends Context.Tag("InviteService")<
  InviteService,
  InviteServiceShape
>() {}

/**
 * The orchestration: guard on a session, delegate to {@link InviteRunner}, and
 * on the `checkout` branch open the URL via {@link UrlOpener}. Requiring both
 * ports means the same service runs against real Convex/browser (Live) or fakes
 * (tests).
 */
export const InviteServiceLive: Layer.Layer<
  InviteService,
  never,
  InviteRunner | UrlOpener
> = Layer.effect(
  InviteService,
  Effect.gen(function* () {
    const runner = yield* InviteRunner;
    const opener = yield* UrlOpener;
    return {
      inviteMember: (hasSession, input) =>
        !hasSession
          ? Effect.fail(
              new InviteError({
                message: "Sign in to a workspace to invite members.",
              }),
            )
          : runner.invite(input).pipe(
              Effect.flatMap((result) => {
                switch (result.status) {
                  case "invited":
                    // A pending invite was created; pass it through so the UI can
                    // clear the field and (when `emailSent` is false) point the
                    // user at the copyable accept link.
                    return Effect.succeed<InviteOutcome>({
                      status: "invited",
                      email: result.email,
                      acceptUrl: result.acceptUrl,
                      emailSent: result.emailSent,
                    });
                  case "already_member":
                    // No-op on the backend; let the UI show a small message.
                    return Effect.succeed<InviteOutcome>({
                      status: "already_member",
                      email: result.email,
                    });
                  case "checkout":
                    // Over the seat limit: open the checkout in the system
                    // browser, then report `checkout` so the UI shows its modal.
                    return opener.open(result.checkoutUrl).pipe(
                      Effect.as<InviteOutcome>({
                        status: "checkout",
                        checkoutUrl: result.checkoutUrl,
                      }),
                    );
                }
              }),
            ),
    } satisfies InviteServiceShape;
  }),
);

/**
 * A {@link UrlOpener} that opens a billing/accept URL the user can complete.
 *
 * The opener runs AFTER an `await` (the Convex action), so the original click's
 * user-gesture context is gone. That breaks the naive `window.open(url,"_blank")`
 * two ways: in a browser the popup blocker silently kills it (returns `null`, no
 * error → "nothing happened"), and in the packaged Tauri webview `window.open`
 * to an external origin doesn't reach the system browser at all. So we branch:
 *
 *   - PACKAGED TAURI app → hand the URL to the OS via the opener plugin
 *     (Electron `shell.openExternal` via the preload bridge), so the web bundle never
 *     loads it. The webview itself must NOT navigate to the billing page.
 *   - WEB build → try a new tab first (preserves the app when popups are
 *     allowed); if it's blocked, fall back to a SAME-TAB redirect
 *     (`location.assign`), which is never popup-blocked — the standard hosted
 *     checkout flow (pay, then Autumn redirects back).
 *
 * Guards a non-browser context (the Node test runner) with a typed error.
 */
export const UrlOpenerLive: Layer.Layer<UrlOpener> = Layer.succeed(UrlOpener, {
  open: (url) =>
    Effect.tryPromise({
      try: async () => {
        const api = electron();
        if (api) {
          await api.openExternal(url);
          return;
        }
        const w = (globalThis as { window?: Window }).window;
        if (w === undefined) {
          throw new Error("No system browser available to open the checkout URL.");
        }
        // New tab if allowed; otherwise same-tab redirect (never popup-blocked).
        const tab = w.open(url, "_blank", "noopener");
        if (tab === null) {
          w.location.assign(url);
        }
      },
      catch: (cause) =>
        new InviteError({
          message:
            cause instanceof Error
              ? cause.message
              : "Could not open the checkout URL.",
          cause,
        }),
    }),
});

/**
 * A {@link UrlOpener} that does NOTHING (TRI-3260).
 *
 * Used on the ONBOARDING path: there, an over-limit (`checkout`) invite must NOT
 * yank the user out to the system browser / redirect away mid-wizard — that
 * abandons onboarding. Instead the seat gate is deferred to the dedicated plan
 * step. So the onboarding invite Layer composes {@link InviteServiceLive} with
 * THIS no-op opener: the `checkout` result still flows back (the caller collects
 * and ignores it) but no browser/redirect side effect fires. The
 * settings-panel path keeps {@link UrlOpenerLive} so its upgrade flow still
 * opens checkout.
 */
export const UrlOpenerNoop: Layer.Layer<UrlOpener> = Layer.succeed(UrlOpener, {
  open: () => Effect.void,
});

/**
 * Convenience: run the invite orchestration, returning a Promise (so the React
 * glue can `await` it). Accepts the composed Layer so callers/tests choose the
 * transport. There is no module-level Live Layer because the {@link InviteRunner}
 * is built from a React hook (Convex `useAction`) at the call site.
 */
export function runInvite(
  hasSession: boolean,
  input: InviteInput,
  layer: Layer.Layer<InviteService>,
): Promise<InviteOutcome> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* InviteService;
      return yield* svc.inviteMember(hasSession, input);
    }).pipe(Effect.provide(layer)),
  );
}

/**
 * Build the Live {@link InviteService} Layer for the running app: the
 * {@link InviteRunner} is {@link apiInviteRunner} (tRPC `invitations.invite`),
 * composed with an injected opener Layer (`opener`, default
 * {@link UrlOpenerLive}). The ONBOARDING path passes {@link UrlOpenerNoop}
 * (via {@link useOnboardingInviteLayer}) so an over-limit invite does not open
 * the browser mid-wizard (TRI-3260).
 *
 * Extracted here (a tiny hook) so WorkspaceSettings + OnboardingFlow share ONE
 * Layer instead of duplicating it. Mirrors `useCheckoutLayer` in ./checkout.ts.
 */
export function useInviteLayer(
  opener: Layer.Layer<UrlOpener> = UrlOpenerLive,
): Layer.Layer<InviteService> {
  return useMemo(
    () =>
      InviteServiceLive.pipe(
        Layer.provide(Layer.succeed(InviteRunner, apiInviteRunner())),
        Layer.provide(opener),
      ),
    [opener],
  );
}

/**
 * The invite Layer for the ONBOARDING wizard (TRI-3260).
 *
 * Same transport as {@link useInviteLayer} (tRPC `invitations.invite`), but
 * composed with the {@link UrlOpenerNoop} opener so an over-seat-limit
 * (`checkout`) invite row does NOT open the system browser or redirect away
 * during onboarding. The caller ({@link OnboardingFlow}'s `submitInvites`)
 * collects and ignores the `checkout` outcome and defers the upgrade to the plan
 * step. `UrlOpenerNoop` is a module constant, so the memo deps are stable.
 */
export function useOnboardingInviteLayer(): Layer.Layer<InviteService> {
  return useInviteLayer(UrlOpenerNoop);
}
