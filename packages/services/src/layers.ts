/**
 * Composed Layers — the single wiring point for the Effect-DI seam.
 *
 * Two surfaces, both producing the SAME services so a program is identical
 * across production and tests:
 *
 *   - {@link AppLayer} — the LIVE composition. Wires every repository and domain
 *     service to its Drizzle-backed implementation. It still needs two pieces of
 *     PER-REQUEST data — the pooled {@link DbClient} handle and the caller's
 *     {@link Identity} — which the tRPC context supplies (see
 *     apps/web/lib/trpc/context.ts). `AppLayer` therefore has those two tags in
 *     its requirements; `appLayer({ db, userId })` is the convenience builder
 *     that closes over them for a request.
 *   - {@link TestLayer} — the in-memory composition factory. Takes fixtures
 *     (workspaces, memberships, current user id) and wires every service to its
 *     in-memory Test Layer. No `DbClient` is ever needed, so swapping `TestLayer`
 *     for `AppLayer` changes behaviour with NO live database — the exact seam the
 *     acceptance criteria require.
 *
 * `identityLayer` / `memberRepoLayer` are reused from `@gtmgrid/cloud` (the pure
 * authz domain) so production and tests share one definition of "who is the
 * caller" and "what memberships exist".
 */

import {
  type AutumnClient,
  CellMerge,
  identityLayer as cloudIdentityLayer,
  type CredentialCryptoService,
  CredentialOwnershipService,
  type FakeAutumnConfig,
  fakeAutumnLayer,
  Identity,
  type Membership,
  MembershipService,
  SeatsService,
} from "@gtmgrid/cloud";
import type { Db } from "@gtmgrid/db/client";
import { Effect, Layer, Option } from "effect";
import { AutumnClientLive } from "./autumn-client.js";
import { credentialCryptoLive } from "./credential-crypto.js";
import { credentialCryptoTest } from "./credential-crypto-test.js";
import { dbClientLayer } from "./db-client.js";
import {
  type CredentialRow,
  CredentialRepo,
  CredentialRepoLive,
  credentialRepoLayer,
} from "./repositories/credential-repo.js";
import {
  type Extension,
  ExtensionRepo,
  ExtensionRepoLive,
  extensionRepoLayer,
} from "./repositories/extension-repo.js";
import {
  type Invitation,
  type InMemoryWorkspace,
  InvitationRepo,
  InvitationRepoLive,
  invitationRepoLayer,
} from "./repositories/invitation-repo.js";
import {
  ShareRepo,
  ShareRepoLive,
  shareRepoLayer,
  type TableShare,
} from "./repositories/share-repo.js";
import { MemberRepoLive } from "./repositories/member-repo.js";
import {
  CellRepo,
  CellRepoLive,
  cellRepoLayer,
} from "./repositories/cell-repo.js";
import {
  ColumnRepo,
  ColumnRepoLive,
  columnRepoLayer,
} from "./repositories/column-repo.js";
import {
  type GridStore,
  makeGridStore,
  type StoreCell,
  type StoreColumn,
  type StoreFolder,
  type StoreProject,
  type StoreRow,
  type StoreTable,
} from "./repositories/grid-store.js";
import {
  ProjectRepo,
  ProjectRepoLive,
  projectRepoLayer,
} from "./repositories/project-repo.js";
import {
  type PipelineBindingRecord,
  type PipelineRecord,
  PipelineRepo,
  PipelineRepoLive,
  pipelineRepoLayer,
  type PipelineRunRecord,
  type PipelineVersionRecord,
} from "./repositories/pipeline-repo.js";
import {
  RowRepo,
  RowRepoLive,
  rowRepoLayer,
} from "./repositories/row-repo.js";
import {
  TableRepo,
  TableRepoLive,
  tableRepoLayer,
} from "./repositories/table-repo.js";
import {
  FolderRepo,
  FolderRepoLive,
  folderRepoLayer,
} from "./repositories/folder-repo.js";
import {
  type WebhookDelivery,
  WebhookDeliveryRepo,
  WebhookDeliveryRepoLive,
  webhookDeliveryRepoLayer,
} from "./repositories/webhook-delivery-repo.js";
import {
  type GridCell,
  type GridColumn,
  type GridRow,
  type GridTable,
  type Webhook,
  WebhookRepo,
  WebhookRepoLive,
  webhookRepoLayer,
  type WorkspaceQuota,
} from "./repositories/webhook-repo.js";
import {
  memberStoreLayers,
  type MemberWithUser,
  WorkspaceMemberRepo,
  WorkspaceMemberRepoLive,
} from "./repositories/workspace-member-repo.js";
import {
  type Workspace,
  WorkspaceRepo,
  WorkspaceRepoLive,
  workspaceRepoLayer,
} from "./repositories/workspace-repo.js";
import {
  LifecycleEmailRepo,
  LifecycleEmailRepoLive,
  lifecycleEmailRepoLayer,
} from "./repositories/lifecycle-email-repo.js";
import {
  LifecycleCronRepo,
  LifecycleCronRepoLive,
  lifecycleCronRepoLayer,
} from "./repositories/lifecycle-cron-repo.js";
import { ExtensionService } from "./services/extension-service.js";
import {
  ErrorReporter,
  errorReporterLayer,
  errorReporterNoop,
} from "./services/error-reporter.js";
import { EntitlementService } from "./services/entitlement-service.js";
import { GridService } from "./services/grid-service.js";
import { ShareService } from "./services/share-service.js";
import {
  type MeterQuota,
  MeterService,
  MeterServiceLive,
  meterServiceLayer,
} from "./services/meter-service.js";
import {
  RealtimePublisher,
  type RecordedGridEvent,
  realtimePublisherLayerFromEnv,
  recordingRealtimePublisherLayer,
} from "./services/realtime-publisher.js";
import { WebhookService } from "./services/webhook-service.js";
import {
  SignalRepo,
  SignalRepoLive,
  signalRepoLayer,
  type SignalBinding,
} from "./repositories/signal-repo.js";
import { SignalService } from "./services/signal-service.js";
import { AttioAuth } from "./services/attio-auth.js";
import { AttioClient } from "./services/attio-client.js";
import { CrmClientRegistry } from "./services/crm-client-registry.js";
import { CrmAuthRegistry } from "./services/crm-auth-registry.js";
import { HubspotAuth } from "./services/hubspot-auth.js";
import { HubspotClient } from "./services/hubspot-client.js";
import { CrmConnectionService } from "./services/crm-connection-service.js";
import { CrmSyncService } from "./services/crm-sync-service.js";
import {
  type CrmBinding,
  CrmBindingRepo,
  CrmBindingRepoLive,
  crmBindingRepoLayer,
  type CrmSyncedRow,
  CrmSyncedRowRepo,
  CrmSyncedRowRepoLive,
  crmSyncedRowRepoLayer,
  type CrmSyncRun,
  CrmSyncRunRepo,
  CrmSyncRunRepoLive,
  crmSyncRunRepoLayer,
} from "./repositories/crm-repo.js";
import { BillingService } from "./services/billing-service.js";
import { CredentialService } from "./services/credential-service.js";
import {
  CryptoService,
  CryptoServiceLive,
  cryptoServiceLayer,
} from "./services/crypto-service.js";
import { InvitationService } from "./services/invitation-service.js";
import {
  type InviteEmailArgs,
  InviteEmailPort,
  InviteEmailPortLive,
  inviteEmailPortLayer,
} from "./services/invite-email.js";
import { WorkspaceService } from "./services/workspace-service.js";
import { PipelineService } from "./services/pipeline-service.js";

/**
 * An {@link Identity} Layer backed by an already-resolved user id (or `null`
 * when the request is unauthenticated). The tRPC context resolves the id from
 * the Better Auth session (`getSessionUserId`) and provides it here, so the
 * authz core sees the same `Option<string>` shape as the test `identityLayer`.
 */
export const identityFromUserId = (
  userId: string | null,
): Layer.Layer<Identity> =>
  Layer.succeed(Identity, {
    currentUserId: Effect.succeed(Option.fromNullable(userId)),
  });

/**
 * The live, per-request services Layer. Provides every domain service +
 * repository wired to Drizzle, with the {@link DbClient} pooled handle and the
 * caller's {@link Identity} closed over from the request.
 *
 * Requirement set is fully satisfied here — the returned Layer needs nothing
 * else, so the tRPC context can build a Runtime from it directly.
 */
export const appLayer = (params: {
  readonly db: Db;
  readonly userId: string | null;
  /**
   * Host sink for SWALLOWED, best-effort failures (e.g. a failed invite email) →
   * PostHog Error Tracking. apps/web passes `captureServerException`; omitted ⇒ a
   * no-op reporter (tests / OSS). Uncaught failures still surface at the boundary.
   */
  readonly reportError?: (error: unknown, context?: Record<string, unknown>) => void;
}): Layer.Layer<AppServices> => {
  const dbLayer = dbClientLayer(params.db);
  const identity = identityFromUserId(params.userId);
  const errorReporter: Layer.Layer<ErrorReporter> = params.reportError
    ? errorReporterLayer(params.reportError)
    : errorReporterNoop;
  const memberRepo = MemberRepoLive.pipe(Layer.provide(dbLayer));
  const workspaceRepo = WorkspaceRepoLive.pipe(Layer.provide(dbLayer));
  const lifecycleEmailRepo = LifecycleEmailRepoLive.pipe(Layer.provide(dbLayer));
  const lifecycleCronRepo = LifecycleCronRepoLive.pipe(Layer.provide(dbLayer));
  const workspaceMemberRepo = WorkspaceMemberRepoLive.pipe(
    Layer.provide(dbLayer),
  );
  const invitationRepo = InvitationRepoLive.pipe(Layer.provide(dbLayer));
  const credentialRepo = CredentialRepoLive.pipe(Layer.provide(dbLayer));
  const webhookRepo = WebhookRepoLive.pipe(Layer.provide(dbLayer));
  const webhookDeliveryRepo = WebhookDeliveryRepoLive.pipe(
    Layer.provide(dbLayer),
  );
  const extensionRepo = ExtensionRepoLive.pipe(Layer.provide(dbLayer));
  const projectRepo = ProjectRepoLive.pipe(Layer.provide(dbLayer));
  const pipelineRepo = PipelineRepoLive.pipe(Layer.provide(dbLayer));
  const tableRepo = TableRepoLive.pipe(Layer.provide(dbLayer));
  const folderRepo = FolderRepoLive.pipe(Layer.provide(dbLayer));
  const columnRepo = ColumnRepoLive.pipe(Layer.provide(dbLayer));
  const rowRepo = RowRepoLive.pipe(Layer.provide(dbLayer));
  const cellRepo = CellRepoLive.pipe(Layer.provide(dbLayer));
  // Autumn (billing/seats) is an external SaaS. With AUTUMN_SECRET_KEY set we use
  // the live SDK; without it (local dev / self-host without billing) we fall back
  // to the in-memory fake (seats allowed, a dummy checkout URL, unlimited usage)
  // so invite/seat/checkout flows work without a billing account.
  const autumnLayer = process.env.AUTUMN_SECRET_KEY
    ? AutumnClientLive
    : fakeAutumnLayer({});
  // The metering WRITE path: a SEPARATE service (never bolted onto WorkspaceRepo)
  // that increments cloudActionsUsed via Drizzle + tracks usage to Autumn.
  const meterService = MeterServiceLive.pipe(
    Layer.provide(dbLayer),
    Layer.provide(autumnLayer),
  );
  // The live realtime broadcast port (TRI-3251/TRI-3261): server-publishes grid
  // change events to the PartyKit grid party (HTTP POST + PARTY_PUBLISH_SECRET),
  // or a no-op when the PartyKit env is not configured.
  const realtimePublisher = realtimePublisherLayerFromEnv();
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identity),
    Layer.provide(memberRepo),
  );
  // SeatsService is provided to BOTH the workspace service (transactional seat
  // ceiling on insertMember) and the billing service (checkout). One Autumn port
  // (the live, lazily-built SDK) backs it.
  const seatsService = SeatsService.Default.pipe(
    Layer.provide(autumnLayer),
  );
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(workspaceMemberRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(autumnLayer),
    Layer.provide(pipelineRepo),
  );
  const billingService = BillingService.Default.pipe(
    Layer.provide(membershipService),
    Layer.provide(workspaceRepo),
    Layer.provide(workspaceMemberRepo),
    Layer.provide(seatsService),
    Layer.provide(autumnLayer),
  );
  const invitationService = InvitationService.Default.pipe(
    Layer.provide(invitationRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(identity),
    Layer.provide(InviteEmailPortLive.pipe(Layer.provide(errorReporter))),
  );
  const credentialService = CredentialService.Default.pipe(
    Layer.provide(credentialRepo),
    Layer.provide(CryptoServiceLive),
    Layer.provide(membershipService),
    Layer.provide(CredentialOwnershipService.Default),
  );
  const entitlementService = EntitlementService.Default.pipe(
    Layer.provide(workspaceRepo),
  );
  const webhookService = WebhookService.Default.pipe(
    Layer.provide(webhookRepo),
    Layer.provide(webhookDeliveryRepo),
    Layer.provide(membershipService),
    Layer.provide(CellMerge.Default),
    Layer.provide(credentialCryptoLive),
    Layer.provide(entitlementService),
    Layer.provide(columnRepo),
    Layer.provide(realtimePublisher),
  );
  const extensionService = ExtensionService.Default.pipe(
    Layer.provide(extensionRepo),
    Layer.provide(membershipService),
  );
  const signalRepo = SignalRepoLive.pipe(Layer.provide(dbLayer));
  const crmBindingRepo = CrmBindingRepoLive.pipe(Layer.provide(dbLayer));
  const crmSyncedRowRepo = CrmSyncedRowRepoLive.pipe(Layer.provide(dbLayer));
  const crmSyncRunRepo = CrmSyncRunRepoLive.pipe(Layer.provide(dbLayer));
  const attioAuth = AttioAuth.Default;
  const attioClient = AttioClient.Default.pipe(Layer.provide(attioAuth));
  const hubspotAuth = HubspotAuth.Default;
  const hubspotClient = HubspotClient.Default.pipe(Layer.provide(hubspotAuth));
  const crmClientRegistry = CrmClientRegistry.Default.pipe(Layer.provide(attioClient), Layer.provide(hubspotClient));
  const crmAuthRegistry = CrmAuthRegistry.Default.pipe(Layer.provide(attioAuth), Layer.provide(hubspotAuth));
  const crmConnectionService = CrmConnectionService.Default.pipe(
    Layer.provide(credentialService),
    Layer.provide(credentialRepo),
    Layer.provide(CryptoServiceLive),
    Layer.provide(crmAuthRegistry),
  );
  const crmSyncService = CrmSyncService.Default.pipe(
    Layer.provide(crmBindingRepo),
    Layer.provide(crmSyncedRowRepo),
    Layer.provide(crmSyncRunRepo),
    Layer.provide(webhookRepo),
    Layer.provide(columnRepo),
    Layer.provide(crmClientRegistry),
    Layer.provide(crmConnectionService),
    Layer.provide(membershipService),
    Layer.provide(entitlementService),
    Layer.provide(workspaceRepo),
    Layer.provide(realtimePublisher),
  );
  const signalService = SignalService.Default.pipe(
    Layer.provide(signalRepo),
    Layer.provide(webhookRepo),
    Layer.provide(credentialService),
    Layer.provide(credentialCryptoLive),
    Layer.provide(membershipService),
    Layer.provide(entitlementService),
  );
  const shareRepo = ShareRepoLive.pipe(Layer.provide(dbLayer));
  const gridService = GridService.Default.pipe(
    Layer.provide(projectRepo),
    Layer.provide(tableRepo),
    Layer.provide(folderRepo),
    Layer.provide(columnRepo),
    Layer.provide(rowRepo),
    Layer.provide(cellRepo),
    Layer.provide(CellMerge.Default),
    Layer.provide(membershipService),
    Layer.provide(meterService),
    Layer.provide(realtimePublisher),
    Layer.provide(entitlementService),
    Layer.provide(pipelineRepo),
    Layer.provide(shareRepo),
  );
  const shareService = ShareService.Default.pipe(
    Layer.provide(shareRepo),
    Layer.provide(gridService),
    Layer.provide(membershipService),
    Layer.provide(identity),
  );
  const pipelineService = PipelineService.Default.pipe(
    Layer.provide(pipelineRepo),
    Layer.provide(projectRepo),
    Layer.provide(membershipService),
    Layer.provide(identity),
    Layer.provide(realtimePublisher),
  );
  // Merge so callers can resolve any repo or service from one Layer.
  return Layer.mergeAll(
    entitlementService,
    workspaceService,
    billingService,
    invitationService,
    credentialService,
    webhookService,
    extensionService,
    signalService,
    signalRepo,
    crmBindingRepo,
    crmSyncedRowRepo,
    crmSyncRunRepo,
    attioAuth,
    attioClient,
    hubspotAuth,
    hubspotClient,
    crmClientRegistry,
    crmAuthRegistry,
    crmConnectionService,
    crmSyncService,
    gridService,
    shareService,
    shareRepo,
    pipelineService,
    pipelineRepo,
    workspaceRepo,
    lifecycleEmailRepo,
    lifecycleCronRepo,
    workspaceMemberRepo,
    invitationRepo,
    credentialRepo,
    webhookRepo,
    webhookDeliveryRepo,
    extensionRepo,
    projectRepo,
    tableRepo,
    folderRepo,
    columnRepo,
    rowRepo,
    cellRepo,
    meterService,
    realtimePublisher,
    membershipService,
    seatsService,
    autumnLayer,
    CryptoServiceLive,
  );
};

/** Fixtures for {@link TestLayer}: the in-memory data the services read. */
export interface TestLayerFixtures {
  /** Workspaces visible to {@link WorkspaceRepo}. */
  readonly workspaces?: readonly Workspace[];
  /**
   * Membership rows visible to the authz core (the cloud `MemberRepo`'s
   * `findMembership`). The seat-guard / roster reads use {@link members} below.
   */
  readonly memberships?: readonly Membership[];
  /**
   * Member rows (with optional name/email) visible to
   * {@link WorkspaceMemberRepo} — the roster + counts the `me`/`listMembers`/
   * `insertMember` paths read. Defaults to {@link memberships} promoted to rows
   * (so a test that only sets `memberships` still gets a consistent roster).
   */
  readonly members?: readonly MemberWithUser[];
  /** Credential rows visible to {@link CredentialRepo} (incl. ciphertext). */
  readonly credentials?: readonly CredentialRow[];
  /** The current caller's user id, or `null` for an unauthenticated request. */
  readonly currentUserId?: string | null;
  /**
   * User rows shared by {@link WorkspaceRepo} (the `me`/owner email reads) and
   * {@link InvitationRepo} (inviter/invitee identity). The shape is the union of
   * both repos' needs — id, optional name, optional email — so one fixture list
   * serves the workspace AND invitation paths.
   */
  readonly users?: readonly {
    readonly id: string;
    readonly name?: string | null;
    readonly email?: string | null;
    readonly image?: string | null;
  }[];
  /**
   * Configures the fake Autumn port (@gtmgrid/cloud `fakeAutumnLayer`) backing
   * SeatsService + BillingService + the invite/accept seat gate, so checkout /
   * seat-ceiling / invite tests run with no SDK or HTTP. Defaults to a free seat
   * (`allowed: true`, unlimited balance).
   */
  readonly autumn?: FakeAutumnConfig;
  /** Invitation rows visible to {@link InvitationRepo}. */
  readonly invitations?: readonly Invitation[];
  /**
   * Workspaces visible to {@link InvitationRepo} (name + owner). Defaults to
   * `workspaces` projected to (id, name, ownerId) when omitted, so the common
   * case needs only one list.
   */
  readonly invitationWorkspaces?: readonly InMemoryWorkspace[];
  /** Records each invite email's args (the in-memory {@link InviteEmailPort}). */
  readonly emailsSent?: InviteEmailArgs[];
  /** Whether the in-memory email port reports delivery (default `true`). */
  readonly emailDelivered?: boolean;
  /** Webhooks visible to {@link WebhookRepo} (MUTATED by insert/patch/delete). */
  readonly webhooks?: Webhook[];
  /** Signal bindings visible to {@link SignalRepo} (MUTATED by insert/patch/delete). */
  readonly signalBindings?: SignalBinding[];
  /** CRM bindings visible to {@link CrmBindingRepo} (MUTATED by insert/patch/delete). */
  readonly crmBindings?: CrmBinding[];
  /** CRM record→row identity map for {@link CrmSyncedRowRepo} (MUTATED by upsert/stale). */
  readonly crmSyncedRows?: CrmSyncedRow[];
  /** CRM sync-run history for {@link CrmSyncRunRepo} (MUTATED by start/finish). */
  readonly crmSyncRuns?: CrmSyncRun[];
  /** Table shares visible to {@link ShareRepo} (MUTATED by insert/revoke). */
  readonly shares?: TableShare[];
  /** Reusable pipelines and their immutable/draft versions. */
  readonly pipelines?: PipelineRecord[];
  readonly pipelineVersions?: PipelineVersionRecord[];
  readonly pipelineBindings?: PipelineBindingRecord[];
  readonly pipelineRuns?: PipelineRunRecord[];
  readonly pipelineActionReceipts?: Set<string>;
  readonly pipelineCloudActions?: Map<
    string,
    { used: number; limit: number | null }
  >;
  /** Tables backing the webhook worker grid paths. */
  readonly tables?: GridTable[];
  /** Columns backing mapping validation + getTable. */
  readonly columns?: GridColumn[];
  /** Rows backing insert/upsert (MUTATED by the worker paths). */
  readonly rows?: GridRow[];
  /** Cells backing setCell/upsert (MUTATED by the worker paths). */
  readonly cells?: GridCell[];
  /** Per-workspace cloud-actions quota (MUTATED by the meter). */
  readonly quotas?: Map<string, WorkspaceQuota>;
  /**
   * Shared-credential ciphertext for the webhook worker grid keyed
   * `${workspaceId}:${extensionId}`. Distinct from {@link credentials} above
   * (the CredentialRepo rows) — this backs {@link WebhookRepo}'s worker reads.
   */
  readonly webhookCredentials?: Map<string, string>;
  /** Delivery-log rows (MUTATED by recordDelivery + the 50-row prune). */
  readonly deliveries?: WebhookDelivery[];
  /** Installed extensions (MUTATED by saveExtension). */
  readonly extensions?: Extension[];
  /** Override the crypto service (defaults to the deterministic test layer). */
  readonly crypto?: Layer.Layer<CredentialCryptoService>;
  // ── Grid store (TRI-3248) ──────────────────────────────────────────────────
  // The five grid repos' Test Layers share ONE mutable store so cross-repo
  // effects (a TableRepo delete cascades to its columns/rows/cells, a RowRepo
  // insert is visible to CellRepo) hold exactly like the live FK-cascaded tables.
  // Distinct keys from the webhook worker grid fixtures (tables/columns/rows/cells
  // above) which back a DIFFERENT repo (WebhookRepo) with a narrower projection.
  /** Projects visible to {@link ProjectRepo} (MUTATED by createProject). */
  readonly gridProjects?: StoreProject[];
  /** Tables visible to {@link TableRepo} (MUTATED by create/deleteTable). */
  readonly gridTables?: StoreTable[];
  /** Sidebar folders visible to {@link FolderRepo} (MUTATED by folder CRUD). */
  readonly gridFolders?: StoreFolder[];
  /** Columns visible to {@link ColumnRepo} (MUTATED by addColumn/delete). */
  readonly gridColumns?: StoreColumn[];
  /** Rows visible to {@link RowRepo} (MUTATED by addRow(s)/delete). */
  readonly gridRows?: StoreRow[];
  /** Cells visible to {@link CellRepo} (MUTATED by setCell/bulk import). */
  readonly gridCells?: StoreCell[];
  /**
   * Per-workspace cloud-actions quota the {@link MeterService} reads + bumps
   * (MUTATED by meterActions). Keyed by workspace id; a test reads it back to
   * assert the exact `cloudActionsUsed` increment / bulk pre-check.
   */
  readonly meterQuotas?: Map<string, MeterQuota>;
  /**
   * Records every grid change event the {@link RealtimePublisher} publishes
   * (TRI-3251), shared by reference so a test asserts that a grid mutation
   * broadcast the expected typed event — no Supabase, no network.
   */
  readonly realtimeEvents?: RecordedGridEvent[];
}

/**
 * Promote authz {@link Membership} fixtures to {@link MemberWithUser} rows when a
 * test only configured `memberships`, so the roster/count reads agree with the
 * membership guard. Synthesises a stable id + createdAt and null name/email.
 */
const membershipsToMemberRows = (
  memberships: readonly Membership[],
): readonly MemberWithUser[] =>
  memberships.map((m, i) => ({
    id: `mem_fixture_${i}`,
    workspaceId: m.workspaceId,
    userId: m.userId,
    role: m.role,
    createdAt: i,
    name: null,
    email: null,
    image: null,
  }));

/**
 * The in-memory composition. Wires every service to its Test Layer from the
 * given fixtures — no {@link DbClient}, no live connection. Provide this in
 * place of {@link appLayer} (e.g. in the tRPC test context) to run the exact
 * same procedures against deterministic data.
 */
export const TestLayer = (
  fixtures: TestLayerFixtures = {},
): Layer.Layer<AppServices> => {
  const memberships = fixtures.memberships ?? [];
  const memberRows = fixtures.members ?? membershipsToMemberRows(memberships);
  const fixtureUsers = fixtures.users ?? [];

  const workspaceRepo = workspaceRepoLayer(
    fixtures.workspaces ?? [],
    fixtureUsers.map((u) => ({
      id: u.id,
      name: u.name ?? null,
      email: u.email ?? null,
      image: u.image ?? null,
    })),
  );
  const webhookRepo = webhookRepoLayer({
    webhooks: fixtures.webhooks,
    tables: fixtures.tables,
    columns: fixtures.columns,
    rows: fixtures.rows,
    cells: fixtures.cells,
    quotas: fixtures.quotas,
    credentials: fixtures.webhookCredentials,
  });
  const webhookDeliveryRepo = webhookDeliveryRepoLayer(
    fixtures.deliveries ?? [],
  );
  const extensionRepo = extensionRepoLayer(fixtures.extensions ?? []);
  const credentialRepo = credentialRepoLayer(fixtures.credentials ?? []);
  // ONE shared grid store so the five grid repos see consistent data and a table
  // delete cascades to its children, exactly like the live FK-cascaded tables.
  const gridStore: GridStore = makeGridStore({
    projects: fixtures.gridProjects,
    tables: fixtures.gridTables,
    folders: fixtures.gridFolders,
    columns: fixtures.gridColumns,
    rows: fixtures.gridRows,
    cells: fixtures.gridCells,
  });
  const projectRepo = projectRepoLayer(gridStore);
  const pipelineRepo = pipelineRepoLayer({
    pipelines: fixtures.pipelines,
    versions: fixtures.pipelineVersions,
    bindings: fixtures.pipelineBindings,
    runs: fixtures.pipelineRuns,
    tableWorkspaces: new Map(
      (fixtures.gridTables ?? []).map((table) => [table.id, table.workspaceId]),
    ),
    cloudActions: fixtures.pipelineCloudActions,
    actionReceipts: fixtures.pipelineActionReceipts,
  });
  const tableRepo = tableRepoLayer(gridStore);
  const folderRepo = folderRepoLayer(gridStore);
  const columnRepo = columnRepoLayer(gridStore);
  const rowRepo = rowRepoLayer(gridStore);
  const cellRepo = cellRepoLayer(gridStore);
  const meterService = meterServiceLayer(
    fixtures.meterQuotas ?? new Map<string, MeterQuota>(),
  );
  // The recording realtime publisher — captures published events into the shared
  // fixture array instead of broadcasting, so grid mutations are asserted offline.
  const realtimePublisher = recordingRealtimePublisherLayer(
    fixtures.realtimeEvents ?? [],
  );
  // ONE shared member store backs both the data repo and the authz guard, so a
  // membership inserted via WorkspaceMemberRepo (e.g. createWorkspace's owner
  // row) is immediately visible to MembershipService — as in the live table.
  const { workspaceMemberRepo, memberRepo } = memberStoreLayers(memberRows);
  const identity = cloudIdentityLayer(fixtures.currentUserId ?? null);
  const autumn = fakeAutumnLayer(fixtures.autumn ?? {});

  const invitationWorkspaces =
    fixtures.invitationWorkspaces ??
    (fixtures.workspaces ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      ownerId: w.ownerId,
    }));
  const invitationRepo = invitationRepoLayer({
    invitations: fixtures.invitations,
    members: fixtures.memberships,
    workspaces: invitationWorkspaces,
    users: fixtureUsers.map((u) => ({
      id: u.id,
      name: u.name ?? null,
      email: u.email ?? "",
    })),
  });
  const inviteEmail: Layer.Layer<InviteEmailPort> = inviteEmailPortLayer({
    sent: fixtures.emailsSent ?? [],
    delivered: fixtures.emailDelivered,
  });
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identity),
    Layer.provide(memberRepo),
  );
  const seatsService = SeatsService.Default.pipe(Layer.provide(autumn));
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(workspaceMemberRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(autumn),
    Layer.provide(pipelineRepo),
  );
  const billingService = BillingService.Default.pipe(
    Layer.provide(membershipService),
    Layer.provide(workspaceRepo),
    Layer.provide(workspaceMemberRepo),
    Layer.provide(seatsService),
    Layer.provide(autumn),
  );
  const invitationService = InvitationService.Default.pipe(
    Layer.provide(invitationRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(identity),
    Layer.provide(inviteEmail),
  );
  // Real AES-256-GCM under a fixed test master key — round-trips run genuine
  // crypto offline, no env, no DB.
  const cryptoService = cryptoServiceLayer();
  const credentialService = CredentialService.Default.pipe(
    Layer.provide(credentialRepo),
    Layer.provide(cryptoService),
    Layer.provide(membershipService),
    Layer.provide(CredentialOwnershipService.Default),
  );
  const attioAuth = AttioAuth.Default;
  const attioClient = AttioClient.Default.pipe(Layer.provide(attioAuth));
  const hubspotAuth = HubspotAuth.Default;
  const hubspotClient = HubspotClient.Default.pipe(Layer.provide(hubspotAuth));
  const crmClientRegistry = CrmClientRegistry.Default.pipe(Layer.provide(attioClient), Layer.provide(hubspotClient));
  const crmAuthRegistry = CrmAuthRegistry.Default.pipe(Layer.provide(attioAuth), Layer.provide(hubspotAuth));
  const crmConnectionService = CrmConnectionService.Default.pipe(
    Layer.provide(credentialService),
    Layer.provide(credentialRepo),
    Layer.provide(cryptoService),
    Layer.provide(crmAuthRegistry),
  );
  const entitlementService = EntitlementService.Default.pipe(
    Layer.provide(workspaceRepo),
  );
  const webhookService = WebhookService.Default.pipe(
    Layer.provide(webhookRepo),
    Layer.provide(webhookDeliveryRepo),
    Layer.provide(membershipService),
    Layer.provide(CellMerge.Default),
    Layer.provide(fixtures.crypto ?? credentialCryptoTest()),
    Layer.provide(entitlementService),
    Layer.provide(columnRepo),
    Layer.provide(realtimePublisher),
  );
  const extensionService = ExtensionService.Default.pipe(
    Layer.provide(extensionRepo),
    Layer.provide(membershipService),
  );
  const signalRepo = signalRepoLayer({ bindings: fixtures.signalBindings });
  const crmBindingRepo = crmBindingRepoLayer({ bindings: fixtures.crmBindings });
  const crmSyncedRowRepo = crmSyncedRowRepoLayer({ entries: fixtures.crmSyncedRows });
  const crmSyncRunRepo = crmSyncRunRepoLayer({ runs: fixtures.crmSyncRuns });
  const crmSyncService = CrmSyncService.Default.pipe(
    Layer.provide(crmBindingRepo),
    Layer.provide(crmSyncedRowRepo),
    Layer.provide(crmSyncRunRepo),
    Layer.provide(webhookRepo),
    Layer.provide(columnRepo),
    Layer.provide(crmClientRegistry),
    Layer.provide(crmConnectionService),
    Layer.provide(membershipService),
    Layer.provide(entitlementService),
    Layer.provide(workspaceRepo),
    Layer.provide(realtimePublisher),
  );
  const lifecycleEmailRepo = lifecycleEmailRepoLayer({
    users: (fixtures.users ?? []).flatMap((u) =>
      u.email ? [{ id: u.id, email: u.email, name: u.name ?? null }] : [],
    ),
  });
  const lifecycleCronRepo = lifecycleCronRepoLayer();
  const signalService = SignalService.Default.pipe(
    Layer.provide(signalRepo),
    Layer.provide(webhookRepo),
    Layer.provide(credentialService),
    Layer.provide(fixtures.crypto ?? credentialCryptoTest()),
    Layer.provide(membershipService),
    Layer.provide(entitlementService),
  );
  const shareRepo = shareRepoLayer({
    shares: fixtures.shares,
    tables: (fixtures.gridTables ?? []).map((t) => ({
      id: t.id,
      workspaceId: t.workspaceId,
    })),
  });
  const gridService = GridService.Default.pipe(
    Layer.provide(projectRepo),
    Layer.provide(tableRepo),
    Layer.provide(folderRepo),
    Layer.provide(columnRepo),
    Layer.provide(rowRepo),
    Layer.provide(cellRepo),
    Layer.provide(CellMerge.Default),
    Layer.provide(membershipService),
    Layer.provide(meterService),
    Layer.provide(realtimePublisher),
    Layer.provide(entitlementService),
    Layer.provide(pipelineRepo),
    Layer.provide(shareRepo),
  );
  const shareService = ShareService.Default.pipe(
    Layer.provide(shareRepo),
    Layer.provide(gridService),
    Layer.provide(membershipService),
    Layer.provide(identity),
  );
  const pipelineService = PipelineService.Default.pipe(
    Layer.provide(pipelineRepo),
    Layer.provide(projectRepo),
    Layer.provide(membershipService),
    Layer.provide(identity),
    Layer.provide(realtimePublisher),
  );
  return Layer.mergeAll(
    workspaceService,
    billingService,
    invitationService,
    credentialService,
    webhookService,
    extensionService,
    signalService,
    signalRepo,
    crmBindingRepo,
    crmSyncedRowRepo,
    crmSyncRunRepo,
    attioAuth,
    attioClient,
    hubspotAuth,
    hubspotClient,
    crmClientRegistry,
    crmAuthRegistry,
    crmConnectionService,
    crmSyncService,
    gridService,
    shareService,
    shareRepo,
    pipelineService,
    pipelineRepo,
    entitlementService,
    workspaceRepo,
    lifecycleEmailRepo,
    lifecycleCronRepo,
    workspaceMemberRepo,
    invitationRepo,
    credentialRepo,
    webhookRepo,
    webhookDeliveryRepo,
    extensionRepo,
    projectRepo,
    tableRepo,
    folderRepo,
    columnRepo,
    rowRepo,
    cellRepo,
    meterService,
    realtimePublisher,
    membershipService,
    seatsService,
    autumn,
    cryptoService,
  );
};

/** The full set of services any Effect program in the cloud tier can resolve. */
export type AppServices =
  | WorkspaceService
  | WorkspaceRepo
  | WorkspaceMemberRepo
  | MembershipService
  | SeatsService
  | BillingService
  | AutumnClient
  | InvitationService
  | InvitationRepo
  | CredentialService
  | CredentialRepo
  | CryptoService
  | WebhookService
  | WebhookRepo
  | WebhookDeliveryRepo
  | SignalService
  | SignalRepo
  | CrmBindingRepo
  | CrmSyncedRowRepo
  | CrmSyncRunRepo
  | AttioAuth
  | AttioClient
  | HubspotAuth
  | HubspotClient
  | CrmClientRegistry
  | CrmAuthRegistry
  | CrmConnectionService
  | CrmSyncService
  | ExtensionService
  | ExtensionRepo
  | GridService
  | ShareService
  | ShareRepo
  | PipelineService
  | PipelineRepo
  | EntitlementService
  | ProjectRepo
  | TableRepo
  | FolderRepo
  | ColumnRepo
  | RowRepo
  | CellRepo
  | MeterService
  | RealtimePublisher
  | LifecycleEmailRepo
  | LifecycleCronRepo;
