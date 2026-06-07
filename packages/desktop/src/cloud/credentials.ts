/**
 * Shared (workspace-scoped) credential save orchestration (T11) — client-side
 * LOGIC as an Effect service.
 *
 * For CLOUD projects a connector / AI-provider key can be saved at the
 * **workspace** scope: it is shared across all members and is envelope-encrypted
 * server-side by Convex (the T7 `saveCredential` action → T4 store). Plaintext
 * is sent once to the trusted Convex action and is NEVER displayed back; listing
 * (`listCredentials`) returns metadata only.
 *
 * This service owns the save path's guards + the Convex call, exactly mirroring
 * the ./invite.ts pattern so it is unit-testable by providing a FAKE
 * {@link CredentialSaver} Layer (no real Convex, no real network):
 *
 *   1. validate there is a signed-in session (typed error otherwise),
 *   2. validate the key is non-empty (typed error otherwise),
 *   3. delegate the encrypted save to the injected {@link CredentialSaver} (the
 *      Convex `saveCredential` action call).
 *
 * Per the repo convention React components stay plain React; this orchestration
 * is an Effect service with typed errors + Layers. The thin React glue that
 * binds it to component state lives in App.tsx (it builds the Live
 * {@link CredentialSaver} from the Convex `useAction` hook).
 *
 * The LOCAL credential path (personal/team/local machine keys via the sidecar,
 * `api.connect` / `api.connectAiProvider`) is untouched — this is purely the
 * additive cloud path, gated on a signed-in workspace.
 */

import { useAction } from "convex/react";
import { Context, Data, Effect, Layer } from "effect";
import { useMemo } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { apiClient, cloudViaApi } from "./client";

/**
 * The cloud credential scope. Mirrors `credentialScope` in convex/schema.ts:
 * `workspace` keys are shared across members; `personal` keys belong to one
 * member. The engine's local-only "local"/"team" scopes have no cloud
 * equivalent and are intentionally absent.
 */
export type CloudCredentialScope = "workspace" | "personal";

/** A request to save (insert or rotate) a cloud credential for a connector. */
export interface SaveCredentialInput {
  /** The Convex `workspaces._id` the credential belongs to. */
  readonly workspaceId: string;
  /**
   * Stable connector/provider identifier used as the credential key. Extensions
   * use their raw id; AI providers are namespaced (see {@link aiProviderCredId})
   * so they never collide with an extension of the same id.
   */
  readonly extensionId: string;
  /** The scope to save under. */
  readonly scope: CloudCredentialScope;
  /** Human-readable label stored alongside the credential (e.g. the brand name). */
  readonly name: string;
  /**
   * PLAINTEXT secret map (e.g. `{ apiKey: "..." }`). Sent once to the Convex
   * action which encrypts it; never persisted client-side, never displayed back.
   */
  readonly secrets: Record<string, string>;
}

/** Raised when the credential cannot be saved (no session, empty key, backend). */
export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Port: performs the Convex `saveCredential` action (envelope-encrypts +
 * stores). Abstracted behind a tag so the orchestration is testable without a
 * real Convex client. The Live Layer is built in App.tsx from the `useAction`
 * hook (React-bound), so no default Layer lives here.
 */
export interface CredentialSaverShape {
  readonly save: (
    input: SaveCredentialInput,
  ) => Effect.Effect<void, CredentialError>;
}

export class CredentialSaver extends Context.Tag("CredentialSaver")<
  CredentialSaver,
  CredentialSaverShape
>() {}

/**
 * The single tRPC call this saver makes: `credentials.save.mutate`. Abstracted so
 * the saver can be unit-tested with a fake mutate fn (no live client), defaulting
 * to the module `apiClient` in the app. The tRPC mutation returns the saved row
 * id; the saver discards it (its contract is `void`).
 */
export type SaveMutate = (input: {
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly scope: CloudCredentialScope;
  readonly name: string;
  readonly secrets: Record<string, string>;
}) => Promise<unknown>;

/**
 * Build a {@link CredentialSaverShape} backed by the NEW tRPC `credentials.save`
 * mutation (TRI-3255). This is the strangler-fig replacement for the Convex
 * `useAction(api.credentials.saveCredential)`-derived saver the UI built inline:
 * the same port, fed by the vanilla tRPC client instead of Convex, so the
 * session/empty-key guards in {@link CredentialServiceLive} are unchanged.
 * Plaintext is sent once to the trusted procedure (which envelope-encrypts it) and
 * never persisted client-side. Pure (no React) so the call site composes it into
 * the Live Layer directly and tests can inject a fake mutate. A tRPC error is
 * normalized to a typed {@link CredentialError}.
 *
 * `mutate` defaults to the module `apiClient`'s `credentials.save.mutate`
 * (non-null on the `cloudViaApi` path — the only path that builds this saver);
 * tests pass a fake to exercise the call + error mapping without a live client.
 */
export function apiCredentialSaver(
  mutate: SaveMutate = (input) => apiClient!.credentials.save.mutate(input),
): CredentialSaverShape {
  return {
    save: (input: SaveCredentialInput) =>
      Effect.tryPromise({
        try: () =>
          mutate({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            scope: input.scope,
            name: input.name,
            secrets: input.secrets,
          }),
        catch: (cause) =>
          new CredentialError({
            message:
              cause instanceof Error
                ? cause.message
                : "Could not save the key.",
            cause,
          }),
      }).pipe(Effect.asVoid),
  };
}

/** The save orchestration the UI calls. */
export interface CredentialServiceShape {
  /**
   * Save a cloud credential. Fails with {@link CredentialError} when there is no
   * signed-in session, the key is empty, or the backend call fails. On success
   * the key is stored encrypted server-side and shared with the workspace.
   */
  readonly saveCredential: (
    hasSession: boolean,
    input: SaveCredentialInput,
  ) => Effect.Effect<void, CredentialError>;
}

export class CredentialService extends Context.Tag("CredentialService")<
  CredentialService,
  CredentialServiceShape
>() {}

/** True when every secret value is a non-empty (trimmed) string. */
function hasNonEmptySecret(secrets: Record<string, string>): boolean {
  const values = Object.values(secrets);
  return values.length > 0 && values.every((v) => v.trim().length > 0);
}

/**
 * The orchestration: guard on a session + a non-empty key, then delegate to
 * {@link CredentialSaver}. Requiring the port means the same service runs against
 * real Convex (Live) or a fake (tests).
 */
export const CredentialServiceLive: Layer.Layer<
  CredentialService,
  never,
  CredentialSaver
> = Layer.effect(
  CredentialService,
  Effect.gen(function* () {
    const saver = yield* CredentialSaver;
    return {
      saveCredential: (hasSession, input) =>
        !hasSession
          ? Effect.fail(
              new CredentialError({
                message: "Sign in to a workspace to save a shared key.",
              }),
            )
          : !hasNonEmptySecret(input.secrets)
            ? Effect.fail(new CredentialError({ message: "Enter an API key" }))
            : saver.save(input),
    } satisfies CredentialServiceShape;
  }),
);

/**
 * Namespace an AI provider id into a credential key so it never collides with an
 * extension of the same id in the shared workspace `credentials` table.
 */
export function aiProviderCredId(providerId: string): string {
  return `ai:${providerId}`;
}

/**
 * Convenience: run the save orchestration, returning a Promise (so the React
 * glue can `await` it). Accepts the composed Layer so callers/tests choose the
 * transport. There is no module-level Live Layer because the
 * {@link CredentialSaver} is built from a React hook (Convex `useAction`) at the
 * call site. Mirrors `runInvite` in ./invite.ts.
 */
export function runSaveCredential(
  hasSession: boolean,
  input: SaveCredentialInput,
  layer: Layer.Layer<CredentialService>,
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CredentialService;
      return yield* svc.saveCredential(hasSession, input);
    }).pipe(Effect.provide(layer)),
  );
}

/**
 * Build the Live {@link CredentialService} Layer for the running app, STRANGLER-
 * branched on the cloud path (TRI-3255):
 *   - NEW path  → the {@link CredentialSaver} is {@link apiCredentialSaver} (tRPC
 *     `credentials.save`); the Convex `useAction` is NOT called (its provider is
 *     not mounted on this path).
 *   - LEGACY path → the saver wraps the Convex `credentials.saveCredential` action.
 *
 * Extracted here (a tiny hook) so useWorkspaceCredentials + OnboardingFlow share
 * ONE branch instead of duplicating it. `cloudViaApi` is a module constant, so the
 * hook order is stable across renders. Mirrors `useInviteLayer` in ./invite.ts.
 */
export function useCredentialLayer(): Layer.Layer<CredentialService> {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
    return useMemo(
      () =>
        CredentialServiceLive.pipe(
          Layer.provide(
            Layer.succeed(CredentialSaver, apiCredentialSaver()),
          ),
        ),
      [],
    );
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  const saveAction = useAction(api.credentials.saveCredential);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- module-constant branch.
  return useMemo(
    () =>
      CredentialServiceLive.pipe(
        Layer.provide(
          Layer.succeed(CredentialSaver, {
            save: (input: SaveCredentialInput) =>
              Effect.tryPromise({
                try: () =>
                  saveAction({
                    workspaceId: input.workspaceId as Id<"workspaces">,
                    extensionId: input.extensionId,
                    scope: input.scope,
                    name: input.name,
                    secrets: input.secrets,
                  }).then(() => undefined),
                catch: (cause) =>
                  new CredentialError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Could not save the key.",
                    cause,
                  }),
              }),
          }),
        ),
      ),
    [saveAction],
  );
}
