/**
 * `ErrorReporter` — an injectable seam for reporting SWALLOWED, best-effort
 * failures to the host's exception sink (PostHog Error Tracking), without
 * coupling `@gtmgrid/services` to any telemetry client.
 *
 * Most service failures flow uncaught through the typed error channel to the
 * boundary that runs the Effect (tRPC `runEffect`, the worker route, Inngest
 * `onFailure`), which is where capture already happens. This port is for the
 * exceptions to that rule: a failure a service deliberately CATCHES and folds to
 * a value (so the boundary never sees it) — e.g. a best-effort invite email that
 * must not fail the invite. Such sites report through `ErrorReporter` so the
 * failure is still visible, then continue.
 *
 * The host wires {@link errorReporterLayer} with its sink (apps/web passes
 * `captureServerException`); tests and unconfigured runs get {@link errorReporterNoop}.
 */
import { Context, Effect, Layer } from "effect";

export class ErrorReporter extends Context.Tag("ErrorReporter")<
  ErrorReporter,
  {
    readonly report: (
      error: unknown,
      context?: Record<string, unknown>,
    ) => Effect.Effect<void>;
  }
>() {}

/** No-op reporter — the default when no host sink is wired (tests / OSS build). */
export const errorReporterNoop: Layer.Layer<ErrorReporter> = Layer.succeed(
  ErrorReporter,
  { report: () => Effect.void },
);

/** Live reporter forwarding to a host sink (e.g. `captureServerException`). */
export const errorReporterLayer = (
  sink: (error: unknown, context?: Record<string, unknown>) => void,
): Layer.Layer<ErrorReporter> =>
  Layer.succeed(ErrorReporter, {
    report: (error, context) => Effect.sync(() => sink(error, context)),
  });
