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
  identityLayer as cloudIdentityLayer,
  memberRepoLayer as cloudMemberRepoLayer,
  type FakeAutumnConfig,
  fakeAutumnLayer,
  Identity,
  type MemberRepo,
  type Membership,
  MembershipService,
  SeatsService,
} from "@gtmgrid/cloud";
import type { Db } from "@gtmgrid/db/client";
import { Effect, Layer, Option } from "effect";
import { AutumnClientLive } from "./autumn-client.js";
import { dbClientLayer } from "./db-client.js";
import {
  type Invitation,
  type InMemoryUser,
  type InMemoryWorkspace,
  InvitationRepo,
  InvitationRepoLive,
  invitationRepoLayer,
} from "./repositories/invitation-repo.js";
import { MemberRepoLive } from "./repositories/member-repo.js";
import {
  type Workspace,
  WorkspaceRepo,
  WorkspaceRepoLive,
  workspaceRepoLayer,
} from "./repositories/workspace-repo.js";
import { InvitationService } from "./services/invitation-service.js";
import {
  type InviteEmailArgs,
  InviteEmailPort,
  InviteEmailPortLive,
  inviteEmailPortLayer,
} from "./services/invite-email.js";
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
}): Layer.Layer<
  | WorkspaceService
  | WorkspaceRepo
  | MembershipService
  | InvitationService
  | InvitationRepo
  | SeatsService
> => {
  const dbLayer = dbClientLayer(params.db);
  const identity = identityFromUserId(params.userId);
  const memberRepo = MemberRepoLive.pipe(Layer.provide(dbLayer));
  const workspaceRepo = WorkspaceRepoLive.pipe(Layer.provide(dbLayer));
  const invitationRepo = InvitationRepoLive.pipe(Layer.provide(dbLayer));
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identity),
    Layer.provide(memberRepo),
  );
  const seatsService: Layer.Layer<SeatsService> = SeatsService.Default.pipe(
    Layer.provide(AutumnClientLive),
  );
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(membershipService),
  );
  const invitationService = InvitationService.Default.pipe(
    Layer.provide(invitationRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(identity),
    Layer.provide(InviteEmailPortLive),
  );
  // Merge so callers can resolve any repo or service from one Layer.
  return Layer.mergeAll(
    workspaceService,
    workspaceRepo,
    membershipService,
    invitationService,
    invitationRepo,
    seatsService,
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
  /** Invitation rows visible to {@link InvitationRepo}. */
  readonly invitations?: readonly Invitation[];
  /**
   * Workspaces visible to {@link InvitationRepo} (name + owner). Defaults to
   * `workspaces` projected to (id, name, ownerId) when omitted, so the common
   * case needs only one list.
   */
  readonly invitationWorkspaces?: readonly InMemoryWorkspace[];
  /** Users visible to {@link InvitationRepo} (id + name + email). */
  readonly users?: readonly InMemoryUser[];
  /**
   * Autumn seat-check config the {@link SeatsService} reads. Defaults to a free
   * seat (`allowed: true`, unlimited balance), so the invite/accept happy path
   * needs no config.
   */
  readonly autumn?: FakeAutumnConfig;
  /** Records each invite email's args (the in-memory {@link InviteEmailPort}). */
  readonly emailsSent?: InviteEmailArgs[];
  /** Whether the in-memory email port reports delivery (default `true`). */
  readonly emailDelivered?: boolean;
}

/**
 * The in-memory composition. Wires every service to its Test Layer from the
 * given fixtures — no {@link DbClient}, no live connection. Provide this in
 * place of {@link appLayer} (e.g. in the tRPC test context) to run the exact
 * same procedures against deterministic data.
 */
export const TestLayer = (
  fixtures: TestLayerFixtures = {},
): Layer.Layer<
  | WorkspaceService
  | WorkspaceRepo
  | MembershipService
  | InvitationService
  | InvitationRepo
  | SeatsService
> => {
  const workspaceRepo = workspaceRepoLayer(fixtures.workspaces ?? []);
  const memberRepo: Layer.Layer<MemberRepo> = cloudMemberRepoLayer(
    fixtures.memberships ?? [],
  );
  const identity = cloudIdentityLayer(fixtures.currentUserId ?? null);
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
    users: fixtures.users,
  });
  const seatsService: Layer.Layer<SeatsService> = SeatsService.Default.pipe(
    Layer.provide(fakeAutumnLayer(fixtures.autumn ?? {})),
  );
  const inviteEmail: Layer.Layer<InviteEmailPort> = inviteEmailPortLayer({
    sent: fixtures.emailsSent ?? [],
    delivered: fixtures.emailDelivered,
  });
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identity),
    Layer.provide(memberRepo),
  );
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(membershipService),
  );
  const invitationService = InvitationService.Default.pipe(
    Layer.provide(invitationRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(identity),
    Layer.provide(inviteEmail),
  );
  return Layer.mergeAll(
    workspaceService,
    workspaceRepo,
    membershipService,
    invitationService,
    invitationRepo,
    seatsService,
  );
};

/** The full set of services any Effect program in the cloud tier can resolve. */
export type AppServices =
  | WorkspaceService
  | WorkspaceRepo
  | MembershipService
  | InvitationService
  | InvitationRepo
  | SeatsService;
