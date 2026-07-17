/**
 * slack-events: request verification for the Slack Events receiver.
 *
 * Every expected signature here is computed INDEPENDENTLY with `node:crypto`
 * from Slack's documented recipe, never by calling the implementation under
 * test. A round-trip built from `slackSignature()` would agree with itself even
 * if the basestring were wrong in exactly the way that makes every real Slack
 * request fail — the failure mode this file exists to prevent.
 *
 * The security-relevant cases (tamper, replay, wrong-length mac) are the point;
 * the happy path is nearly incidental.
 */

import { createHmac } from "node:crypto";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSlackTimestamp,
  classifySlackBody,
  parseSlackBody,
  resolveSlackSigningSecret,
  slackBasestring,
  SLACK_TIMESTAMP_WINDOW_MS,
  verifySlackRequest,
} from "./slack-events.js";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = new Date("2026-07-04T10:00:00Z").getTime();
const TS = String(Math.floor(NOW / 1000));

/** Slack's documented recipe, written out by hand — NOT via the impl. */
const sign = (timestamp: string, rawBody: string, secret = SECRET): string =>
  `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "none";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : "unknown";
};

const verify = (over: Partial<{ rawBody: string; signature: string | null; timestamp: string | null; nowMs: number }> = {}) => {
  const rawBody = over.rawBody ?? '{"type":"event_callback"}';
  return Effect.runPromiseExit(
    verifySlackRequest({
      rawBody,
      headers: {
        signature: over.signature !== undefined ? over.signature : sign(TS, rawBody),
        timestamp: over.timestamp !== undefined ? over.timestamp : TS,
      },
      signingSecret: SECRET,
      nowMs: over.nowMs ?? NOW,
    }),
  );
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("basestring", () => {
  it("is exactly v0:{timestamp}:{raw body}", () => {
    // Pinned literally: this is the one string Slack and we must agree on.
    expect(slackBasestring("1531420618", '{"a":1}')).toBe('v0:1531420618:{"a":1}');
  });
});

describe("verifySlackRequest", () => {
  it("accepts a correctly signed, in-window request", async () => {
    expect(Exit.isSuccess(await verify())).toBe(true);
  });

  it("REJECTS a tampered body whose signature was valid for the original", async () => {
    const signature = sign(TS, '{"type":"event_callback"}');
    const exit = await verify({ rawBody: '{"type":"event_callback","evil":true}', signature });
    expect(failureTag(exit)).toBe("SlackSignatureInvalid");
  });

  it("REJECTS a signature computed with the wrong secret", async () => {
    const exit = await verify({ signature: sign(TS, '{"type":"event_callback"}', "not-the-secret") });
    expect(failureTag(exit)).toBe("SlackSignatureInvalid");
  });

  it("REJECTS a wrong-LENGTH signature without throwing (timingSafeEqual throws on length mismatch)", async () => {
    // The classic crash here: comparing buffers of different lengths raises out
    // of timingSafeEqual, turning a 401 into a 500 an attacker can trigger.
    const exit = await verify({ signature: "v0=deadbeef" });
    expect(failureTag(exit)).toBe("SlackSignatureInvalid");
  });

  it("REJECTS a missing signature header", async () => {
    expect(failureTag(await verify({ signature: null }))).toBe("SlackSignatureInvalid");
  });

  it("REJECTS a replay outside the 5-minute window EVEN WITH a valid signature", async () => {
    // The signature stays valid forever, so the timestamp window is the only
    // thing standing between us and a replayed request.
    const oldTs = String(Math.floor((NOW - 6 * 60_000) / 1000));
    const rawBody = '{"type":"event_callback"}';
    const exit = await Effect.runPromiseExit(
      verifySlackRequest({
        rawBody,
        headers: { signature: sign(oldTs, rawBody), timestamp: oldTs },
        signingSecret: SECRET,
        nowMs: NOW,
      }),
    );
    expect(failureTag(exit)).toBe("SlackTimestampInvalid");
  });

  it("REJECTS a missing or non-numeric timestamp", async () => {
    expect(failureTag(await verify({ timestamp: null }))).toBe("SlackTimestampInvalid");
    expect(failureTag(await verify({ timestamp: "not-a-number" }))).toBe("SlackTimestampInvalid");
  });
});

describe("checkSlackTimestamp", () => {
  it("accepts the edge of the window and rejects just beyond it", async () => {
    const inside = String(Math.floor((NOW - (SLACK_TIMESTAMP_WINDOW_MS - 1000)) / 1000));
    const outside = String(Math.floor((NOW - (SLACK_TIMESTAMP_WINDOW_MS + 60_000)) / 1000));
    expect(Exit.isSuccess(await Effect.runPromiseExit(checkSlackTimestamp(inside, NOW)))).toBe(true);
    expect(failureTag(await Effect.runPromiseExit(checkSlackTimestamp(outside, NOW)))).toBe("SlackTimestampInvalid");
  });

  it("rejects a FUTURE timestamp beyond the window (clock skew is bounded both ways)", async () => {
    const future = String(Math.floor((NOW + SLACK_TIMESTAMP_WINDOW_MS + 60_000) / 1000));
    expect(failureTag(await Effect.runPromiseExit(checkSlackTimestamp(future, NOW)))).toBe("SlackTimestampInvalid");
  });
});

describe("SlackBodyMalformed.reason names WHICH check failed", () => {
  /**
   * One row per distinct failure. The route collapses every one of these to the
   * same opaque 401, so logs and tests are the reason field's ONLY consumers —
   * a reason shared by two failures is the whole value of the field, gone.
   *
   * Asserted as a TABLE rather than case by case so the bijection is the thing
   * under test: two rows sharing a reason is exactly the bug, and a new failure
   * added without a row shows up as a missing entry rather than passing quietly.
   * The suite previously only asserted the _tag, which is identical for all
   * seven — so three of them collided for months without a red test.
   */
  const CASES: ReadonlyArray<readonly [string, unknown, string]> = [
    ["not JSON at all", "{not json", "unparseable"],
    ["JSON, but a bare string", '"nope"', "not-an-object"],
    ["JSON, but an array", "[]", "not-an-object"],
    ["an object with no type", '{"challenge":"x"}', "no-type"],
    // type WAS present and valid here — this used to report "no-type".
    ["url_verification with no challenge", '{"type":"url_verification"}', "no-challenge"],
    // the BODY is a fine object; the nested event is the problem.
    ["event_callback with no event", '{"type":"event_callback","event_id":"E1"}', "no-event"],
    [
      "event_callback whose event is not an object",
      '{"type":"event_callback","event_id":"E1","event":"nope"}',
      "no-event",
    ],
    // the body's type said event_callback; the INNER event has none.
    [
      "event_callback whose event has no type",
      '{"type":"event_callback","event_id":"E1","event":{"text":"hi"}}',
      "no-event-type",
    ],
    [
      "a message with no event_id",
      '{"type":"event_callback","event":{"type":"message","text":"hi","ts":"1.2"}}',
      "no-event-id",
    ],
  ];

  it.each(CASES)("%s → %s", async (_name, raw, expected) => {
    const exit = await Effect.runPromiseExit(parseSlackBody(String(raw)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) ? Reflect.get(failure.value, "reason") : null).toBe(expected);
    }
  });

  it("distinguishes the three failures that used to collapse into one", () => {
    // The rows above already pin each reason, so this asserts the PROPERTY the
    // rows exist for: the checks that share a shape must not share a reason.
    // `no-type` vs `no-event-type` and `not-an-object` vs `no-event` are the body
    // -vs-nested-event pairs; `no-type` vs `no-challenge` is a valid type with a
    // missing field. All three used to read the same.
    const reasonFor = (name: string) => CASES.find(([n]) => n.startsWith(name))?.[2];
    expect(reasonFor("an object with no type")).not.toBe(reasonFor("url_verification with no challenge"));
    expect(reasonFor("an object with no type")).not.toBe(reasonFor("event_callback whose event has no type"));
    expect(reasonFor("JSON, but a bare string")).not.toBe(reasonFor("event_callback with no event"));
  });
});

describe("body classification", () => {
  it("detects the url_verification handshake and carries the challenge", async () => {
    // Without this, the endpoint can never be saved in the Slack app config.
    const parsed = await Effect.runPromise(
      classifySlackBody({ type: "url_verification", challenge: "3eZbrw1aB" }),
    );
    expect(parsed).toMatchObject({ kind: "url_verification", challenge: "3eZbrw1aB" });
  });

  it("rejects a non-object body", async () => {
    expect(failureTag(await Effect.runPromiseExit(classifySlackBody("nope")))).toBe("SlackBodyMalformed");
    expect(failureTag(await Effect.runPromiseExit(classifySlackBody(null)))).toBe("SlackBodyMalformed");
  });

  it("rejects a body with no type", async () => {
    expect(failureTag(await Effect.runPromiseExit(classifySlackBody({ challenge: "x" })))).toBe("SlackBodyMalformed");
  });

  it("REJECTS an otherwise-valid message with no event_id, rather than pass it through unkeyed", async () => {
    // event_id is the ONLY idempotency key: Slack's retries reuse it but carry a
    // fresh timestamp + signature, so a body hash would mint a new id per retry
    // and double-insert. An envelope without one cannot be de-duped, so it is
    // rejected here — which is what makes SlackMessageRecord.eventId a
    // non-optional string, and any `eventId ?? <fallback>` downstream dead code.
    const body = {
      type: "event_callback",
      team_id: "T1",
      event: { type: "message", text: "hi", user: "U1", channel: "C1", ts: "1.2" },
    };
    const exit = await Effect.runPromiseExit(classifySlackBody(body));
    expect(failureTag(exit)).toBe("SlackBodyMalformed");
  });

  it("reports no-event-id, NOT no-type, when only event_id is missing", async () => {
    // The type discriminator was present and valid — reporting "no-type" sends
    // whoever reads the failure looking at the wrong field.
    const exit = await Effect.runPromiseExit(
      classifySlackBody({
        type: "event_callback",
        team_id: "T1",
        event: { type: "message", text: "hi", user: "U1", channel: "C1", ts: "1.2" },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) ? Reflect.get(failure.value, "reason") : null).toBe("no-event-id");
    }
  });

  it("a message WITH an event_id carries it through as a plain string", async () => {
    const parsed = await Effect.runPromise(
      classifySlackBody({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev123",
        event: { type: "message", text: "hi", user: "U1", channel: "C1", ts: "1.2" },
      }),
    );
    expect(parsed).toMatchObject({ kind: "message", record: { eventId: "Ev123" } });
  });

  it("parseSlackBody rejects unparseable JSON", async () => {
    expect(failureTag(await Effect.runPromiseExit(parseSlackBody("{not json")))).toBe("SlackBodyMalformed");
  });
});

describe("resolveSlackSigningSecret", () => {
  it("fails closed when the signing secret is unset", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect(failureTag(await Effect.runPromiseExit(resolveSlackSigningSecret()))).toBe(
      "SlackSigningSecretNotConfigured",
    );
  });

  it("returns the configured secret", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    expect(await Effect.runPromise(resolveSlackSigningSecret())).toBe(SECRET);
  });
});
