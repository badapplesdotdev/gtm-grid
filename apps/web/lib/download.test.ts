import { describe, expect, it } from "vitest";

import { detectOS, resolveDownload } from "./download";

const UA = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
} as const;

describe("detectOS", () => {
  it("maps desktop user agents to their build key", () => {
    expect(detectOS(UA.windows)?.key).toBe("windows");
    expect(detectOS(UA.mac)?.key).toBe("mac-arm");
    expect(detectOS(UA.linux)?.key).toBe("linux");
  });

  it("returns null for mobile agents even though Android reports Linux", () => {
    expect(detectOS(UA.iphone)).toBeNull();
    expect(detectOS(UA.android)).toBeNull();
  });

  it("returns null when the user agent is missing", () => {
    expect(detectOS(undefined)).toBeNull();
    expect(detectOS(null)).toBeNull();
    expect(detectOS("")).toBeNull();
  });
});

describe("resolveDownload", () => {
  it("points a detected OS at the per-platform binary and shows in-page feedback", () => {
    const target = resolveDownload({ key: "windows", os: "Windows" });
    expect(target.href).toBe("/api/download/windows");
    expect(target.platform).toBe("windows");
    expect(target.os).toBe("Windows");
    // The binary download keeps the page in place, so the button owns the feedback.
    expect(target.startsInPageDownload).toBe(true);
  });

  it("falls back to the /download page (its own feedback) when the OS is unknown", () => {
    const target = resolveDownload(null);
    expect(target.href).toBe("/download");
    expect(target.platform).toBe("unknown");
    expect(target.os).toBe("unknown");
    expect(target.startsInPageDownload).toBe(false);
  });
});
