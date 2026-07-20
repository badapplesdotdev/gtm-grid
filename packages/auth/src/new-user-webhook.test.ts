import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendNewUserWebhook } from "./new-user-webhook.js";

/**
 * New-user webhook AC: every account creation POSTs the full user record to
 * `NEW_USER_WEBHOOK_URL`; unset env => no request at all; a failing endpoint
 * (network error or non-2xx) never throws out of the helper (signup-safe).
 */

const URL_KEY = "NEW_USER_WEBHOOK_URL";
const TEST_URL = "https://example.test/api/webhooks/new-user";

let savedUrl: string | undefined;
const fetchMock = vi.fn();

const user = {
  id: "user_123",
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date("2026-07-02T10:00:00.000Z"),
  updatedAt: new Date("2026-07-02T10:00:00.000Z"),
};

beforeEach(() => {
  savedUrl = process.env[URL_KEY];
  process.env[URL_KEY] = TEST_URL;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env[URL_KEY];
  else process.env[URL_KEY] = savedUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendNewUserWebhook", () => {
  it("POSTs the full user record as JSON to the configured URL", async () => {
    await sendNewUserWebhook(user);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TEST_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      event: "user.created",
      user: {
        id: "user_123",
        name: "Ada Lovelace",
        email: "ada@example.com",
        emailVerified: true,
        image: null,
        createdAt: "2026-07-02T10:00:00.000Z",
        updatedAt: "2026-07-02T10:00:00.000Z",
      },
    });
  });

  it("no-ops when NEW_USER_WEBHOOK_URL is unset", async () => {
    delete process.env[URL_KEY];
    await sendNewUserWebhook(user);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-https URLs (PII + token must not go plaintext)", async () => {
    process.env[URL_KEY] = "http://example.test/api/webhooks/new-user";
    await sendNewUserWebhook(user);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes string timestamps and nulls unparseable ones", async () => {
    await sendNewUserWebhook({
      ...user,
      createdAt: "2026-07-02",
      updatedAt: "not-a-date",
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.user.createdAt).toBe("2026-07-02T00:00:00.000Z");
    expect(body.user.updatedAt).toBeNull();
  });

  it("defaults optional fields instead of dropping them", async () => {
    await sendNewUserWebhook({ id: "user_456", email: "bare@example.com" });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.user).toEqual({
      id: "user_456",
      name: null,
      email: "bare@example.com",
      emailVerified: false,
      image: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("swallows network errors so signup cannot fail", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    await expect(sendNewUserWebhook(user)).resolves.toBeUndefined();
  });

  it("swallows non-2xx responses so signup cannot fail", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(sendNewUserWebhook(user)).resolves.toBeUndefined();
  });
});
