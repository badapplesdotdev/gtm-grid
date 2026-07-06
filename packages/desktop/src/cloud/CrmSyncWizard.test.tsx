// @vitest-environment jsdom
//
// Regression cover for the CRM connect flow's two dead-ends:
//   1. the "Authorizing…" poll must give up with a retryable error instead of
//      spinning forever when the OAuth handshake never lands, and
//   2. a `crm-connected` deep link (surfaced as `resumeProvider` + a bumped
//      `connectedSignal`) must resume a reopened wizard straight into Configure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The wizard only talks to the server through `apiClient.crm.*`; stub the
// procedures it calls so we can drive connection state deterministically.
// `vi.hoisted` so the mock factory (also hoisted) can close over it.
const crm = vi.hoisted(() => ({
  connectionStatus: { query: vi.fn() },
  authorizeUrl: { query: vi.fn() },
  listSources: { query: vi.fn() },
  describeSource: { query: vi.fn() },
  estimate: { query: vi.fn() },
  createBinding: { mutate: vi.fn() },
}));
vi.mock("./client", () => ({ apiClient: { crm } }));
// Keep OAuth "open the browser" a no-op (no real navigation in jsdom).
vi.mock("../electron", () => ({
  electron: () => ({ openExternal: vi.fn().mockResolvedValue(undefined) }),
  isDesktop: () => true,
}));

import { CrmSyncWizard } from "./CrmSyncWizard";

const baseProps = {
  workspaceId: "ws_1",
  createTable: vi.fn(async () => "tbl_1"),
  deleteTable: vi.fn(async () => undefined),
  onClose: vi.fn(),
  onCreated: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CrmSyncWizard — Authorizing… poll is bounded", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("surfaces a retryable error instead of spinning forever", async () => {
    // The connection never completes — every status check says "not connected".
    crm.connectionStatus.query.mockResolvedValue({ configured: true, connected: false });
    crm.authorizeUrl.query.mockResolvedValue({ url: "https://hubspot.example/oauth" });

    render(<CrmSyncWizard {...baseProps} />);

    // Pick HubSpot → (not connected) → Connect step.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /HubSpot/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect with HubSpot/ }));
    });

    // Now spinning on "Authorizing with HubSpot…".
    expect(screen.getByText(/Authorizing with HubSpot/)).toBeTruthy();

    // Let the whole timeout window elapse (poll keeps returning not-connected).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });

    // Spinner is gone; a retryable error + the Connect button are back.
    expect(screen.queryByText(/Authorizing with HubSpot/)).toBeNull();
    expect(screen.getByText(/Still waiting on HubSpot/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect with HubSpot/ })).toBeTruthy();
  });
});

describe("CrmSyncWizard — crm-connected deep link resumes a reopened wizard", () => {
  it("jumps straight to Configure for the provider the link named", async () => {
    // Reopened cold: the wizard mounts fresh (defaults to Attio) but the deep
    // link says HubSpot just connected, so it must resume HubSpot.
    crm.connectionStatus.query.mockImplementation(async ({ provider }: { provider: string }) =>
      provider === "hubspot"
        ? { configured: true, connected: true, connectedByName: "Morgan", workspaceLabel: "Acme CRM" }
        : { configured: true, connected: false },
    );
    crm.listSources.query.mockResolvedValue([
      { kind: "object", id: "contacts", label: "Contacts", parentObject: null },
    ]);
    crm.describeSource.query.mockResolvedValue({
      fields: [{ slug: "email", title: "Email", type: "email-address", recommended: true, sample: "a@b.com" }],
      suggestedMatchKey: "email",
    });
    crm.estimate.query.mockResolvedValue({ count: 5, isLowerBound: false });

    render(<CrmSyncWizard {...baseProps} resumeProvider="hubspot" connectedSignal={1} />);

    // Lands on Configure showing the HubSpot connection, not stuck on pick/connect.
    await waitFor(() => expect(screen.getByText(/Connected · Acme CRM/)).toBeTruthy());
    expect(screen.getByText(/What to sync/)).toBeTruthy();
    expect(crm.connectionStatus.query).toHaveBeenCalledWith({ workspaceId: "ws_1", provider: "hubspot" });
  });
});
