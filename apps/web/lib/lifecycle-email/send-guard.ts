/**
 * The single gate every LIFECYCLE email (#8–#20) passes through before Resend.
 *
 * Guard order (all inside one call so no trigger can skip a rule):
 *   1. Kill-switch — `LIFECYCLE_EMAILS_ENABLED` must be "1"/"true"; anything
 *      else logs a DRY-RUN line and sends nothing (the safe first-deploy mode).
 *   2. Recipient + preference — the user must exist and not have opted the
 *      category out (`users.email_prefs`). `transactional` bypasses prefs but
 *      still dedupes.
 *   3. Idempotency — claim (user, template, dedupeKey) in `lifecycle_email_sends`
 *      via ON CONFLICT DO NOTHING. Lost claim = already sent = skip. The claim
 *      is released on a FAILED send so Inngest retries can claim again
 *      (at-most-once delivery).
 *   4. Compliance chrome — non-transactional sends get the footer unsubscribe
 *      link + `List-Unsubscribe(-Post)` headers; if the unsubscribe secret is
 *      missing those sends are REFUSED (never send marketing-ish mail without a
 *      working opt-out).
 *   5. Telemetry — a `lifecycle_email_sent` PostHog event per delivered email
 *      (workspace-grouped) so email → reactivation funnels are measurable.
 *
 * Callers hand a BUILDER, not a rendered email, so the guard can inject the
 * per-user unsubscribe link into the template's footer.
 *
 * TESTABILITY: the rule engine is {@link runLifecycleSend}, a plain async
 * function over injected collaborators ({@link SendGuardDeps}) — the offline
 * suite drives every condition with fakes and no Effect/DB.
 * {@link sendLifecycleEmail} is the thin production wiring (ManagedRuntime over
 * `appLayer`, Resend, PostHog, env) the Inngest functions call.
 */

import { sendEmail, emailEnabled, type OutboundEmail } from "@gtmgrid/email";
import {
  appLayer,
  LifecycleEmailRepo,
  type LifecycleCategory,
  type LifecycleRecipient,
  type LifecycleSendClaim,
} from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import { captureServer } from "../posthog-server";
import { unsubscribeUrl } from "./unsubscribe-token";

/** Links the guard passes into the template builder (EmailShell footer). */
export interface GuardLinks {
  readonly unsubscribeUrl?: string;
  readonly settingsUrl: string;
}

export interface LifecycleSendRequest {
  /** Better Auth user id of the recipient (also the PostHog distinct id). */
  readonly userId: string;
  /** Workspace context (group analytics + send log), when applicable. */
  readonly workspaceId?: string;
  /** Template slug, e.g. "run-finished" — also the PostHog property. */
  readonly template: string;
  /** Idempotency key within (user, template): a window ("2026-W27") or entity id. */
  readonly dedupeKey: string;
  /** Preference category; `transactional` skips the opt-out check. */
  readonly category: LifecycleCategory | "transactional";
  /** Renders the email for the resolved recipient. */
  readonly build: (args: {
    readonly to: string;
    readonly firstName: string | null;
    readonly links: GuardLinks;
  }) => Promise<OutboundEmail>;
}

export type LifecycleSendResult =
  | { readonly sent: true }
  | { readonly sent: false; readonly skipped: string };

/** The collaborators {@link runLifecycleSend} rules over (prod + test wiring). */
export interface SendGuardDeps {
  /** Resend configured (`AUTH_RESEND_KEY`)? */
  readonly emailConfigured: boolean;
  /** `LIFECYCLE_EMAILS_ENABLED` resolved; false = dry-run. */
  readonly lifecycleEnabled: boolean;
  /** Absolute web origin for the settings footer link. */
  readonly siteOrigin: string;
  readonly getRecipient: (userId: string) => Promise<LifecycleRecipient | null>;
  /** True = this call claimed the (user, template, dedupeKey) slot. */
  readonly recordSendOnce: (claim: LifecycleSendClaim) => Promise<boolean>;
  readonly releaseSend: (
    claim: Pick<LifecycleSendClaim, "userId" | "template" | "dedupeKey">,
  ) => Promise<void>;
  /** Per-user signed unsubscribe URL, or null when no signing secret is set. */
  readonly mintUnsubscribeUrl: (
    userId: string,
    category: LifecycleCategory,
  ) => string | null;
  readonly deliver: (email: OutboundEmail) => Promise<void>;
  /** `lifecycle_email_sent` telemetry sink. */
  readonly capture: (args: {
    readonly distinctId: string;
    readonly template: string;
    readonly category: LifecycleSendRequest["category"];
    readonly workspaceId?: string;
  }) => void;
  /** Dry-run log sink (overridable in tests). */
  readonly log?: (line: string) => void;
}

/** The rule engine — every sending condition lives here and ONLY here. */
export async function runLifecycleSend(
  req: LifecycleSendRequest,
  deps: SendGuardDeps,
): Promise<LifecycleSendResult> {
  if (!deps.emailConfigured) return { sent: false, skipped: "email disabled" };
  if (!deps.lifecycleEnabled) {
    (deps.log ?? console.log)(
      `[lifecycle-email] DRY RUN (LIFECYCLE_EMAILS_ENABLED unset) — would send "${req.template}" (${req.dedupeKey}) to user ${req.userId}`,
    );
    return { sent: false, skipped: "dry-run" };
  }

  const recipient = await deps.getRecipient(req.userId);
  if (!recipient) return { sent: false, skipped: "no such user" };
  if (
    req.category !== "transactional" &&
    recipient.emailPrefs[req.category] === false
  ) {
    return { sent: false, skipped: `opted out of ${req.category}` };
  }

  // Compliance chrome before claiming, so a refusal never burns the claim.
  let links: GuardLinks = {
    settingsUrl: `${deps.siteOrigin}/account/notifications`,
  };
  let headers: Record<string, string> | undefined;
  if (req.category !== "transactional") {
    const unsub = deps.mintUnsubscribeUrl(req.userId, req.category);
    if (!unsub) {
      return { sent: false, skipped: "no unsubscribe secret configured" };
    }
    links = { ...links, unsubscribeUrl: unsub };
    headers = {
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  const claimed = await deps.recordSendOnce({
    userId: req.userId,
    workspaceId: req.workspaceId ?? null,
    template: req.template,
    dedupeKey: req.dedupeKey,
  });
  if (!claimed) return { sent: false, skipped: "already sent" };

  try {
    const firstName = recipient.name?.trim().split(/\s+/)[0] ?? null;
    const email = await req.build({ to: recipient.email, firstName, links });
    await deps.deliver(headers ? { ...email, headers } : email);
  } catch (err) {
    // Release the claim so the Inngest retry can send.
    await deps.releaseSend({
      userId: req.userId,
      template: req.template,
      dedupeKey: req.dedupeKey,
    });
    throw err;
  }

  deps.capture({
    distinctId: req.userId,
    template: req.template,
    category: req.category,
    workspaceId: req.workspaceId,
  });
  return { sent: true };
}

function lifecycleEmailsEnabled(): boolean {
  const v = process.env.LIFECYCLE_EMAILS_ENABLED;
  return v === "1" || v === "true";
}

/** Production wiring: repo via ManagedRuntime/appLayer, Resend, PostHog, env. */
export async function sendLifecycleEmail(
  req: LifecycleSendRequest,
): Promise<LifecycleSendResult> {
  // Short-circuit the gates that need no DB before building the runtime, so a
  // dry-run/no-email deploy never even opens a connection. runLifecycleSend
  // re-checks both (it owns the rules); this is purely an ordering optimisation.
  if (!emailEnabled()) return { sent: false, skipped: "email disabled" };
  if (!lifecycleEmailsEnabled()) {
    console.log(
      `[lifecycle-email] DRY RUN (LIFECYCLE_EMAILS_ENABLED unset) — would send "${req.template}" (${req.dedupeKey}) to user ${req.userId}`,
    );
    return { sent: false, skipped: "dry-run" };
  }
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    const repo = await runtime.runPromise(
      Effect.map(LifecycleEmailRepo, (r) => r),
    );
    return await runLifecycleSend(req, {
      emailConfigured: emailEnabled(),
      lifecycleEnabled: lifecycleEmailsEnabled(),
      siteOrigin: process.env.SITE_URL ?? "https://www.gtmgrid.dev",
      getRecipient: (userId) => runtime.runPromise(repo.getRecipient(userId)),
      recordSendOnce: (claim) => runtime.runPromise(repo.recordSendOnce(claim)),
      releaseSend: (claim) => runtime.runPromise(repo.releaseSend(claim)),
      mintUnsubscribeUrl: unsubscribeUrl,
      deliver: sendEmail,
      capture: ({ distinctId, template, category, workspaceId }) =>
        captureServer("lifecycle_email_sent", {
          distinctId,
          properties: { template, category, workspace_id: workspaceId },
          groups: workspaceId ? { workspace: workspaceId } : undefined,
        }),
    });
  } finally {
    await runtime.dispose();
  }
}
