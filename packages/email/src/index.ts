/**
 * `@gtmgrid/email` — the single outbound transactional-email surface for the
 * cloud tier. Ported from convex/email.ts + convex/emailAssets.ts (TRI-3244).
 *
 * `sendEmail` is the Resend seam (gated on `AUTH_RESEND_KEY`); the template
 * builders return ready-to-send {@link OutboundEmail} values. `emailEnabled()`
 * reports whether delivery is configured (no secrets). Better Auth's email-OTP +
 * password-reset hooks (packages/auth) call `sendEmail(verificationEmail(...))`
 * / `sendEmail(passwordResetEmail(...))`.
 */

export {
  emailEnabled,
  sendEmail,
  verificationEmail,
  passwordResetEmail,
  inviteEmail,
  welcomeEmail,
  type OutboundEmail,
} from "./templates.js";
