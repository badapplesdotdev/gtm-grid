/**
 * `EntitlementService.requireCloudAccess` — the cloud-access gate.
 *
 * OFFLINE against an in-memory `WorkspaceRepo`: a workspace with a paid/trial
 * `currentPlanId` passes; a Free (null) or missing workspace fails with
 * {@link PlanRequiredError}.
 */

import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Workspace,
  workspaceRepoLayer,
} from "../repositories/workspace-repo.js";
import { EntitlementService, PlanRequiredError } from "./entitlement-service.js";

const WS = "ws-1";
const ws = (
  currentPlanId: string | null,
  trialEndsAt: number | null = null,
): Workspace => ({
  id: WS,
  name: "WS",
  ownerId: "owner",
  currentPlanId,
  trialEndsAt,
});

const DAY = 86_400_000;

const run = (workspaces: readonly Workspace[], workspaceId = WS) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* EntitlementService;
      return yield* svc.requireCloudAccess(workspaceId);
    }).pipe(
      Effect.provide(
        EntitlementService.Default.pipe(
          Layer.provide(workspaceRepoLayer(workspaces)),
        ),
      ),
    ),
  );

const failure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit)
    ? (Cause.failureOption(exit.cause) as { value?: E }).value
    : undefined;

describe("EntitlementService.requireCloudAccess", () => {
  it("allows a workspace on a paid/trial plan", async () => {
    const exit = await run([ws("team")]);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("allows annual paid plans too", async () => {
    const exit = await run([ws("business_annual")]);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("blocks a Free workspace (null plan) with PlanRequiredError", async () => {
    const exit = await run([ws(null)]);
    expect(failure(exit)).toBeInstanceOf(PlanRequiredError);
  });

  it("blocks a missing workspace with PlanRequiredError", async () => {
    const exit = await run([]);
    expect(failure(exit)).toBeInstanceOf(PlanRequiredError);
  });

  it("allows an active trial (trialEndsAt in the future)", async () => {
    const exit = await run([ws("team", Date.now() + DAY)]);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("BLOCKS a trial lapsed by date even when currentPlanId is still set", async () => {
    // The core backstop: a workspace whose trial end has passed must be rejected
    // immediately, before Autumn syncs `currentPlanId` to null.
    const exit = await run([ws("team", Date.now() - DAY)]);
    expect(failure(exit)).toBeInstanceOf(PlanRequiredError);
  });

  it("blocks a lapsed trial whose plan id also synced to null", async () => {
    const exit = await run([ws(null, Date.now() - DAY)]);
    expect(failure(exit)).toBeInstanceOf(PlanRequiredError);
  });
});
