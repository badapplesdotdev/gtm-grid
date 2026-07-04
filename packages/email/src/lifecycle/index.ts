/**
 * `@gtmgrid/email/lifecycle` — the React-Email lifecycle templates (#8–#20).
 *
 * A SEPARATE subpath export on purpose: the root `@gtmgrid/email` barrel is
 * imported by packages compiled under React 18 types (desktop), and this
 * package ships raw TS source, so exporting the .tsx templates from the root
 * would drag React-19-typed JSX into those compiles. Only the Inngest
 * lifecycle functions (apps/web, React 19) import this subpath.
 */

export { type ShellLinks } from "./_components.js";
export {
  columnsAreFunctionsEmail,
  columnsAreFunctionsSubject,
  type ColumnsAreFunctionsProps,
} from "./columns-are-functions.js";
export {
  connectAiKeyEmail,
  connectAiKeySubject,
  type ConnectAiKeyProps,
} from "./connect-ai-key.js";
export {
  creditWarningEmail,
  creditWarningSubject,
  type CreditWarningProps,
} from "./credit-warning.js";
export {
  dormantEmail,
  dormantSubject,
  type DormantProps,
} from "./dormant.js";
export {
  firstTableEmail,
  firstTableSubject,
  type FirstTableProps,
} from "./first-table.js";
export {
  inviteTeamEmail,
  inviteTeamSubject,
  type InviteTeamProps,
} from "./invite-team.js";
export {
  paymentFailedEmail,
  paymentFailedSubject,
  type PaymentFailedProps,
} from "./payment-failed.js";
export {
  runFinishedEmail,
  runFinishedSubject,
  type RunFinishedProps,
} from "./run-finished.js";
export {
  signalsWaitingEmail,
  signalsWaitingSubject,
  type SignalsWaitingProps,
} from "./signals-waiting.js";
export {
  subscriptionConfirmedEmail,
  subscriptionConfirmedSubject,
  type SubscriptionConfirmedProps,
} from "./subscription-confirmed.js";
export {
  teammateJoinedEmail,
  teammateJoinedSubject,
  type TeammateJoinedProps,
} from "./teammate-joined.js";
export {
  trialWinbackEmail,
  trialWinbackSubject,
  type TrialWinbackProps,
} from "./trial-winback.js";
export {
  weeklyDigestEmail,
  weeklyDigestSubject,
  type WeeklyDigestProps,
} from "./weekly-digest.js";
