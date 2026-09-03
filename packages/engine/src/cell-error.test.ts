// The cell-error classifier: it decides whether a failed cell run is the user's
// to fix (auth/credit/config) — kept off error tracking — or a genuine defect.

import { describe, expect, it } from "vitest";
import { classifyCellError } from "./cell-error.js";

describe("classifyCellError", () => {
  it("classifies an expired coding-agent login as auth (the reported case)", () => {
    const c = classifyCellError(new Error("401 OAuth access token has expired. Re-authenticate to continue."));
    expect(c.kind).toBe("auth");
    expect(c.userActionable).toBe(true);
  });

  it("classifies a 402 as credit", () => {
    const c = classifyCellError(new Error("LeadMagic verify HTTP 402: insufficient credits"));
    expect(c.kind).toBe("credit");
    expect(c.userActionable).toBe(true);
  });

  it("classifies other vendor 4xx (404/400) as config", () => {
    expect(classifyCellError(new Error("Trigify search HTTP 404: not found")).kind).toBe("config");
    expect(classifyCellError(new Error("HeyReach addLead HTTP 400: bad request")).kind).toBe("config");
  });

  it("classifies a missing AI provider as config", () => {
    const c = classifyCellError(
      new Error("No AI provider connected. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY."),
    );
    expect(c.kind).toBe("config");
  });

  it("reads a numeric `status` off a vendor SDK error", () => {
    const e = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(classifyCellError(e).kind).toBe("auth");
  });

  it("adds a re-authenticate hint to a status-only auth error", () => {
    const c = classifyCellError(new Error("HeyReach getLists HTTP 401: Unauthorized"));
    expect(c.kind).toBe("auth");
    expect(c.message).toMatch(/re-authenticate to continue/i);
  });

  it("does not double up the hint when the message already guides", () => {
    const msg = "Slack authorization expired or was revoked (HTTP 401) — reconnect your Slack account to run this function.";
    expect(classifyCellError(new Error(msg)).message).toBe(msg);
  });

  it("keeps transient (429/408) and 5xx and unknown errors as defects", () => {
    expect(classifyCellError(new Error("Surfe HTTP 429: rate limited")).kind).toBe("defect");
    expect(classifyCellError(new Error("Surfe HTTP 500: server error")).kind).toBe("defect");
    expect(classifyCellError(new Error("sandbox: TypeError: x is not a function")).kind).toBe("defect");
    expect(classifyCellError(new Error("Surfe HTTP 408: timeout")).kind).toBe("defect");
  });

  it("only reports defects — every user-actionable kind stays off error tracking", () => {
    expect(classifyCellError(new Error("sandbox: boom")).userActionable).toBe(false);
  });
});
