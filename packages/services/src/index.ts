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
  type CellWrite,
  type GridCell,
  type GridColumn,
  type GridRow,
  type GridTable,
  type Webhook,
  type WebhookInsert,
  type WebhookMappingEntry,
  type WebhookMode,
  type WebhookPatch,
  WebhookRepo,
  WebhookRepoError,
  WebhookRepoLive,
  webhookRepoLayer,
  type WorkspaceQuota,
} from "./repositories/webhook-repo.js";
export {
  type DeliveryCursor,
  type DeliveryMode,
  type DeliveryPage,
  type WebhookDelivery,
  type WebhookDeliveryInsert,
  WebhookDeliveryRepo,
  WebhookDeliveryRepoError,
  WebhookDeliveryRepoLive,
  webhookDeliveryRepoLayer,
} from "./repositories/webhook-delivery-repo.js";
export {
  type Extension,
  type ExtensionInsert,
  type ExtensionPatch,
  ExtensionRepo,
  ExtensionRepoError,
  ExtensionRepoLive,
  extensionRepoLayer,
} from "./repositories/extension-repo.js";

// --- Domain services ---------------------------------------------------------
export {
  type GetWorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceService,
} from "./services/workspace-service.js";
export {
  type CellMap,
  CloudActionsLimitError,
  DELIVERIES_PAGE_SIZE,
  DELIVERY_RETENTION,
  InvalidCellError,
  InvalidConfigError,
  InvalidMappingError,
  type ResolvedWebhook,
  WebhookNotFoundError,
  WebhookService,
  type WorkerGrid,
} from "./services/webhook-service.js";
export { ExtensionService } from "./services/extension-service.js";

// --- Webhook token/secret minting + credential crypto ------------------------
export { mintSigningSecret, mintToken } from "./webhook-mint.js";
export { credentialCryptoLive } from "./credential-crypto.js";
export {
  credentialCryptoTest,
  TEST_MASTER_KEY,
} from "./credential-crypto-test.js";

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

// --- Re-export the reused authz core so routers import from one place --------
export {
  type CloudCellStatus,
  CredentialCryptoService,
  DecryptError,
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
