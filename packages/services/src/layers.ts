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
  identityLayer as cloudIdentityLayer,
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
import { dbClientLayer } from "./db-client.js";
import {
  type CredentialRow,
  CredentialRepo,
  CredentialRepoLive,
  credentialRepoLayer,
} from "./repositories/credential-repo.js";
import {
  type Invitation,
  type InMemoryWorkspace,
  InvitationRepo,
  InvitationRepoLive,
  invitationRepoLayer,
} from "./repositories/invitation-repo.js";
import { MemberRepoLive } from "./repositories/member-repo.js";
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
> => {
  const dbLayer = dbClientLayer(params.db);
  const identity = identityFromUserId(params.userId);
  const memberRepo = MemberRepoLive.pipe(Layer.provide(dbLayer));
  const workspaceRepo = WorkspaceRepoLive.pipe(Layer.provide(dbLayer));
  const workspaceMemberRepo = WorkspaceMemberRepoLive.pipe(
    Layer.provide(dbLayer),
  );
  const invitationRepo = InvitationRepoLive.pipe(Layer.provide(dbLayer));
  const credentialRepo = CredentialRepoLive.pipe(Layer.provide(dbLayer));
  const membershipService = MembershipService.Default.pipe(
    Layer.provide(identity),
    Layer.provide(memberRepo),
  );
  // SeatsService is provided to BOTH the workspace service (transactional seat
  // ceiling on insertMember) and the billing service (checkout). One Autumn port
  // (the live, lazily-built SDK) backs it.
  const seatsService = SeatsService.Default.pipe(
    Layer.provide(AutumnClientLive),
  );
  const workspaceService = WorkspaceService.Default.pipe(
    Layer.provide(workspaceRepo),
    Layer.provide(workspaceMemberRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
  );
  const billingService = BillingService.Default.pipe(
    Layer.provide(membershipService),
    Layer.provide(workspaceRepo),
    Layer.provide(seatsService),
  );
  const invitationService = InvitationService.Default.pipe(
    Layer.provide(invitationRepo),
    Layer.provide(membershipService),
    Layer.provide(seatsService),
    Layer.provide(identity),
    Layer.provide(InviteEmailPortLive),
  );
  const credentialService = CredentialService.Default.pipe(
    Layer.provide(credentialRepo),
    Layer.provide(CryptoServiceLive),
    Layer.provide(membershipService),
    Layer.provide(CredentialOwnershipService.Default),
  );
  // Merge so callers can resolve any repo or service from one Layer.
  return Layer.mergeAll(
    workspaceService,
    billingService,
    invitationService,
    credentialService,
    workspaceRepo,
    workspaceMemberRepo,
    invitationRepo,
    credentialRepo,
    membershipService,
    seatsService,
    AutumnClientLive,
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
  }));

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
> => {
  const memberships = fixtures.memberships ?? [];
  const memberRows = fixtures.members ?? membershipsToMemberRows(memberships);
  const fixtureUsers = fixtures.users ?? [];

  const workspaceRepo = workspaceRepoLayer(
    fixtures.workspaces ?? [],
    fixtureUsers.map((u) => ({
      id: u.id,
      name: u.name ?? null,
      email: u.email ?? null,
    })),
  );
  const credentialRepo = credentialRepoLayer(fixtures.credentials ?? []);
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
  );
  const billingService = BillingService.Default.pipe(
    Layer.provide(membershipService),
    Layer.provide(workspaceRepo),
    Layer.provide(seatsService),
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
  return Layer.mergeAll(
    workspaceService,
    billingService,
    invitationService,
    credentialService,
    workspaceRepo,
    workspaceMemberRepo,
    invitationRepo,
    credentialRepo,
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
  | CryptoService;
