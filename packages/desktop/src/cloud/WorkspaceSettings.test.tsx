// @vitest-environment jsdom
/**
 * WorkspaceSettings — the roster's role controls.
 *
 * The parts worth pinning down are the ones a wrong guess would get subtly
 * wrong: WHO sees a role picker (owner only), that the owner's own row has none
 * (self-demotion is refused server-side — the UI shouldn't offer it), and that
 * promoting someone to owner confirms first, because it hands the workspace over
 * and demotes the person clicking.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateMemberRole = vi.hoisted(() => vi.fn(async () => {}));
const useMe = vi.hoisted(() => vi.fn());
const useMembers = vi.hoisted(() => vi.fn());
const runInvite = vi.hoisted(() => vi.fn(async () => ({ status: "invited" })));

vi.mock("./client", () => ({
  cloudEnabled: true,
  apiClient: { billing: { previewSeatChange: { query: vi.fn() } } },
}));
vi.mock("./auth", () => ({
  useAuthState: () => ({ isAuthenticated: true, isLoading: false }),
  useMe,
  useMembers,
  useUpdateMemberRole: () => updateMemberRole,
}));
vi.mock("./invite", () => ({ runInvite, useInviteLayer: () => ({}) }));
vi.mock("./checkout", () => ({
  runCheckout: vi.fn(),
  useCheckoutLayer: () => ({}),
}));
vi.mock("./useWorkspaceInvitations", () => ({
  usePendingInvitations: () => [],
  useRevokeInvitation: () => vi.fn(),
}));

const { WorkspaceSettings } = await import("./WorkspaceSettings");

const WS = "ws_1";
const OWNER = "user_owner";
const MEMBER = "user_member";

const roster = {
  members: [
    {
      _id: "m1",
      userId: OWNER,
      role: "owner" as const,
      createdAt: 1,
      name: "Olive",
      email: "olive@acme.com",
      image: null,
    },
    {
      _id: "m2",
      userId: MEMBER,
      role: "member" as const,
      createdAt: 2,
      name: "Mo",
      email: "mo@acme.com",
      image: null,
    },
  ],
  seatUsage: { used: 2, limit: 5 },
};

/** Sign in as `userId`, holding `role` in the workspace under test. */
const signedInAs = (userId: string, role: "owner" | "admin" | "member") => {
  useMe.mockReturnValue({
    user: { _id: userId, name: null, email: null, image: null },
    workspaces: [
      {
        _id: WS,
        name: "Acme",
        role,
        seatUsage: { used: 2, limit: 5 },
        plan: { id: "team", name: "Team", trialEndsAt: null },
        cloudActions: { used: 0, limit: 100 },
      },
    ],
  });
};

const renderSettings = () =>
  render(
    <WorkspaceSettings
      workspaceId={WS}
      workspaceName="Acme"
      onClose={() => {}}
    />,
  );

beforeEach(() => {
  useMembers.mockReturnValue(roster);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("the owner's roster", () => {
  it("offers a role picker for every OTHER member", async () => {
    signedInAs(OWNER, "owner");
    renderSettings();
    expect(screen.getByLabelText("Role for Mo")).toBeTruthy();
  });

  it("shows the owner their own role read-only — no self-demotion control", () => {
    signedInAs(OWNER, "owner");
    renderSettings();
    expect(screen.queryByLabelText("Role for Olive")).toBeNull();
  });

  it("promotes a member to admin", async () => {
    signedInAs(OWNER, "owner");
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText("Role for Mo"), "admin");
    await waitFor(() =>
      expect(updateMemberRole).toHaveBeenCalledWith(MEMBER, "admin"),
    );
  });
});

describe("transferring ownership", () => {
  it("confirms before handing the workspace over", async () => {
    signedInAs(OWNER, "owner");
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText("Role for Mo"), "owner");
    expect(window.confirm).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(updateMemberRole).toHaveBeenCalledWith(MEMBER, "owner"),
    );
  });

  it("does nothing when the confirmation is dismissed", async () => {
    signedInAs(OWNER, "owner");
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText("Role for Mo"), "owner");
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it("surfaces a rejected change instead of failing silently", async () => {
    signedInAs(OWNER, "owner");
    updateMemberRole.mockRejectedValueOnce(new Error("Seat limit reached."));
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText("Role for Mo"), "admin");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Seat limit reached.");
  });
});

describe("a non-owner's roster", () => {
  it("gives an admin no role pickers and no invite-as-admin choice", () => {
    signedInAs(MEMBER, "admin");
    renderSettings();
    expect(screen.queryByLabelText("Role for Mo")).toBeNull();
    expect(screen.queryByLabelText("Role for Olive")).toBeNull();
    // Inviting an admin is owner-only too, so the picker isn't offered at all —
    // an admin's invites are always plain members.
    expect(screen.queryByLabelText("Invite as")).toBeNull();
  });

  it("gives the owner the invite-as picker", () => {
    signedInAs(OWNER, "owner");
    renderSettings();
    expect(screen.getByLabelText("Invite as")).toBeTruthy();
  });
});
