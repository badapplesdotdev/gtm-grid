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
// --- Grid repositories (TRI-3248) --------------------------------------------
export {
  cascadeDeleteColumn,
  cascadeDeleteRow,
  cascadeDeleteTable,
  type GridStore,
  makeGridStore,
  type StoreCell,
  type StoreColumn,
  type StoreProject,
  type StoreRow,
  type StoreTable,
} from "./repositories/grid-store.js";
export {
  type NewProject,
  type Project,
  ProjectRepo,
  ProjectRepoError,
  ProjectRepoLive,
  projectRepoLayer,
} from "./repositories/project-repo.js";
export {
  type NewTable,
  type Table,
  TableRepo,
  TableRepoError,
  TableRepoLive,
  tableRepoLayer,
} from "./repositories/table-repo.js";
export {
  type Column,
  type ColumnKind,
  ColumnRepo,
  ColumnRepoError,
  ColumnRepoLive,
  columnRepoLayer,
  type NewColumn,
} from "./repositories/column-repo.js";
export {
  type NewRow,
  type Row,
  type RowCursor,
  type RowPage,
  ROW_PAGE_SIZE,
  RowRepo,
  RowRepoError,
  RowRepoLive,
  rowRepoLayer,
} from "./repositories/row-repo.js";
export {
  type Cell,
  type CellPatchValues,
  CellRepo,
  CellRepoError,
  CellRepoLive,
  cellRepoLayer,
  type NewCell,
} from "./repositories/cell-repo.js";

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
  type WorkerTableMeta,
} from "./services/webhook-service.js";
export { ExtensionService } from "./services/extension-service.js";
// --- Cloud-access gate (entitlement) -----------------------------------------
export {
  EntitlementService,
  PlanRequiredError,
} from "./services/entitlement-service.js";
// --- Grid domain service + the dedicated metering WRITE path (TRI-3248) -------
// NB: the grid's CloudActionsLimitError / InvalidCellError carry the SAME `_tag`
// as the webhook-service classes of the same name (so the trpc error mapping is
// shared), but are re-exported under `Grid…` aliases here to avoid a barrel name
// collision with the already-exported webhook versions.
export {
  type CellMap as GridCellMap,
  CloudActionsLimitError as GridCloudActionsLimitError,
  type FullGrid,
  GridNotFoundError,
  GridService,
  InvalidCellError as GridInvalidCellError,
  type TablePage,
} from "./services/grid-service.js";
// --- Share-a-table-via-URL: snapshot format + repo + service -----------------
export {
  referencedProviders,
  SHARE_SNAPSHOT_MAX_BYTES,
  SHARE_SNAPSHOT_VERSION,
  type SnapshotCell,
  type SnapshotColumn,
  type SnapshotColumnKind,
  type SnapshotColumnType,
  type SnapshotSourceGrid,
  snapshotFromFullGrid,
  type SnapshotValidation,
  type TableShareSnapshot,
  validateSnapshot,
} from "./share-snapshot.js";
export {
  type InMemoryShareTable,
  type InsertShareInput,
  ShareRepo,
  ShareRepoError,
  type ShareRepoFixtures,
  ShareRepoLive,
  shareRepoLayer,
  type TableShare,
} from "./repositories/share-repo.js";
export {
  type CloneResult,
  type CreateShareResult,
  InvalidShareSnapshotError,
  ShareNotFoundError,
  type SharePreview,
  ShareService,
  type ShareSummary,
  ShareTooLargeError,
  shareUrlFor,
} from "./services/share-service.js";
export {
  type MeterQuota,
  MeterService,
  MeterServiceError,
  MeterServiceLive,
  meterServiceLayer,
} from "./services/meter-service.js";
// --- Realtime broadcast port + shared client event schema/reducer (TRI-3251) -
export {
  noopRealtimePublisherLayer,
  partyPublishUrl,
  RealtimePublisher,
  type RealtimePublisherConfig,
  RealtimePublisherError,
  realtimePublisherConfigFromEnv,
  realtimePublisherLayer,
  realtimePublisherLayerFromEnv,
  type RecordedGridEvent,
  recordingRealtimePublisherLayer,
} from "./services/realtime-publisher.js";
export {
  type CellUpsertEvent,
  type ColumnDeleteEvent,
  type ColumnInsertEvent,
  GRID_EVENT_NAME,
  type GridChangeEvent,
  type GridEventCell,
  type GridEventColumn,
  type GridEventRow,
  type GridSnapshot,
  gridChannelName,
  type RowDeleteEvent,
  type RowInsertEvent,
  type TableDeleteEvent,
  type TableInsertEvent,
} from "./realtime/events.js";
export { applyGridEvent } from "./realtime/reducer.js";
export {
  type GridPartyMessage,
  type GridPresenceState,
  type GridPresenceUpdate,
  type GridSubscription,
  subscribeToGrid,
  type SubscribeToGridOptions,
} from "./realtime/channel.js";

// --- Webhook token/secret minting + credential crypto ------------------------
// NB: webhook-mint also exports `mintToken`, but the invitation-service
// `mintToken` already occupies that name on the barrel and the webhook signer
// imports its own directly from ./webhook-mint.js, so only the non-colliding
// `mintSigningSecret` + credential-crypto helpers are surfaced here.
export { mintSigningSecret } from "./webhook-mint.js";
export { credentialCryptoLive } from "./credential-crypto.js";
export { credentialCryptoTest } from "./credential-crypto-test.js";

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

// --- Re-export the reused authz + seats/billing + crypto core ----------------
export {
  AutumnClient,
  AutumnError,
  type CloudCellStatus,
  CredentialCryptoService,
  CredentialOwnershipError,
  CredentialOwnershipService,
  type CredentialScope,
  type CustomerData,
  DecryptError,
  EncryptError,
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
  type SecretMap,
  SeatLimitExceededError,
  SeatsService,
  UnauthenticatedError,
  UnknownPlanError,
} from "@gtmgrid/cloud";

export * from "./signals/catalog.js";
export { SignalRepo, SignalRepoLive, signalRepoLayer, SignalRepoError, type SignalBinding, type SignalBindingColumn, type SignalBindingInsert, type SignalBindingPatch, type SignalDueCursor, type DueBinding, type DueBindingPage } from "./repositories/signal-repo.js";
export { SignalService, SignalError } from "./services/signal-service.js";
