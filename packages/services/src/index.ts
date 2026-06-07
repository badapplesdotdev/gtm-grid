/**
 * `@gtmgrid/services` — the Effect-DI foundation EVERY tRPC router builds on.
 *
 * Holds the cloud tier's Effect repositories (the Effect <-> Drizzle adapters
 * over `@gtmgrid/db`) and domain services (business logic composing repos +
 * the reused `@gtmgrid/cloud` authz core). Each repo/service is a `Context.Tag`
 * with a LIVE Layer (Drizzle-backed) and a TEST in-memory Layer; {@link AppLayer}
 * composes the Live ones and {@link TestLayer} the in-memory ones, so a program
 * runs identically against production or fixtures.
 *
 * See README.md for the repo/service/Layer + context-injection + testing pattern
 * W2 lanes follow.
 */

// --- The per-request DB seam -------------------------------------------------
export { DbClient, DbClientLive, dbClientLayer } from "./db-client.js";

// --- Repositories (Effect <-> Drizzle adapters) ------------------------------
export {
  type NewWorkspace,
  type Workspace,
  type WorkspaceCustomerData,
  WorkspaceRepo,
  WorkspaceRepoError,
  WorkspaceRepoLive,
  workspaceRepoLayer,
  type WorkspaceUser,
} from "./repositories/workspace-repo.js";
export { MemberRepoLive } from "./repositories/member-repo.js";
export {
  type MemberRow,
  type MemberWithUser,
  type NewMember,
  WorkspaceMemberRepo,
  WorkspaceMemberRepoError,
  WorkspaceMemberRepoLive,
  workspaceMemberRepoLayer,
} from "./repositories/workspace-member-repo.js";
export {
  type AcceptInsertInput,
  type AcceptInsertResult,
  InvalidInvitationError,
  type Invitation,
  type InvitationStatus,
  InvitationRepo,
  InvitationRepoError,
  type InvitationRepoFixtures,
  InvitationRepoLive,
  invitationRepoLayer,
  type InMemoryUser,
  type InMemoryWorkspace,
  type UpsertInviteInput,
  type UserInfo,
} from "./repositories/invitation-repo.js";

// --- The Autumn billing port (LIVE) ------------------------------------------
export { autumnClientLayer, AutumnClientLive } from "./autumn-client.js";

// --- Domain services ---------------------------------------------------------
export {
  type CreateWorkspaceError,
  type GetWorkspaceError,
  type InsertMemberError,
  type InsertMemberResult,
  type ListMembersError,
  type Me,
  type MeError,
  type MeUser,
  type MeWorkspace,
  type SeatUsage,
  type WorkspaceMember,
  type WorkspaceMembersResult,
  WorkspaceNotFoundError,
  type WorkspacePlan,
  WorkspaceService,
} from "./services/workspace-service.js";
export {
  BillingService,
  type CheckoutError,
} from "./services/billing-service.js";
export {
  type AcceptResult,
  acceptUrlFor,
  InvalidEmailError,
  type InvitationPreview,
  InvitationService,
  type InviteByEmailResult,
  mintToken,
  type MyPendingInvitationView,
  normalizeEmail,
  type PendingInvitationView,
} from "./services/invitation-service.js";
export {
  type InviteEmailArgs,
  InviteEmailPort,
  InviteEmailPortLive,
  inviteEmailPortLayer,
} from "./services/invite-email.js";

// --- Composed Layers (the DI wiring point) -----------------------------------
export {
  appLayer,
  type AppServices,
  identityFromUserId,
  TestLayer,
  type TestLayerFixtures,
} from "./layers.js";

// --- Worker-secret boundary (W2) ---------------------------------------------
export { isAuthorizedWorker, timingSafeEqual } from "./worker-secret.js";

// --- Re-export the reused authz + seats/billing core (one import surface) -----
export {
  AutumnClient,
  AutumnError,
  type CustomerData,
  type FakeAutumnConfig,
  fakeAutumnLayer,
  failingAutumnLayer,
  Identity,
  InsufficientRoleError,
  type Membership,
  type MemberRole,
  MemberRepo,
  MemberRepoError,
  MembershipService,
  NoCheckoutUrlError,
  NotAMemberError,
  planName,
  type SeatCheck,
  SeatLimitExceededError,
  SeatsService,
  UnauthenticatedError,
  UnknownPlanError,
} from "@gtmgrid/cloud";
