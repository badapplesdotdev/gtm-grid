import { z } from "zod";

/**
 * Validated, typed access to the env vars the web app reads directly. Centralizes
 * the `NEXT_PUBLIC_*` (build-inlined, client-visible) PostHog config so we never
 * sprinkle non-null `!` assertions that crash a render when a var is unset.
 *
 * Analytics vars are OPTIONAL on purpose: a missing PostHog token must DEGRADE
 * (analytics disabled) rather than throw — losing telemetry should never take down
 * the app. Vars that are malformed-when-present still surface a loud warning.
 *
 * NOTE: `NEXT_PUBLIC_*` reads must be literal `process.env.NEXT_PUBLIC_X` for Next
 * to inline them into the client bundle — hence the explicit object below.
 */
const clientSchema = z.object({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
});

const parsed = clientSchema.safeParse({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});

if (!parsed.success) {
  // Don't throw — degrade. A bad analytics var should never break the app.
  console.warn("[env] PostHog client env invalid, analytics degraded:", parsed.error.flatten().fieldErrors);
}

type ClientEnv = z.infer<typeof clientSchema>;
export const clientEnv: ClientEnv = parsed.success ? parsed.data : {};

/** True when PostHog has a project token and can be initialized. */
export const posthogEnabled = Boolean(clientEnv.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN);
