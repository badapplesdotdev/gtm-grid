// @vitest-environment jsdom
/**
 * OAuthConnectCard — the connect journey's non-obvious parts.
 *
 * The happy path is barely worth testing; these cover the three things that
 * actually bite: polling only while a round-trip is in flight, telling
 * "not configured" apart from "not connected", and confirming before a
 * destructive disconnect.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthConnectCard, type OAuthCardStatus } from "./OAuthConnectCard";

const openExternal = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./open-external", () => ({ openExternalUrl: openExternal }));

const base = {
  headText: "Slack · OAuth connection",
  providerName: "Slack",
  refresh: vi.fn(async () => {}),
  authorizeUrl: vi.fn(async () => "https://slack.com/oauth/v2/authorize?state=abc"),
  disconnect: vi.fn(async () => "Disconnected."),
  connectedSub: "powers Slack columns",
  disconnectedSub: "Connect with OAuth to post messages",
};

const connected: OAuthCardStatus = { kind: "connected", byName: "Morgan", accountLabel: "Acme Slack" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("not connected", () => {
  it("offers Connect and opens the SERVER-MINTED authorize URL externally", async () => {
    // Server-minted because an openExternal navigation carries no session
    // cookie — a browser-minted state would dead-end on the web session gate.
    render(<OAuthConnectCard {...base} status={{ kind: "disconnected", configured: true }} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect Slack/i }));
    await waitFor(() => expect(base.authorizeUrl).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?state=abc");
  });

  it("DISABLES Connect and says so when the deployment has no Slack app", async () => {
    // "configured" and "connected" are different things: a self-hosted instance
    // with no OAuth app can never connect, so a live button would just fail.
    render(<OAuthConnectCard {...base} status={{ kind: "disconnected", configured: false }} />);
    expect((screen.getByRole("button", { name: /Connect Slack/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/isn't set up on this deployment yet/i)).toBeTruthy();
  });

  it("surfaces an authorize failure instead of hanging on 'Waiting…'", async () => {
    const authorizeUrl = vi.fn(async () => {
      throw new Error("Slack OAuth env missing: SLACK_CLIENT_ID");
    });
    render(
      <OAuthConnectCard {...base} authorizeUrl={authorizeUrl} status={{ kind: "disconnected", configured: true }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Connect Slack/i }));
    expect(await screen.findByText(/SLACK_CLIENT_ID/)).toBeTruthy();
    // Busy must reset, or the button is stuck forever.
    expect((screen.getByRole("button", { name: /Connect Slack/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("connected", () => {
  it("shows the account label and who connected it", () => {
    render(<OAuthConnectCard {...base} status={connected} />);
    expect(screen.getByText(/Acme Slack/)).toBeTruthy();
    expect(screen.getByText(/connected by Morgan/)).toBeTruthy();
  });

  it("requires CONFIRMATION before disconnecting", async () => {
    render(<OAuthConnectCard {...base} status={connected} />);
    await userEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));
    // The first click only arms it — a destructive action behind one click is
    // how people lose a connection by mis-clicking.
    expect(base.disconnect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Confirm disconnect/i }));
    await waitFor(() => expect(base.disconnect).toHaveBeenCalledOnce());
    expect(await screen.findByText("Disconnected.")).toBeTruthy();
  });

  it("Cancel backs out without disconnecting", async () => {
    render(<OAuthConnectCard {...base} status={connected} />);
    await userEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(base.disconnect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Disconnect$/ })).toBeTruthy();
  });
});

describe("polling", () => {
  it("does NOT poll until a round-trip is in flight", async () => {
    const refresh = vi.fn(async () => {});
    vi.useFakeTimers();
    try {
      render(<OAuthConnectCard {...base} refresh={refresh} status={{ kind: "disconnected", configured: true }} />);
      await vi.advanceTimersByTimeAsync(10_000);
      // An idle Tools panel must not poll the server forever.
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls while awaiting consent, and STOPS once the status flips to connected", async () => {
    // The poll is the reliable completion signal — the gtmgrid:// deep link is
    // best-effort (the OS may not hand off, or the user just switches back).
    const refresh = vi.fn(async () => {});
    const { rerender } = render(
      <OAuthConnectCard {...base} refresh={refresh} status={{ kind: "disconnected", configured: true }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Connect Slack/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Waiting for Slack…/i })).toBeTruthy());

    rerender(<OAuthConnectCard {...base} refresh={refresh} status={connected} />);
    await waitFor(() => expect(screen.getByText("Slack connected.")).toBeTruthy());
    const after = refresh.mock.calls.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(refresh.mock.calls.length).toBe(after);
  });
});
