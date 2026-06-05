/**
 * Invite + upgrade orchestration (T10) — client-side LOGIC as an Effect service.
 *
 * Inviting a member is gated on seats (Autumn, T6). The Convex `inviteMember`
 * ACTION returns either `{ status: "added" }` (a seat was free) or
 * `{ status: "checkout", checkoutUrl }` (over the limit — nobody was added, the
 * UI must open the Autumn checkout to upgrade). This service owns that branch:
 *
 *   1. validate there is a signed-in session (typed error otherwise),
 *   2. delegate the invite to the injected {@link InviteRunner} (the Convex
 *      action call), and
 *   3. on the over-limit result, open the checkout URL via the injected
 *      {@link UrlOpener} (the SYSTEM browser) and report `"checkout"` so the UI
 *      can show its upgrade modal.
 *
 * Per the repo convention React components stay plain React; this orchestration
 * is an Effect service with typed errors + Layers so it is unit-tested by
 * providing FAKE `InviteRunner` / `UrlOpener` Layers — no real Convex, no real
 * browser. The thin React glue that binds it to component state lives in
 * WorkspaceSettings.tsx. Mirrors the ./cloud-run.ts pattern.
 */

import { Context, Data, Effect, Layer } from "effect";

/** A workspace member role, mirroring `memberRole` in convex/schema.ts. */
export type MemberRole = "owner" | "admin" | "member";

/** A request to invite (add) a user to a workspace. */
export interface InviteInput {
  /** The Convex `workspaces._id` to add the user to. */
  readonly workspaceId: string;
  /** The invitee's Convex Auth user id (`users._id`). */
  readonly userId: string;
  /** The role to grant. Defaults to `"member"` at the call site. */
  readonly role: MemberRole;
}

/**
 * The Convex `inviteMember` action result, mirrored from convex/workspaces.ts:
 * either the seat was free (`added`) or the workspace is over its limit and the
 * caller must open `checkoutUrl` to upgrade (`checkout`).
 */
export type InviteActionResult =
  | { readonly status: "added"; readonly memberId: string }
  | { readonly status: "checkout"; readonly checkoutUrl: string };

/**
 * The outcome the UI acts on:
 *   - `added`    → the member was added; refresh the roster.
 *   - `checkout` → over the seat limit; the checkout URL has ALREADY been opened
 *      in the system browser, and `checkoutUrl` is returned so the UI can show
 *      its upgrade modal (with a manual "open" fallback link).
 */
export type InviteOutcome =
  | { readonly status: "added"; readonly memberId: string }
  | { readonly status: "checkout"; readonly checkoutUrl: string };

/** Raised when the invite cannot be performed (no session, or a backend error). */
export class InviteError extends Data.TaggedError("InviteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Port: performs the Convex `inviteMember` action. Abstracted behind a tag so
 * the orchestration is testable without a real Convex client. The Live Layer is
 * built in WorkspaceSettings.tsx from the `useAction` hook (React-bound), so no
 * default Layer lives here.
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
   * Invite a user. Fails with {@link InviteError} when there is no signed-in
   * session or the backend call fails. On the over-limit path it opens the
   * checkout URL in the system browser before resolving with `"checkout"`.
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
              Effect.flatMap((result) =>
                result.status === "added"
                  ? Effect.succeed<InviteOutcome>({
                      status: "added",
                      memberId: result.memberId,
                    })
                  : // Over the seat limit: open the checkout in the system
                    // browser, then report `checkout` so the UI shows its modal.
                    opener.open(result.checkoutUrl).pipe(
                      Effect.as<InviteOutcome>({
                        status: "checkout",
                        checkoutUrl: result.checkoutUrl,
                      }),
                    ),
              ),
            ),
    } satisfies InviteServiceShape;
  }),
);

/**
 * A {@link UrlOpener} that opens the URL in the system browser.
 *
 * Tauri's webview has no native window; opening `https://…` must hand the URL to
 * the OS. We use `window.open(url, "_blank")` which, in Tauri's webview, is
 * routed to the system browser. (A future task may swap this for the Tauri
 * opener plugin; the port keeps that change isolated to this Layer.) Guards
 * against a non-browser context (e.g. the Node test runner) so a missing
 * `window` surfaces as a typed error rather than a crash.
 */
export const UrlOpenerLive: Layer.Layer<UrlOpener> = Layer.succeed(UrlOpener, {
  open: (url) =>
    Effect.try({
      try: () => {
        const w = (globalThis as { window?: { open?: (u: string, t?: string) => unknown } })
          .window;
        if (w?.open === undefined) {
          throw new Error("No system browser available to open the checkout URL.");
        }
        w.open(url, "_blank");
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
