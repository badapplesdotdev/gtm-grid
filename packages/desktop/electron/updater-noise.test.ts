import { describe, expect, it } from "vitest";
import { isTransientUpdaterError } from "./updater-noise";

const latestNotFound = (inner: string) =>
  `Error: Unable to find latest version on GitHub (https://github.com/badapplesdotdev/gtm-grid/releases/latest), please ensure a production release exists: ${inner}`;

describe("isTransientUpdaterError", () => {
  it("skips local connectivity errors", () => {
    expect(isTransientUpdaterError("Error: net::ERR_INTERNET_DISCONNECTED")).toBe(true);
    expect(isTransientUpdaterError("Error: getaddrinfo ENOTFOUND github.com")).toBe(true);
  });

  it.each(["502 Bad Gateway", "503 Service Unavailable", "504 Gateway Timeout"])("skips a GitHub %s", (status) => {
    expect(isTransientUpdaterError(latestNotFound(`HttpError: ${status}\nHeaders: {}`))).toBe(true);
  });

  it("reports other HTTP errors", () => {
    expect(isTransientUpdaterError(latestNotFound("HttpError: 404 Not Found\nHeaders: {}"))).toBe(false);
    expect(isTransientUpdaterError(latestNotFound("HttpError: 500 Internal Server Error\nHeaders: {}"))).toBe(false);
  });

  it("reports real install failures", () => {
    expect(isTransientUpdaterError("Error: Code signature at URL file:///... did not pass validation")).toBe(false);
    expect(isTransientUpdaterError("Error: ShipIt failed to install the update")).toBe(false);
  });
});
