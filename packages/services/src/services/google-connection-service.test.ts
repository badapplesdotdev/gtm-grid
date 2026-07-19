/**
 * GoogleConnectionService: the tokens+meta <-> SecretMap round trip, plus the
 * picked-file set that only Google has.
 *
 * `SecretMap` is `Record<string, string>`, so two things get flattened and have
 * to survive a parse back: `expiresAtMs` as a string (a `NaN` here is silent —
 * it compares false against every bound, so the token either never refreshes or
 * refreshes on every read) and `pickedFiles` as JSON.
 *
 * The picked-file list is not decoration. Under `drive.file` it is the ONLY
 * record of which spreadsheets the grant can open, so losing it — on a refresh,
 * on a re-pick, on a corrupt blob — leaves a live token attached to a connection
 * that can reach nothing.
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer } from "../layers.js";
import { CredentialService } from "./credential-service.js";
import {
  GOOGLE_CONNECTION_SLOT,
  GoogleConnectionService,
  MAX_PICKED_FILES,
  mergePickedFiles,
  parseConnection,
  toSecrets,
} from "./google-connection-service.js";

const WS = "11111111-1111-1111-1111-111111111111";

const META = {
  connectedByUserId: "user_1",
  connectedByName: "Morgan",
  googleEmail: "morgan@trigify.io",
  pickedFiles: [{ id: "sheet_1", name: "Q3 Leads" }],
};

const TOKENS = { accessToken: "ya29.at", refreshToken: "1//rt", expiresAtMs: 1_800_000_000_000 };

const layer = () =>
  TestLayer({
    workspaces: [{ id: WS, name: "WS", ownerId: "u1", currentPlanId: "team" }],
    memberships: [{ workspaceId: WS, userId: "u1", role: "owner" }],
    users: [{ id: "u1", name: "Morgan", email: "m@acme.com" }],
    currentUserId: "u1",
  });

describe("the credential slot", () => {
  it("is bare 'google', so every Google connector shares ONE grant", () => {
    // Sheets today; Docs/Drive/Gmail later. Connectors reach this row via
    // `auth.credentialSlot` in their manifests — drift between the two hands the
    // connector an empty credential with no error until the first 401.
    expect(GOOGLE_CONNECTION_SLOT).toBe("google");
  });
});

describe("toSecrets / parseConnection round trip", () => {
  it("round-trips tokens, meta and picked files", () => {
    const parsed = parseConnection(toSecrets(TOKENS, META));
    expect(parsed?.tokens).toEqual(TOKENS);
    expect(parsed?.meta).toEqual(META);
  });

  it("returns null when there is no usable access token", () => {
    expect(parseConnection({})).toBeNull();
    expect(parseConnection({ accessToken: "" })).toBeNull();
  });

  it("drops a corrupt expiry rather than yielding NaN", () => {
    // "no known expiry" means never refresh proactively, and the 401 backstop
    // covers it. NaN would compare false against every bound instead.
    const parsed = parseConnection({ ...toSecrets(TOKENS, META), expiresAtMs: "not-a-number" });
    expect(parsed?.tokens.expiresAtMs).toBeUndefined();
    expect(parsed?.tokens.accessToken).toBe("ya29.at");
  });

  it("omits refreshToken when absent, so needsRefresh declines to refresh", () => {
    const parsed = parseConnection(toSecrets({ accessToken: "ya29.at" }, META));
    expect(parsed?.tokens.refreshToken).toBeUndefined();
  });

  it("degrades a corrupt pickedFiles blob to an empty list, keeping the tokens", () => {
    // Throwing here would present to the user as "Google is disconnected" and
    // invite a needless re-consent; an empty list is a state the UI can already
    // recover from.
    const parsed = parseConnection({ ...toSecrets(TOKENS, META), pickedFiles: "{not json" });
    expect(parsed?.meta.pickedFiles).toEqual([]);
    expect(parsed?.tokens.accessToken).toBe("ya29.at");
  });

  it("skips malformed entries inside an otherwise valid pickedFiles list", () => {
    const parsed = parseConnection({
      ...toSecrets(TOKENS, META),
      pickedFiles: JSON.stringify([{ id: "ok", name: "Fine" }, { name: "no id" }, null, 42]),
    });
    expect(parsed?.meta.pickedFiles).toEqual([{ id: "ok", name: "Fine" }]);
  });

  it("falls back to the id when a picked file carries no name", () => {
    const parsed = parseConnection({
      ...toSecrets(TOKENS, META),
      pickedFiles: JSON.stringify([{ id: "sheet_9" }]),
    });
    expect(parsed?.meta.pickedFiles).toEqual([{ id: "sheet_9", name: "sheet_9" }]);
  });
});

describe("mergePickedFiles", () => {
  it("appends new files", () => {
    expect(mergePickedFiles([{ id: "a", name: "A" }], [{ id: "b", name: "B" }])).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
  });

  it("dedupes by id and takes the NEWEST name — a re-pick is an update", () => {
    // Users rename spreadsheets; re-picking must refresh the label, not duplicate.
    expect(mergePickedFiles([{ id: "a", name: "Old" }], [{ id: "a", name: "New" }])).toEqual([
      { id: "a", name: "New" },
    ]);
  });

  it("caps the list, dropping the OLDEST so the newest pick always takes effect", () => {
    const existing = Array.from({ length: MAX_PICKED_FILES }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    const merged = mergePickedFiles(existing, [{ id: "newest", name: "Newest" }]);
    expect(merged).toHaveLength(MAX_PICKED_FILES);
    expect(merged.at(-1)).toEqual({ id: "newest", name: "Newest" });
    expect(merged.find((f) => f.id === "f0")).toBeUndefined();
  });
});

describe("saveConnection", () => {
  it("stores a connection readable back by a member", async () => {
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        yield* google.saveConnection({ workspaceId: WS, tokens: TOKENS, meta: META });
        return yield* google.memberConnection(WS);
      }).pipe(Effect.provide(layer())),
    );

    expect(Option.isSome(connection)).toBe(true);
    if (Option.isSome(connection)) {
      expect(connection.value.meta.googleEmail).toBe("morgan@trigify.io");
      expect(connection.value.meta.pickedFiles).toEqual([{ id: "sheet_1", name: "Q3 Leads" }]);
    }
  });

  it("writes WITHOUT a membership check — the callback has no browser session", async () => {
    // The desktop opens consent with openExternal, so the callback lands with
    // sessionUser === null. Routing this through CredentialService.saveCredential
    // (which calls requireMember first) is what once made Slack's primary flow
    // impossible: a 502 AFTER successful consent, with the code already burned.
    const noMember = TestLayer({
      workspaces: [{ id: WS, name: "WS", ownerId: "u1", currentPlanId: "team" }],
      memberships: [],
      users: [],
      currentUserId: null,
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        yield* google.saveConnection({ workspaceId: WS, tokens: TOKENS, meta: META });
      }).pipe(Effect.provide(noMember)),
    );

    expect(exit._tag).toBe("Success");
  });

  it("resets picked files on a fresh consent", async () => {
    // A new grant does not guarantee the old per-file authorisations carry
    // across, so advertising them would promise access we may not have.
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        yield* google.saveConnection({ workspaceId: WS, tokens: TOKENS, meta: META });
        yield* google.saveConnection({
          workspaceId: WS,
          tokens: TOKENS,
          meta: { ...META, pickedFiles: [] },
        });
        return yield* google.memberConnection(WS);
      }).pipe(Effect.provide(layer())),
    );

    expect(Option.isSome(after) && after.value.meta.pickedFiles).toEqual([]);
  });
});

describe("addPickedFiles", () => {
  it("adds to the existing set without disturbing the tokens", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        yield* google.saveConnection({ workspaceId: WS, tokens: TOKENS, meta: META });
        const ok = yield* google.addPickedFiles({
          workspaceId: WS,
          files: [{ id: "sheet_2", name: "Q4 Leads" }],
        });
        const connection = yield* google.memberConnection(WS);
        return { ok, connection };
      }).pipe(Effect.provide(layer())),
    );

    expect(result.ok).toBe(true);
    expect(Option.isSome(result.connection)).toBe(true);
    if (Option.isSome(result.connection)) {
      expect(result.connection.value.meta.pickedFiles).toEqual([
        { id: "sheet_1", name: "Q3 Leads" },
        { id: "sheet_2", name: "Q4 Leads" },
      ]);
      // The grant itself is untouched.
      expect(result.connection.value.tokens.accessToken).toBe("ya29.at");
      expect(result.connection.value.tokens.refreshToken).toBe("1//rt");
    }
  });

  it("is a no-op returning false when no connection exists", async () => {
    // Writing here would create a token-less row the engine reads as "connected".
    const ok = await Effect.runPromise(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        return yield* google.addPickedFiles({ workspaceId: WS, files: [{ id: "x", name: "X" }] });
      }).pipe(Effect.provide(layer())),
    );

    expect(ok).toBe(false);
  });
});

describe("disconnect", () => {
  it("removes the connection", async () => {
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        yield* google.saveConnection({ workspaceId: WS, tokens: TOKENS, meta: META });
        yield* google.disconnect(WS);
        return yield* google.memberConnection(WS);
      }).pipe(Effect.provide(layer())),
    );

    expect(Option.isNone(after)).toBe(true);
  });
});

describe("the slot is not shared with an apiKey connector", () => {
  it("has no engine apiKey connector competing for the 'google' row", async () => {
    // Slack's slot collides with an apiKey connector of the same id, so the
    // desktop must suppress the key form or a paste destroys the grant. Google
    // ships no apiKey connector at this id — but the same suppression applies via
    // the manifest's auth.type, so this pins the assumption rather than the luck.
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const google = yield* GoogleConnectionService;
        yield* google.saveConnection({ workspaceId: WS, tokens: TOKENS, meta: META });
        const service = yield* CredentialService;
        return yield* service.getCredentialForRun({
          workspaceId: WS,
          extensionId: GOOGLE_CONNECTION_SLOT,
          scope: "workspace",
        });
      }).pipe(Effect.provide(layer())),
    );

    expect(Option.isSome(credentials)).toBe(true);
    if (Option.isSome(credentials)) expect(credentials.value.accessToken).toBe("ya29.at");
  });
});
