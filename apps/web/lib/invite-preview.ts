/**
 * Invite-preview data loader (TRI-3256) — the data source for the
 * `/invite/<token>` landing page (`app/invite/[token]/page.tsx`).
 *
 * Replaces the page's old raw `getInvitationByToken` HTTP query call: it now runs
 * the PUBLIC `InvitationService.getInvitationByToken` Effect directly in-process
 * against the
 * services runtime (no auth — the token IS the capability). This is the SAME
 * Effect the public tRPC `invitations.getByToken` procedure runs, so calling the
 * service here avoids a needless HTTP hop from the server component back into our
 * own API.
 *
 * Lives under `lib/` (not the route) so it is unit-tested OFFLINE against a
 * `TestLayer` runtime — the web vitest suite only includes `lib/**`.
 */

import {
  type AppServices,
  type InvitationPreview,
  InvitationService,
  appLayer,
} from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";

/** The services runtime the preview Effect runs against (Live or Test). */
type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/**
 * Outcome of the server-side preview:
 *  - `ok`          → we have a definitive preview from the service
 *  - `unavailable` → the service failed (e.g. DB unreachable); degrade gracefully
 */
export type PreviewResult =
  | { kind: "ok"; preview: InvitationPreview }
  | { kind: "unavailable" };

/**
 * Run the PUBLIC `getInvitationByToken` Effect against the given runtime. Any
 * failure (typed service error OR a defect such as an unreachable DB) degrades to
 * `unavailable` so the page's deep-link hand-off still works. The caller owns the
 * runtime lifecycle.
 */
export async function previewWithRuntime(
  runtime: ServicesRuntime,
  token: string,
): Promise<PreviewResult> {
  try {
    const preview = await runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* InvitationService;
        return yield* svc.getInvitationByToken(token);
      }),
    );
    return { kind: "ok", preview };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Load the invitation preview for the landing page: lazily resolve the pooled db
 * handle, build the LIVE `appLayer` (no member identity — `userId: null`), run the
 * preview Effect, and dispose the runtime. The lazy `@gtmgrid/db/client` import
 * means merely importing this module never opens a connection.
 */
export async function loadInvitationPreview(token: string): Promise<PreviewResult> {
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    return await previewWithRuntime(runtime, token);
  } finally {
    await runtime.dispose();
  }
}
