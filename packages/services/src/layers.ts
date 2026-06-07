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
  CellMerge,
  identityLayer as cloudIdentityLayer,
  memberRepoLayer as cloudMemberRepoLayer,
  type CredentialCryptoService,
  Identity,
  type MemberRepo,
  type Membership,
  MembershipService,
} from "@gtmgrid/cloud";
import type { Db } from "@gtmgrid/db/client";
import { Effect, Layer, Option } from "effect";
import { credentialCryptoLive } from "./credential-crypto.js";
import { credentialCryptoTest } from "./credential-crypto-test.js";
import { dbClientLayer } from "./db-client.js";
import {
  type Extension,
  ExtensionRepo,
  ExtensionRepoLive,
  extensionRepoLayer,
} from "./repositories/extension-repo.js";
import { MemberRepoLive } from "./repositories/member-repo.js";
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
import { ExtensionService } from "./services/extension-service.js";
import { WebhookService } from "./services/webhook-service.js";
import {
  type Workspace,
  WorkspaceRepo,
  WorkspaceRepoLive,
  workspaceRepoLayer,
} from "./repositories/workspace-repo.js";
import { WorkspaceService } from "./services/workspace-service.js";

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
}): Layer.Layer<AppServices> => {
  const dbLayer = dbClientLayer(params.db);
  const memberRepo = MemberRepoLive.pipe(Layer.provide(dbLayer));
  const workspaceRepo = WorkspaceRepoLive.pipe(Layer.provide(dbLayer));
  const webhookRepo = WebhookRepoLive.pipe(Layer.provide(dbLayer));
  const webhookDeliveryRepo = WebhookDeliveryRepoLive.pipe(
    Layer.provide(dbLayer),
  );
  const extensionRepo = ExtensionRepoLive.pipe(Layer.provide(dbLayer));
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identityFromUserId(params.userId)),
    Layer.provide(memberRepo),
  );
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(membershipService),
  );
  const webhookService = WebhookService.Default.pipe(
    Layer.provide(webhookRepo),
    Layer.provide(webhookDeliveryRepo),
    Layer.provide(membershipService),
    Layer.provide(CellMerge.Default),
    Layer.provide(credentialCryptoLive),
  );
  const extensionService = ExtensionService.Default.pipe(
    Layer.provide(extensionRepo),
    Layer.provide(membershipService),
  );
  // Merge so callers can resolve any repo or domain service from one Layer.
  return Layer.mergeAll(
    workspaceService,
    workspaceRepo,
    membershipService,
    webhookService,
    webhookRepo,
    webhookDeliveryRepo,
    extensionService,
    extensionRepo,
  );
};

/** Fixtures for {@link TestLayer}: the in-memory data the services read. */
export interface TestLayerFixtures {
  /** Workspaces visible to {@link WorkspaceRepo}. */
  readonly workspaces?: readonly Workspace[];
  /** Membership rows visible to the authz core. */
  readonly memberships?: readonly Membership[];
  /** The current caller's user id, or `null` for an unauthenticated request. */
  readonly currentUserId?: string | null;
  /** Webhooks visible to {@link WebhookRepo} (MUTATED by insert/patch/delete). */
  readonly webhooks?: Webhook[];
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
  /** Shared-credential ciphertext keyed `${workspaceId}:${extensionId}`. */
  readonly credentials?: Map<string, string>;
  /** Delivery-log rows (MUTATED by recordDelivery + the 50-row prune). */
  readonly deliveries?: WebhookDelivery[];
  /** Installed extensions (MUTATED by saveExtension). */
  readonly extensions?: Extension[];
  /** Override the crypto service (defaults to the deterministic test layer). */
  readonly crypto?: Layer.Layer<CredentialCryptoService>;
}

/**
 * The in-memory composition. Wires every service to its Test Layer from the
 * given fixtures — no {@link DbClient}, no live connection. Provide this in
 * place of {@link appLayer} (e.g. in the tRPC test context) to run the exact
 * same procedures against deterministic data.
 */
export const TestLayer = (
  fixtures: TestLayerFixtures = {},
): Layer.Layer<AppServices> => {
  const workspaceRepo = workspaceRepoLayer(fixtures.workspaces ?? []);
  const webhookRepo = webhookRepoLayer({
    webhooks: fixtures.webhooks,
    tables: fixtures.tables,
    columns: fixtures.columns,
    rows: fixtures.rows,
    cells: fixtures.cells,
    quotas: fixtures.quotas,
    credentials: fixtures.credentials,
  });
  const webhookDeliveryRepo = webhookDeliveryRepoLayer(fixtures.deliveries ?? []);
  const extensionRepo = extensionRepoLayer(fixtures.extensions ?? []);
  const memberRepo: Layer.Layer<MemberRepo> = cloudMemberRepoLayer(
    fixtures.memberships ?? [],
  );
  const identity = cloudIdentityLayer(fixtures.currentUserId ?? null);
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identity),
    Layer.provide(memberRepo),
  );
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(membershipService),
  );
  const webhookService = WebhookService.Default.pipe(
    Layer.provide(webhookRepo),
    Layer.provide(webhookDeliveryRepo),
    Layer.provide(membershipService),
    Layer.provide(CellMerge.Default),
    Layer.provide(fixtures.crypto ?? credentialCryptoTest()),
  );
  const extensionService = ExtensionService.Default.pipe(
    Layer.provide(extensionRepo),
    Layer.provide(membershipService),
  );
  return Layer.mergeAll(
    workspaceService,
    workspaceRepo,
    membershipService,
    webhookService,
    webhookRepo,
    webhookDeliveryRepo,
    extensionService,
    extensionRepo,
  );
};

/** The full set of services any Effect program in the cloud tier can resolve. */
export type AppServices =
  | WorkspaceService
  | WorkspaceRepo
  | MembershipService
  | WebhookService
  | WebhookRepo
  | WebhookDeliveryRepo
  | ExtensionService
  | ExtensionRepo;
