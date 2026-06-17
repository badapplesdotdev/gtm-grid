import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ErrorReporter,
  errorReporterLayer,
  errorReporterNoop,
} from "./error-reporter.js";

// Mock the email transport so the live invite-email port's failure path runs
// offline (no Resend). vi.mock is hoisted above imports.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock("@gtmgrid/email", () => ({
  inviteEmail: (opts: unknown) => opts,
  sendEmail: sendEmailMock,
}));

import { InviteEmailPort, InviteEmailPortLive } from "./invite-email.js";

const ARGS = {
  to: "new@member.dev",
  workspaceName: "Acme",
  inviterName: "Ada",
  inviterEmail: "ada@acme.dev",
  acceptUrl: "https://app/accept/x",
};

describe("ErrorReporter", () => {
  it("noop reporter succeeds without a sink", async () => {
    const program = Effect.gen(function* () {
      const r = yield* ErrorReporter;
      yield* r.report(new Error("ignored"), { a: 1 });
      return "ok";
    }).pipe(Effect.provide(errorReporterNoop));
    await expect(Effect.runPromise(program)).resolves.toBe("ok");
  });

  it("live reporter forwards error + context to the sink", async () => {
    const sink = vi.fn();
    const program = Effect.gen(function* () {
      const r = yield* ErrorReporter;
      yield* r.report(new Error("boom"), { source: "test" });
    }).pipe(Effect.provide(errorReporterLayer(sink)));
    await Effect.runPromise(program);
    expect(sink).toHaveBeenCalledWith(expect.any(Error), { source: "test" });
  });
});

describe("InviteEmailPortLive — best-effort with reporting", () => {
  it("returns false AND reports when the email send fails", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("resend down"));
    const sink = vi.fn();
    const program = Effect.gen(function* () {
      const port = yield* InviteEmailPort;
      return yield* port.send(ARGS);
    }).pipe(
      Effect.provide(InviteEmailPortLive.pipe(Layer.provide(errorReporterLayer(sink)))),
    );

    const delivered = await Effect.runPromise(program);
    expect(delivered).toBe(false); // invite must not fail on email outage
    expect(sink).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "invite-email", to: ARGS.to }),
    );
  });

  it("returns true and does not report on success", async () => {
    sendEmailMock.mockResolvedValueOnce(undefined);
    const sink = vi.fn();
    const program = Effect.gen(function* () {
      const port = yield* InviteEmailPort;
      return yield* port.send(ARGS);
    }).pipe(
      Effect.provide(InviteEmailPortLive.pipe(Layer.provide(errorReporterLayer(sink)))),
    );

    const delivered = await Effect.runPromise(program);
    expect(delivered).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });
});
