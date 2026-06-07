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
  type Workspace,
  WorkspaceRepo,
  WorkspaceRepoError,
  WorkspaceRepoLive,
  workspaceRepoLayer,
} from "./repositories/workspace-repo.js";
export { MemberRepoLive } from "./repositories/member-repo.js";
export {
  type CredentialMetadata,
  type CredentialRow,
  CredentialRepo,
  CredentialRepoError,
  CredentialRepoLive,
  credentialRepoLayer,
  type CredentialUpsert,
  type OwnerKey,
} from "./repositories/credential-repo.js";

// --- Domain services ---------------------------------------------------------
export {
  type GetWorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceService,
} from "./services/workspace-service.js";
export {
  CryptoService,
  CryptoServiceLive,
  cryptoServiceLayer,
  TEST_MASTER_KEY,
} from "./services/crypto-service.js";
export {
  CredentialService,
  type GetForRunError,
  type GetForRunInput,
  type ListCredentialsError,
  type SaveCredentialError,
  type SaveCredentialInput,
} from "./services/credential-service.js";

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

// --- Re-export the reused authz/crypto core so routers import from one place -
export {
  CredentialOwnershipError,
  CredentialOwnershipService,
  type CredentialScope,
  DecryptError,
  EncryptError,
  Identity,
  InsufficientRoleError,
  type Membership,
  type MemberRole,
  MemberRepo,
  MemberRepoError,
  MembershipService,
  NotAMemberError,
  type SecretMap,
  UnauthenticatedError,
} from "@gtmgrid/cloud";
