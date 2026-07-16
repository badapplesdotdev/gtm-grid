/**
 * Share-preview data loader — the data source for the `/share/<token>` page
 * (`app/share/[token]/page.tsx`).
 *
 * Mirrors `invite-preview.ts`: runs the PUBLIC `ShareService.getShareByToken`
 * Effect directly in-process against the services runtime (no auth — the token
 * IS the capability), the SAME Effect the public tRPC `share.getByToken`
 * procedure runs, so the server component avoids a needless HTTP hop back into
 * our own API.
 *
 * Lives under `lib/` (not the route) so it can be unit-tested OFFLINE against a
 * `TestLayer` runtime.
 */

import {
  type AppServices,
  appLayer,
  type SharePreview,
  ShareService,
} from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";

/** The services runtime the preview Effect runs against (Live or Test). */
type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/**
 * Outcome of the server-side preview:
 *  - `ok`          → a definitive preview from the service (valid or not).
 *  - `unavailable` → the service failed (e.g. DB unreachable); degrade gracefully.
 */
export type SharePreviewResult =
  | { kind: "ok"; preview: SharePreview }
  | { kind: "unavailable" };

/**
 * Run the PUBLIC `getShareByToken` Effect against the given runtime. Any failure
 * (typed error OR a defect such as an unreachable DB) degrades to `unavailable`.
 * The caller owns the runtime lifecycle.
 */
export async function previewWithRuntime(
  runtime: ServicesRuntime,
  token: string,
): Promise<SharePreviewResult> {
  try {
    const preview = await runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* ShareService;
        return yield* svc.getShareByToken(token);
      }),
    );
    return { kind: "ok", preview };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Load the share preview for the landing page: lazily resolve the pooled db
 * handle, build the LIVE `appLayer` (no member identity — `userId: null`), run
 * the preview Effect, and dispose the runtime.
 */
export async function loadSharePreview(
  token: string,
): Promise<SharePreviewResult> {
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    return await previewWithRuntime(runtime, token);
  } finally {
    await runtime.dispose();
  }
}
