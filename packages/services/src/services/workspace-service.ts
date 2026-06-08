/**
 * `WorkspaceService` — the WORKED-EXAMPLE domain service proving the
 * service-over-repository pattern end-to-end.
 *
 * Where a REPOSITORY is the raw table adapter, a SERVICE composes one or more
 * repositories (and other services) into a domain operation with the business
 * rules attached. This one exposes `getWorkspace`, which:
 *
 *   1. Asserts the caller is a member of the workspace via the ported authz
 *      core (`MembershipService.requireMember`, the Effect port of
 *      convex/model/auth.ts:162) — so a non-member is rejected BEFORE any data
 *      is returned.
 *   2. Loads the workspace through {@link WorkspaceRepo}, failing with
 *      {@link WorkspaceNotFoundError} when it does not exist.
 *
 * It is defined with the `Effect.Service` pattern (Tag + Layer in one) and
 * declares its dependencies; the composed {@link AppLayer} wires the live
 * implementations, while tests provide in-memory repo/identity Layers and get
 * the SAME service with different behaviour — the DI seam the AC requires.
 *
 * See packages/engine/src/sample-service.ts for the canonical shape.
 */

import {
  type AutumnError,
  type InsufficientRoleError,
  type Membership,
  MembershipService,
  type MemberRepoError,
  type MemberRole,
  type NotAMemberError,
  planName,
  type SeatLimitExceededError,
  SeatsService,
  TEAM_PLAN_ID,
  TRIAL_DURATION_DAYS,
  type UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Data, Effect, Option } from "effect";
import {
  type MemberWithUser,
  WorkspaceMemberRepo,
  type WorkspaceMemberRepoError,
} from "../repositories/workspace-member-repo.js";
import {
  type Workspace,
  WorkspaceRepo,
  type WorkspaceRepoError,
} from "../repositories/workspace-repo.js";

/** Seat usage for a workspace: members used vs. the plan limit (null = free). */
export interface SeatUsage {
  readonly used: number;
  readonly limit: number | null;
}

/** The workspace's current plan (the paid plan id + human name). */
export interface WorkspacePlan {
  readonly id: string | null;
  readonly name: string;
  /** Epoch ms the trial ends, or null when not trialing. Drives the countdown. */
  readonly trialEndsAt: number | null;
}

/**
 * A workspace the signed-in user belongs to, as the `me` query returns it.
 * Mirrors the desktop `WorkspaceSummary` (packages/desktop/src/cloud/auth.ts:52)
 * EXACTLY so `useMe` binds without a shape change.
 */
export interface MeWorkspace {
  readonly _id: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly seatUsage: SeatUsage;
  readonly plan: WorkspacePlan;
  readonly cloudActions: SeatUsage;
}

/** The authenticated user as `me` returns it (auth.ts:68 `MeUser`). */
export interface MeUser {
  readonly _id: string;
  readonly name: string | null;
  readonly email: string | null;
}

/** The full `me` result (auth.ts:75 `Me`). */
export interface Me {
  readonly user: MeUser;
  readonly workspaces: readonly MeWorkspace[];
}

/** A single member as `listMembers` returns it (auth.ts:81 `WorkspaceMember`). */
export interface WorkspaceMember {
  readonly _id: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly createdAt: number;
  readonly name: string | null;
  readonly email: string | null;
}

/** The `listMembers` result (auth.ts:91 `WorkspaceMembers`). */
export interface WorkspaceMembersResult {
  readonly members: readonly WorkspaceMember[];
  readonly seatUsage: SeatUsage;
}

/**
 * Raised when an authorized caller requests a workspace that does not exist.
 * Distinct from the authz failures (`NotAMemberError`) so the procedure layer
 * can map it to a 404 rather than a 403.
 */
export class WorkspaceNotFoundError extends Data.TaggedError(
  "WorkspaceNotFoundError",
)<{
  readonly message: string;
  readonly workspaceId: string;
}> {}

/** The full error channel of {@link WorkspaceService.getWorkspace}. */
export type GetWorkspaceError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | WorkspaceRepoError
  | WorkspaceNotFoundError;

/** Error channel of {@link WorkspaceService.me}. */
export type MeError =
  | UnauthenticatedError
  | WorkspaceRepoError
  | WorkspaceMemberRepoError;

/** Error channel of {@link WorkspaceService.listMembers}. */
export type ListMembersError =
  | UnauthenticatedError
  | NotAMemberError
  | MemberRepoError
  | WorkspaceMemberRepoError;

/** Error channel of {@link WorkspaceService.createWorkspace}. */
export type CreateWorkspaceError =
  | UnauthenticatedError
  | WorkspaceRepoError
  | WorkspaceMemberRepoError;

/** Error channel of {@link WorkspaceService.insertMember}. */
export type InsertMemberError =
  | UnauthenticatedError
  | NotAMemberError
  | InsufficientRoleError
  | MemberRepoError
  | WorkspaceMemberRepoError
  | SeatLimitExceededError
  | AutumnError;

/** Result of {@link WorkspaceService.insertMember}: the id + whether it pre-existed. */
export interface InsertMemberResult {
  readonly memberId: string;
  readonly alreadyMember: boolean;
}

/** A roster entry mapped to the `me`/`listMembers` member shape. */
const toWorkspaceMember = (m: MemberWithUser): WorkspaceMember => ({
  _id: m.id,
  userId: m.userId,
  role: m.role,
  createdAt: m.createdAt,
  name: m.name,
  email: m.email,
});

/**
 * Workspace domain service. Composes {@link WorkspaceRepo} +
 * {@link MembershipService} into membership-guarded workspace reads.
 */
export class WorkspaceService extends Effect.Service<WorkspaceService>()(
  "WorkspaceService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* WorkspaceRepo;
      const memberRepo = yield* WorkspaceMemberRepo;
      const membership = yield* MembershipService;
      const seats = yield* SeatsService;

      /**
       * Return the workspace for a caller who is a MEMBER of it. Fails with the
       * typed authz errors when the caller is signed out / not a member, and
       * with {@link WorkspaceNotFoundError} when the workspace is missing.
       */
      const getWorkspace = (
        workspaceId: string,
      ): Effect.Effect<Workspace, GetWorkspaceError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const found = yield* repo.findById(workspaceId);
          if (found._tag === "None") {
            return yield* Effect.fail(
              new WorkspaceNotFoundError({
                message: `Workspace ${workspaceId} not found.`,
                workspaceId,
              }),
            );
          }
          return found.value;
        });

      /**
       * Like {@link getWorkspace} but additionally requires the caller's role to
       * be one of `roles` (ports `requireRole`, convex/model/auth.ts:180). The
       * returned {@link Membership} carries the asserted role.
       */
      const requireWorkspaceRole = (
        workspaceId: string,
        roles: readonly MemberRole[],
      ): Effect.Effect<
        Membership,
        | UnauthenticatedError
        | NotAMemberError
        | InsufficientRoleError
        | MemberRepoError
      > => membership.requireRole(workspaceId, roles);

      /**
       * The current user + their workspaces + seat/cloud-actions/plan usage —
       * the `me` query (convex/workspaces.ts:48). Fails with
       * {@link UnauthenticatedError} when signed out (the procedure maps it to
       * `null` for the UI's local/sign-in state).
       *
       * BATCHED, no N+1 (ports the Promise.all in convex/workspaces.ts:65): one
       * `listByUser` read for the memberships, then ONE `findManyByIds` for the
       * workspace docs and ONE grouped `countByWorkspaceIds` for seat usage —
       * three queries total regardless of how many workspaces the user has.
       *
       * cloudActions + plan are read from the workspace's cached columns
       * (`cloudActionsUsed`/`cloudActionsLimit`/`currentPlanId`) — NO outbound
       * HTTP — keeping the `cloudActionsUsed/Limit` semantics the metering
       * mandate preserves.
       */
      const me = (): Effect.Effect<Me, MeError> =>
        Effect.gen(function* () {
          const userId = yield* membership.requireUserId;
          const memberships = yield* memberRepo.listByUser(userId);
          const workspaceIds = memberships.map((m) => m.workspaceId);
          const [userOpt, workspaceDocs, counts] = yield* Effect.all([
            repo.findUser(userId),
            repo.findManyByIds(workspaceIds),
            memberRepo.countByWorkspaceIds(workspaceIds),
          ]);
          const byId = new Map(workspaceDocs.map((w) => [w.id, w]));

          const workspaces = memberships.flatMap((m): readonly MeWorkspace[] => {
            const ws = byId.get(m.workspaceId);
            if (ws === undefined) return [];
            const planId = ws.currentPlanId ?? null;
            return [
              {
                _id: ws.id,
                name: ws.name,
                role: m.role,
                seatUsage: { used: counts.get(ws.id) ?? 0, limit: null },
                cloudActions: {
                  used: ws.cloudActionsUsed ?? 0,
                  limit: ws.cloudActionsLimit ?? null,
                },
                plan: {
                  id: planId,
                  name: planName(planId),
                  trialEndsAt: ws.trialEndsAt ?? null,
                },
              },
            ];
          });

          return {
            user: {
              _id: userId,
              name: Option.match(userOpt, {
                onNone: () => null,
                onSome: (u) => u.name,
              }),
              email: Option.match(userOpt, {
                onNone: () => null,
                onSome: (u) => u.email,
              }),
            },
            workspaces,
          };
        });

      /**
       * The members of a workspace + seat usage — the `listMembers` query
       * (convex/workspaces.ts:136). Authz: caller MUST be a member (a user never
       * sees a foreign roster). Members are ordered oldest-first (the owner
       * leads), exactly like the source.
       */
      const listMembers = (
        workspaceId: string,
      ): Effect.Effect<WorkspaceMembersResult, ListMembersError> =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const rows = yield* memberRepo.listByWorkspace(workspaceId);
          const members = rows
            .map(toWorkspaceMember)
            .sort((a, b) => a.createdAt - b.createdAt);
          return {
            members,
            seatUsage: { used: members.length, limit: null },
          };
        });

      /**
       * Create a workspace owned by the caller, inserting the OWNER membership in
       * the same operation — the `createWorkspace` mutation
       * (convex/workspaces.ts:178). Requires authentication. Returns the new id.
       */
      const createWorkspace = (
        name: string,
      ): Effect.Effect<string, CreateWorkspaceError> =>
        Effect.gen(function* () {
          const userId = yield* membership.requireUserId;
          const now = Date.now();
          const workspaceId = yield* repo.insert({
            name,
            ownerId: userId,
            createdAt: now,
          });
          yield* memberRepo.insert({
            workspaceId,
            userId,
            role: "owner",
            createdAt: now,
          });
          // Start the Team free trial so the brand-new workspace can invite
          // teammates from day one (least-friction onboarding). Best-effort: a
          // billing hiccup (Autumn down / misconfigured) must NOT fail workspace
          // creation — the next plan sync re-establishes the real state.
          yield* Effect.gen(function* () {
            const customerData = yield* repo.findCustomerData(workspaceId);
            yield* seats.startTrial(workspaceId, customerData);
            // Reflect the trial entitlement immediately so the workspace isn't
            // locked between creation and the first plan sync (the cloud gate
            // reads currentPlanId). Seed trialEndsAt = now + trial days so the
            // countdown banner + reminder scan work right away; syncPlan
            // reconciles the exact id + Autumn trial end later.
            yield* repo.updatePlan(
              workspaceId,
              TEAM_PLAN_ID,
              now + TRIAL_DURATION_DAYS * 86_400_000,
            );
          }).pipe(Effect.catchAll(() => Effect.void));
          return workspaceId;
        });

      /**
       * Add a member to a workspace with the TRANSACTIONAL seat ceiling — ports
       * `insertMember` (convex/workspaces.ts:212). Authz: owner/admin only. Re-
       * reads the LIVE member count and runs the pure
       * {@link SeatsService.enforceSeatCeiling} against `seatCeiling` BEFORE the
       * insert, so two concurrent invites cannot both pass and overshoot the
       * limit. Idempotent: a re-invite of an existing member returns
       * `alreadyMember: true` with no new row and no seat consumed.
       *
       * `seatCeiling` is the absolute cap (members-at-check-time + Autumn free
       * balance) the caller derived; `null` = unlimited.
       */
      const insertMember = (args: {
        readonly workspaceId: string;
        readonly userId: string;
        readonly role: MemberRole;
        readonly seatCeiling: number | null;
      }): Effect.Effect<InsertMemberResult, InsertMemberError> =>
        Effect.gen(function* () {
          yield* membership.requireRole(args.workspaceId, ["owner", "admin"]);
          const existing = yield* memberRepo.findByWorkspaceUser(
            args.workspaceId,
            args.userId,
          );
          if (existing._tag === "Some") {
            return { memberId: existing.value.id, alreadyMember: true };
          }
          const currentCount = yield* memberRepo.countByWorkspace(
            args.workspaceId,
          );
          yield* seats.enforceSeatCeiling(currentCount, args.seatCeiling);
          const memberId = yield* memberRepo.insert({
            workspaceId: args.workspaceId,
            userId: args.userId,
            role: args.role,
            createdAt: Date.now(),
          });
          return { memberId, alreadyMember: false };
        });

      return {
        getWorkspace,
        requireWorkspaceRole,
        me,
        listMembers,
        createWorkspace,
        insertMember,
      } as const;
    }),
    // MembershipService + WorkspaceRepo must be provided before this service is
    // built; AppLayer (or a TestLayer) supplies them.
    dependencies: [],
  },
) {}
