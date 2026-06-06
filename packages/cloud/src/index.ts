/**
 * @gtmgrid/cloud — pure Effect domain logic for the Convex cloud (team) tier.
 *
 * Currently exposes the workspace authorization core (auth identity + workspace
 * membership). Convex handlers (convex/) import these to run domain logic via
 * `Effect.runPromise` with `ctx`-backed Layers.
 */

export {
  Identity,
  InsufficientRoleError,
  MemberRepo,
  MemberRepoError,
  MembershipService,
  NotAMemberError,
  UnauthenticatedError,
  type Membership,
  type MemberRole,
} from "./membership.js";

export {
  failingMemberRepoLayer,
  identityLayer,
  memberRepoLayer,
} from "./test-layers.js";

export {
  CellMerge,
  type CellFields,
  type CellPatch,
  type CloudCellStatus,
} from "./cells.js";

export {
  CascadePlanner,
  type DeletePlan,
  type TableChildren,
} from "./cascade.js";

export {
  AutumnClient,
  AutumnError,
  NoCheckoutUrlError,
  SeatLimitExceededError,
  SeatsService,
  SEATS_FEATURE_ID,
  TEAM_PLAN_ID,
  type SeatCheck,
} from "./seats.js";

export {
  CLOUD_ACTIONS_FEATURE_ID,
  CloudActionsService,
  type FlushResult,
  type PendingWorkspace,
} from "./cloud-actions.js";

export {
  type FakeAutumnConfig,
  failingAutumnLayer,
  fakeAutumnLayer,
} from "./seats-test-layers.js";

export {
  CredentialCryptoService,
  CryptoPrimitives,
  type CredentialEnvelope,
  DecryptError,
  EncryptError,
  IV_BYTES,
  KEY_BYTES,
  MasterKey,
  type SecretMap,
  TAG_BYTES,
} from "./crypto.js";

export {
  CredentialOwnershipError,
  CredentialOwnershipService,
  type CredentialScope,
} from "./credential-ownership.js";

export {
  decodeMasterKeyBytes,
  MissingSecretError,
  requireSecret,
} from "./live-config.js";

// NOTE: ./crypto-test-layers.js is deliberately NOT re-exported here. It imports
// `node:crypto`, and the Convex bundler pulls this index into the (esbuild)
// graph for convex/model/crypto.ts — re-exporting a node-only module would make
// that bundle fail to resolve `node:crypto`. Tests import the crypto test layers
// directly via the relative path instead.
