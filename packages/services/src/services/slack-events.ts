/**
 * `slack-events` — the PURE logic behind the Slack Events API receiver
 * (`apps/web/app/api/webhooks/slack/[token]/route.ts`).
 *
 * ## Why this is a SIBLING of the existing receiver, not a reuse of it
 *
 * `app/api/webhooks/[token]` authenticates with OUR scheme:
 * `hex(HMAC-SHA256(signingSecret, rawBody))` in `X-GTMGrid-Signature`, opt-in per
 * webhook. Slack cannot be told to do that — it signs every request with its own
 * v0 scheme, keyed by the SLACK APP's signing secret (one per app, not per
 * webhook), over a basestring that includes a timestamp. So the auth gate is
 * genuinely different and gets its own route.
 *
 * Everything AFTER the gate is deliberately identical: this module normalises a
 * Slack message event into a plain record, the route applies the webhook's stored
 * field mapping to it and enqueues the SAME `webhook/record.received` Inngest
 * event. `process-webhook-record.ts` is reused byte-for-byte — Slack is just
 * another way to reach it.
 *
 * ## The Slack v0 scheme (docs.slack.dev/authentication/verifying-requests-from-slack)
 *
 *   basestring = `v0:{X-Slack-Request-Timestamp}:{raw body}`
 *   signature  = "v0=" + hex(HMAC-SHA256(SLACK_SIGNING_SECRET, basestring))
 *
 * Two properties of that are load-bearing and easy to get wrong:
 *
 *  1. The MAC covers the RAW BYTES. `JSON.parse` → `JSON.stringify` is not a
 *     round-trip (key order, whitespace, number formatting, unicode escapes all
 *     drift), so re-serialising the body before verifying makes EVERY signature
 *     fail. {@link verifySlackRequest} therefore takes the raw string and never
 *     parses it; the route must read `req.text()` before it parses.
 *  2. The timestamp is INSIDE the MAC, so an attacker can't retime a captured
 *     request — but they can REPLAY it verbatim forever. The freshness window is
 *     what makes the signature non-eternal, which is why an expired timestamp is
 *     rejected even when the signature is perfectly valid.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Data, Effect } from "effect";

/**
 * How far a request's timestamp may be from local time. Slack's own guidance is
 * five minutes, applied in BOTH directions: a far-future timestamp is as
 * suspicious as a stale one (it is the shape a captured-then-retimed request
 * would take if the MAC ever leaked), and no honest sender is five minutes ahead.
 */
export const SLACK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** The env var holding the Slack app's signing secret (Basic Information → App Credentials). */
export const SLACK_SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * `SLACK_SIGNING_SECRET` is unset. Fails CLOSED: with no secret there is nothing
 * to verify against, and accepting unverified posts would make the endpoint an
 * open row-injection API for anyone who learns the token.
 */
export class SlackSigningSecretNotConfigured extends Data.TaggedError(
  "SlackSigningSecretNotConfigured",
)<{ readonly env: string }> {}

/** The `X-Slack-Signature` header is missing, malformed, or does not verify. */
export class SlackSignatureInvalid extends Data.TaggedError("SlackSignatureInvalid")<{
  readonly reason: "missing" | "malformed" | "mismatch";
}> {}

/**
 * The `X-Slack-Request-Timestamp` header is missing, non-numeric, or outside
 * {@link SLACK_TIMESTAMP_WINDOW_MS} — the replay gate.
 */
export class SlackTimestampInvalid extends Data.TaggedError("SlackTimestampInvalid")<{
  readonly reason: "missing" | "malformed" | "expired";
  readonly skewMs?: number;
}> {}

/**
 * The body could not be classified. `reason` names WHICH check failed.
 *
 * One reason per distinct failure, deliberately — the route collapses every one
 * of these to the same opaque 401 (a prober must not learn which check it
 * tripped), so logs and tests are the field's ONLY consumers. A reason shared by
 * two failures is therefore not a small inaccuracy; it is the entire value of the
 * field, gone. Three of these used to read "no-type" or "not-an-object" for
 * failures where the type was present and valid.
 *
 * The `event`-prefixed reasons are about the NESTED envelope, not the body:
 * "no-type" is a body with no discriminator, "no-event-type" is an
 * `event_callback` whose inner event has none. Same for
 * "not-an-object"/"no-event".
 */
export class SlackBodyMalformed extends Data.TaggedError("SlackBodyMalformed")<{
  readonly reason:
    /** Not JSON at all. */
    | "unparseable"
    /** JSON, but not an object (an array, a bare string, null). */
    | "not-an-object"
    /** An object with no `type` discriminator. */
    | "no-type"
    /** A `url_verification` handshake carrying no `challenge` to echo. */
    | "no-challenge"
    /** An `event_callback` whose `event` is missing or not an object. */
    | "no-event"
    /** An `event_callback` whose inner `event` carries no `type`. */
    | "no-event-type"
    /** A message we would otherwise accept, with no `event_id` to de-dupe on. */
    | "no-event-id";
}> {}

/**
 * Every way the verify-then-classify pipeline can fail. The route collapses the
 * whole union to a single 401 (see `slackEventsCore` docs) — this type exists so
 * the reason is available for logging, never for the response body.
 */
export type SlackRequestError =
  | SlackSigningSecretNotConfigured
  | SlackSignatureInvalid
  | SlackTimestampInvalid
  | SlackBodyMalformed;

// ── Request model ────────────────────────────────────────────────────────────

/** The headers the v0 scheme reads. Modelled as data so verification is pure. */
export interface SlackRequestHeaders {
  readonly signature: string | null;
  readonly timestamp: string | null;
}

/** A normalised Slack message, flattened out of the `event_callback` envelope. */
export interface SlackMessageRecord {
  readonly text: string;
  readonly user: string | null;
  readonly channel: string | null;
  readonly channelType: string | null;
  readonly ts: string | null;
  readonly threadTs: string | null;
  readonly team: string | null;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventTimeMs: number | null;
}

/**
 * A verified Slack request, classified by what the receiver must DO with it.
 *
 *  - `url_verification` — the one-time handshake Slack posts when you save the
 *    Request URL in the app config. Must echo `challenge` back or the URL cannot
 *    be saved at all.
 *  - `message` — a real message event; becomes a grid row.
 *  - `ignored` — verified and well-formed, but nothing to do (a non-message
 *    event, or a message we must not act on — see {@link classifySlackBody}).
 *    The route ACKs these 200 without enqueuing anything.
 */
export type SlackRequest =
  | { readonly kind: "url_verification"; readonly challenge: string }
  | { readonly kind: "message"; readonly record: SlackMessageRecord }
  | { readonly kind: "ignored"; readonly reason: string };

// ── Total narrowing helpers ──────────────────────────────────────────────────
// `JSON.parse` yields `unknown`. Rather than `as`-casting a shape we merely hope
// for, every field is read through a total function: wrong type → absent. A Slack
// payload change can then only ever produce a MISSING field, never a `number`
// masquerading as a `string` several layers downstream.

const readString = (source: unknown, key: string): string | null => {
  if (typeof source !== "object" || source === null) return null;
  const value = Reflect.get(source, key);
  return typeof value === "string" ? value : null;
};

const readNumber = (source: unknown, key: string): number | null => {
  if (typeof source !== "object" || source === null) return null;
  const value = Reflect.get(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const readObject = (source: unknown, key: string): unknown => {
  if (typeof source !== "object" || source === null) return null;
  const value = Reflect.get(source, key);
  return typeof value === "object" && value !== null ? value : null;
};

// ── Signature verification ───────────────────────────────────────────────────

/** The exact basestring the v0 MAC is computed over. Exported for tests/debugging. */
export const slackBasestring = (timestamp: string, rawBody: string): string =>
  `v0:${timestamp}:${rawBody}`;

/**
 * Compute the expected `v0=…` signature for a raw body + timestamp.
 *
 * NOTE for tests: a test that builds its fixture by calling THIS function proves
 * only that the code agrees with itself — a broken HMAC would still pass. The
 * suite computes the expected signature independently with `node:crypto`.
 */
export const slackSignature = (
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): string =>
  `v0=${createHmac("sha256", signingSecret).update(slackBasestring(timestamp, rawBody)).digest("hex")}`;

/**
 * Constant-time compare of two signatures.
 *
 * The length check is NOT an optimisation — `timingSafeEqual` THROWS a
 * RangeError on differing lengths, so a short/garbage header would escape as an
 * exception (a 500, and a thrown error out of service code) instead of a clean
 * rejection. Length is not secret; content is.
 */
const signaturesMatch = (expected: string, actual: string): boolean => {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * The replay gate. Rejects a timestamp that is missing, non-numeric, or further
 * than {@link SLACK_TIMESTAMP_WINDOW_MS} from `nowMs` in either direction.
 *
 * Slack sends UNIX SECONDS; `nowMs` is millis. Mixing those up silently rejects
 * everything (a seconds value looks ~55 years stale in millis), so the
 * conversion happens exactly here.
 */
export const checkSlackTimestamp = (
  timestamp: string | null,
  nowMs: number,
): Effect.Effect<number, SlackTimestampInvalid> =>
  Effect.suspend(() => {
    if (timestamp === null || timestamp === "") {
      return Effect.fail(new SlackTimestampInvalid({ reason: "missing" }));
    }
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) {
      return Effect.fail(new SlackTimestampInvalid({ reason: "malformed" }));
    }
    const skewMs = Math.abs(nowMs - seconds * 1000);
    if (skewMs > SLACK_TIMESTAMP_WINDOW_MS) {
      return Effect.fail(new SlackTimestampInvalid({ reason: "expired", skewMs }));
    }
    return Effect.succeed(seconds);
  });

/** Read the Slack app signing secret from the environment, failing closed when unset. */
export const resolveSlackSigningSecret = (): Effect.Effect<
  string,
  SlackSigningSecretNotConfigured
> =>
  Effect.suspend(() => {
    // Read at CALL time, never hoisted: tests stub env per-case, and a serverless
    // instance may be constructed before its env is populated.
    const secret = process.env[SLACK_SIGNING_SECRET_ENV] ?? "";
    return secret === ""
      ? Effect.fail(new SlackSigningSecretNotConfigured({ env: SLACK_SIGNING_SECRET_ENV }))
      : Effect.succeed(secret);
  });

/**
 * Verify one Slack request: freshness first, then the v0 MAC over the RAW body.
 *
 * Freshness is checked BEFORE the HMAC purely as work-shedding — a flood of
 * stale replays is rejected without hashing their bodies. It is not a security
 * ordering: the timestamp is inside the MAC, so neither check is meaningful
 * without the other, and both must pass.
 */
export const verifySlackRequest = (input: {
  readonly rawBody: string;
  readonly headers: SlackRequestHeaders;
  readonly signingSecret: string;
  readonly nowMs: number;
}): Effect.Effect<void, SlackSignatureInvalid | SlackTimestampInvalid> =>
  Effect.gen(function* () {
    const timestamp = input.headers.timestamp;
    yield* checkSlackTimestamp(timestamp, input.nowMs);
    // `checkSlackTimestamp` already rejected null/empty; re-narrow for the types
    // rather than asserting non-null.
    if (timestamp === null || timestamp === "") {
      return yield* Effect.fail(new SlackTimestampInvalid({ reason: "missing" }));
    }

    const provided = input.headers.signature;
    if (provided === null || provided === "") {
      return yield* Effect.fail(new SlackSignatureInvalid({ reason: "missing" }));
    }
    if (!provided.startsWith("v0=")) {
      return yield* Effect.fail(new SlackSignatureInvalid({ reason: "malformed" }));
    }

    const expected = slackSignature(input.signingSecret, timestamp, input.rawBody);
    if (!signaturesMatch(expected, provided)) {
      return yield* Effect.fail(new SlackSignatureInvalid({ reason: "mismatch" }));
    }
  });

// ── Body classification ──────────────────────────────────────────────────────

/**
 * Which message events are DROPPED rather than turned into rows.
 *
 * `bot_id` / `subtype: "bot_message"`: the loop bound. A grid column can post
 * back into Slack; if our own bot's messages created rows, that row could enrich,
 * post, and create another row — unbounded. Dropping every bot-authored message
 * cuts the cycle at the source. It also drops OTHER bots' messages, which is the
 * conservative direction (a missing row beats an infinite loop) and can be
 * relaxed to an allowlist later.
 *
 * Other subtypes (`message_changed`, `message_deleted`, `channel_join`, …) carry
 * no new user message; a row per channel-join would be noise.
 */
const droppedMessageReason = (event: unknown): string | null => {
  if (readString(event, "bot_id") !== null) return "bot-message";
  const subtype = readString(event, "subtype");
  if (subtype === null) return null;
  if (subtype === "bot_message") return "bot-message";
  return `subtype:${subtype}`;
};

/**
 * Classify an ALREADY-VERIFIED, parsed body into what the receiver should do.
 *
 * Order matters: `url_verification` is handled before anything else because it is
 * the only request Slack sends BEFORE the endpoint is live, and it carries no
 * event envelope at all.
 */
export const classifySlackBody = (body: unknown): Effect.Effect<SlackRequest, SlackBodyMalformed> =>
  Effect.suspend(() => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Effect.fail(new SlackBodyMalformed({ reason: "not-an-object" }));
    }

    const type = readString(body, "type");
    if (type === null) {
      return Effect.fail(new SlackBodyMalformed({ reason: "no-type" }));
    }

    if (type === "url_verification") {
      const challenge = readString(body, "challenge");
      // A handshake with no (or a non-string) challenge is unanswerable. NOT
      // "no-type": `type` was present and read exactly "url_verification".
      return challenge === null
        ? Effect.fail(new SlackBodyMalformed({ reason: "no-challenge" }))
        : Effect.succeed<SlackRequest>({ kind: "url_verification", challenge });
    }

    if (type !== "event_callback") {
      return Effect.succeed<SlackRequest>({ kind: "ignored", reason: `type:${type}` });
    }

    const event = readObject(body, "event");
    if (event === null) {
      // The BODY is a fine object; its nested `event` is the problem. Sharing
      // "not-an-object" with the body check sent readers to the wrong field.
      return Effect.fail(new SlackBodyMalformed({ reason: "no-event" }));
    }

    const eventType = readString(event, "type");
    if (eventType === null) {
      // The body's `type` said "event_callback"; the INNER event has none.
      return Effect.fail(new SlackBodyMalformed({ reason: "no-event-type" }));
    }
    if (eventType !== "message" && eventType !== "app_mention") {
      return Effect.succeed<SlackRequest>({ kind: "ignored", reason: `event:${eventType}` });
    }

    const dropped = droppedMessageReason(event);
    if (dropped !== null) {
      return Effect.succeed<SlackRequest>({ kind: "ignored", reason: dropped });
    }

    // `event_id` is the envelope-level idempotency key and is what makes Slack's
    // retries (same event_id, new signature/timestamp) collapse downstream. An
    // envelope without one cannot be de-duped, so it is malformed rather than
    // silently double-inserted.
    const eventId = readString(body, "event_id");
    if (eventId === null) {
      return Effect.fail(new SlackBodyMalformed({ reason: "no-event-id" }));
    }

    const eventTimeSeconds = readNumber(body, "event_time");
    const record: SlackMessageRecord = {
      text: readString(event, "text") ?? "",
      user: readString(event, "user"),
      channel: readString(event, "channel"),
      channelType: readString(event, "channel_type"),
      ts: readString(event, "ts"),
      threadTs: readString(event, "thread_ts"),
      team: readString(event, "team") ?? readString(body, "team_id"),
      eventId,
      eventType,
      eventTimeMs: eventTimeSeconds === null ? null : eventTimeSeconds * 1000,
    };
    return Effect.succeed<SlackRequest>({ kind: "message", record });
  });

/**
 * Parse the raw body, then classify it.
 *
 * Split from {@link classifySlackBody} so the route can hand over the raw string
 * it already had to read for the MAC — there is exactly ONE `JSON.parse` of a
 * Slack request in the system, and it happens strictly after verification.
 */
export const parseSlackBody = (rawBody: string): Effect.Effect<SlackRequest, SlackBodyMalformed> =>
  Effect.suspend(() =>
    Effect.try({
      try: (): unknown => JSON.parse(rawBody),
      catch: () => new SlackBodyMalformed({ reason: "unparseable" }),
    }),
  ).pipe(Effect.flatMap(classifySlackBody));

/**
 * Verify + parse + classify, in the only correct order. This is the whole gate:
 * the route reads the raw body, calls this, and switches on the result.
 */
export const readSlackRequest = (input: {
  readonly rawBody: string;
  readonly headers: SlackRequestHeaders;
  readonly signingSecret: string;
  readonly nowMs: number;
}): Effect.Effect<SlackRequest, SlackRequestError> =>
  verifySlackRequest(input).pipe(Effect.flatMap(() => parseSlackBody(input.rawBody)));

// ── Downstream mapping ───────────────────────────────────────────────────────

/**
 * Flatten a {@link SlackMessageRecord} to the plain JSON object the stored field
 * mapping is applied to.
 *
 * The mapping's `path`s address THIS shape (`text`, `user`, `channel`, `ts`),
 * not Slack's nested envelope (`event.text`) — the envelope is Slack's business,
 * and a user configuring a column mapping should not have to know it. The `$`
 * mapping entry stores this same object wholesale.
 */
export const slackRecordPayload = (record: SlackMessageRecord): Record<string, unknown> => ({
  text: record.text,
  user: record.user,
  channel: record.channel,
  channelType: record.channelType,
  ts: record.ts,
  threadTs: record.threadTs,
  team: record.team,
  eventId: record.eventId,
  eventType: record.eventType,
  eventTimeMs: record.eventTimeMs,
});

/**
 * The idempotency key for a Slack message: `sha256(token + ':' + event_id)`.
 *
 * Slack's own retries reuse `event_id` (with a fresh timestamp + signature, so
 * body-hashing would NOT collapse them — the existing receiver's
 * `sha256(token + stableStringify(body))` would mint a new id per retry and
 * double-insert). This is fed to Inngest as the event `id`, which is what makes
 * a retried delivery a no-op. The token is mixed in so the same Slack event
 * routed to two different webhooks stays two distinct records.
 */
export const slackRecordId = (token: string, eventId: string): string =>
  createHash("sha256").update(`${token}:${eventId}`).digest("hex");
