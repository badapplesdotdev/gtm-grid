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
  SeatsService,
  SEATS_FEATURE_ID,
  TEAM_PLAN_ID,
  type SeatCheck,
} from "./seats.js";

export {
  type FakeAutumnConfig,
  failingAutumnLayer,
  fakeAutumnLayer,
} from "./seats-test-layers.js";
