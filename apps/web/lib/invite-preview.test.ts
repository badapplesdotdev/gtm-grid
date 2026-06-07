/**
 * Tests for the invite landing-page data loader (TRI-3256), run OFFLINE against
 * a `TestLayer` runtime — NO live database. Proves `previewWithRuntime` returns
 * the public `getInvitationByToken` preview for a live token, `{ valid: false }`
 * for an unknown / expired token (no auth required — the token is the
 * capability), and degrades to `{ kind: "unavailable" }` when the runtime
 * defects. This is the exact data the server component renders.
 */

import type { InMemoryUser, Invitation, Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { previewWithRuntime } from "./invite-preview";

const WS_ID = "11111111-1111-1111-1111-111111111111";
const OWNER = "user_owner";
const INVITEE_EMAIL = "invitee@acme.com";
const TOKEN = "tok_live_0123456789abcdef";
const HOUR = 60 * 60 * 1000;

const users: readonly InMemoryUser[] = [
  { id: OWNER, name: "Olive Owner", email: "owner@acme.com" },
];
const workspaces = [{ id: WS_ID, name: "Acme", ownerId: OWNER }];
const ownerMembership: Membership = {
  workspaceId: WS_ID,
  userId: OWNER,
  role: "owner",
};
const liveInvite = (over: Partial<Invitation> = {}): Invitation => ({
  id: "inv_1",
  workspaceId: WS_ID,
  email: INVITEE_EMAIL,
  role: "member",
  token: TOKEN,
  status: "pending",
  invitedBy: OWNER,
  createdAt: Date.now() - HOUR,
  expiresAt: Date.now() + HOUR,
  acceptedBy: null,
  acceptedAt: null,
  ...over,
});

const runtimeFor = (fixtures: TestLayerFixtures) =>
  ManagedRuntime.make(TestLayer(fixtures));

describe("previewWithRuntime", () => {
  it("returns a valid preview for a live token (no auth)", async () => {
    const runtime = runtimeFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: null,
      invitations: [liveInvite()],
    });
    try {
      const result = await previewWithRuntime(runtime, TOKEN);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok" && result.preview.valid) {
        expect(result.preview.workspaceName).toBe("Acme");
        expect(result.preview.email).toBe(INVITEE_EMAIL);
        expect(result.preview.role).toBe("member");
      } else {
        throw new Error("expected a valid preview");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("returns { valid: false } for an unknown token", async () => {
    const runtime = runtimeFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: null,
      invitations: [liveInvite()],
    });
    try {
      const result = await previewWithRuntime(runtime, "nope");
      expect(result).toEqual({ kind: "ok", preview: { valid: false } });
    } finally {
      await runtime.dispose();
    }
  });

  it("returns { valid: false } for an expired token", async () => {
    const runtime = runtimeFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: null,
      invitations: [liveInvite({ expiresAt: Date.now() - HOUR })],
    });
    try {
      const result = await previewWithRuntime(runtime, TOKEN);
      expect(result).toEqual({ kind: "ok", preview: { valid: false } });
    } finally {
      await runtime.dispose();
    }
  });

  it("degrades to unavailable when the runtime cannot run the Effect", async () => {
    // Disposing the runtime before running forces `runPromise` to reject; the
    // loader must swallow that and degrade rather than crash the page.
    const runtime = runtimeFor({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: null,
      invitations: [liveInvite()],
    });
    await runtime.dispose();
    const result = await previewWithRuntime(runtime, TOKEN);
    expect(result).toEqual({ kind: "unavailable" });
  });
});
