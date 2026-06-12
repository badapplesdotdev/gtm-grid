/**
 * Drizzle (Postgres) schema for GTM Grid's cloud (team / multiplayer) tier.
 *
 * This is the Postgres translation of the Convex source of truth in
 * `convex/schema.ts`. Every Convex table, field, and `.index(...)` is mirrored
 * here so the cloud data model survives the move off Convex onto Supabase
 * Postgres. Local solo projects continue to use the unchanged local SQLite
 * engine (packages/engine/src/db.ts) — nothing here touches that path.
 *
 * Key translation rules:
 *   - Convex `v.id("table")` -> `uuid` FK column with `ON DELETE CASCADE`.
 *     Convex stored relations as document ids; here they are real Postgres FKs,
 *     which lets the database enforce the cascade that `convex/model/grid.ts`
 *     previously hand-rolled (table -> columns/rows/cells/webhooks ->
 *     webhookDeliveries).
 *   - Convex `v.id("users")` was stored as a plain string (Convex Auth user id).
 *     Better Auth owns the real `users` table (defined in the W1 auth task); we
 *     declare a minimal `users` table here ONLY as the FK target so referential
 *     integrity holds. Its id is `text` to match Better Auth's id type.
 *   - Convex `v.any()` -> `jsonb` (cells.value, columns.params, extensions.manifest).
 *   - Convex literal unions -> Postgres enums (cellStatus, columnType,
 *     columnKind, memberRole, credentialScope).
 *   - Convex `v.number()` timestamps were epoch ms; kept as `bigint` here to
 *     preserve the exact millisecond integers the app already writes/reads.
 *
 * Greenfield migration: there is NO data migration from Convex. The initial
 * migration is generated offline via `drizzle-kit generate` and committed.
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Shared enums (convex/schema.ts:33-84)
// ---------------------------------------------------------------------------

/** Cell status — mirrors `cellStatus` (convex/schema.ts:33). */
export const cellStatus = pgEnum("cell_status", [
  "empty",
  "pending",
  "running",
  "done",
  "error",
]);

/** Column value type — mirrors `columnType` (convex/schema.ts:42). */
export const columnType = pgEnum("column_type", [
  "text",
  "number",
  "boolean",
  "date",
  "json",
]);

/** Column kind — mirrors `columnKind` (convex/schema.ts:51). */
export const columnKind = pgEnum("column_kind", ["manual", "function"]);

/** Member role — mirrors `memberRole` (convex/schema.ts:57). */
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

/** Credential scope — mirrors `credentialScope` (convex/schema.ts:69). */
export const credentialScope = pgEnum("credential_scope", [
  "workspace",
  "personal",
]);

/** Webhook receive mode — mirrors the `mode` union (convex/schema.ts:350,389). */
export const webhookMode = pgEnum("webhook_mode", ["create", "upsert"]);

/** Invitation lifecycle — mirrors the `status` union (convex/schema.ts:179). */
export const invitationStatus = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
]);

// ---------------------------------------------------------------------------
// Better Auth tables (W1 auth task) — users / sessions / accounts / verification
// ---------------------------------------------------------------------------

/**
 * The authoritative Better Auth `users` table.
 *
 * CRITICAL: the `id` stays `text` (Better Auth mints string ids), NOT changed to
 * uuid — every cloud FK below (`workspaces.ownerId`, `members.userId`,
 * `invitations.invitedBy`/`acceptedBy`, `credentials.ownerUserId`) references
 * `users.id` as text, so flipping the type would break referential integrity and
 * the TRI-3243 migration. This task only ADDS the Better Auth profile columns
 * (name/email/emailVerified/image/timestamps) onto the existing text id.
 *
 * Better Auth's default model name is the SINGULAR `user`; we keep GTM Grid's
 * plural `users` table name and tell Better Auth about it via the Drizzle
 * adapter's `usePlural` option (packages/auth/src/server.ts), so the schema and
 * the auth runtime agree without renaming the table the rest of the cloud uses.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  /** Display name (Better Auth core field; nullable until set). */
  name: text("name"),
  /** Primary email; unique across the table (Better Auth requirement). */
  email: text("email").notNull().unique(),
  /** Whether the email was verified via the OTP flow. */
  emailVerified: boolean("email_verified").notNull().default(false),
  /** Avatar URL (from OAuth providers or upload). */
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

/**
 * Active login sessions (Better Auth core `session` table; we keep the plural
 * `sessions` to match the `usePlural` adapter option). One row per signed-in
 * device/browser; `token` is the opaque session cookie value the
 * session-resolution helper validates.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /** Opaque session token (the cookie value); unique. */
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Client IP at sign-in (audit/security; nullable). */
    ipAddress: text("ip_address"),
    /** Client user-agent at sign-in (nullable). */
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("sessions_by_user").on(t.userId),
    index("sessions_by_token").on(t.token),
  ],
);

/**
 * Credential + linked-OAuth accounts (Better Auth core `account` table). One row
 * per (providerId, accountId): the email/password "credential" account stores
 * the hashed `password`; GitHub/Google rows store the OAuth tokens. The plural
 * `accounts` name matches the `usePlural` adapter option.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    /** Provider's account id ("credential" provider uses the user id). */
    accountId: text("account_id").notNull(),
    /** Provider id: "credential" | "github" | "google". */
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** OAuth access token (nullable for credential accounts). */
    accessToken: text("access_token"),
    /** OAuth refresh token (nullable). */
    refreshToken: text("refresh_token"),
    /** OAuth id token (nullable). */
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
    /** Granted OAuth scopes (nullable). */
    scope: text("scope"),
    /** Hashed password for the credential account (nullable for OAuth rows). */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("accounts_by_user").on(t.userId),
    index("accounts_by_provider_account").on(t.providerId, t.accountId),
  ],
);

/**
 * Short-lived verification values (Better Auth core `verification` table). Backs
 * the email-OTP verification + password-reset flows: `identifier` keys the flow
 * (e.g. the email), `value` holds the 6-digit OTP, and `expiresAt` enforces the
 * 15-minute window. The plural `verifications` matches the `usePlural` option.
 */
export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    /** Flow key (the email being verified / reset). */
    identifier: text("identifier").notNull(),
    /** The OTP code (or token) being checked. */
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("verifications_by_identifier").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Control-plane tables
// ---------------------------------------------------------------------------

/** Top-level account unit (convex/schema.ts:98). */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Better Auth user id of the creator/owner. */
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /**
     * CLOUD-actions usage counter — the SINGLE cloud-actions metering surface.
     * Both the grid `MeterService` and the webhook worker increment this on the
     * write path; the legacy pending counter + 1-min cron flush were removed.
     * Optional/undefined treated as 0.
     */
    cloudActionsUsed: integer("cloud_actions_used"),
    /** Plan cap for cloud actions; null for an unlimited plan. */
    cloudActionsLimit: integer("cloud_actions_limit"),
    /** Current PAID plan id: "team" | "business" | "unlimited", or null. */
    currentPlanId: text("current_plan_id"),
    /**
     * Epoch ms when the current trial ends, or null when not trialing (Free, or a
     * paid non-trial subscription). Synced from Autumn by `BillingService.syncPlan`
     * and seeded on trial start; drives the in-app countdown banner + the
     * scheduled trial-ending email reminders.
     */
    trialEndsAt: bigint("trial_ends_at", { mode: "number" }),
  },
  (t) => [index("workspaces_by_owner").on(t.ownerId)],
);

/** Workspace membership (convex/schema.ts:145). */
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("members_by_workspace").on(t.workspaceId),
    index("members_by_user").on(t.userId),
    // by_workspace_user enforces one membership per (user, workspace).
    uniqueIndex("members_by_workspace_user").on(t.workspaceId, t.userId),
  ],
);

/** Pending workspace invitations (convex/schema.ts:170). */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Invitee email, normalized to lowercase on write. */
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    /** High-entropy accept token (the link/code segment). */
    token: text("token").notNull(),
    status: invitationStatus("status").notNull(),
    /** Better Auth user id of the inviting owner/admin. */
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    /** Better Auth user id that accepted (null until accepted). */
    acceptedBy: text("accepted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: bigint("accepted_at", { mode: "number" }),
  },
  (t) => [
    index("invitations_by_workspace").on(t.workspaceId),
    index("invitations_by_token").on(t.token),
    index("invitations_by_email").on(t.email),
    // by_workspace_email enforces one live invite per (workspace, email).
    uniqueIndex("invitations_by_workspace_email").on(t.workspaceId, t.email),
  ],
);

/** Shared connector credentials, encrypted at rest (convex/schema.ts:287). */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The connector/extension these secrets authenticate, e.g. "ai:openai". */
    extensionId: text("extension_id").notNull(),
    scope: credentialScope("scope").notNull(),
    /** Owning member for a `personal`-scope row; null for `workspace` rows. */
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    /** Ciphertext of the secret map (envelope-encrypted). Never plaintext. */
    secretsEnc: text("secrets_enc").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("credentials_by_workspace").on(t.workspaceId),
    index("credentials_by_workspace_extension").on(t.workspaceId, t.extensionId),
    index("credentials_by_workspace_extension_owner").on(
      t.workspaceId,
      t.extensionId,
      t.scope,
      t.ownerUserId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Grid-data tables
// ---------------------------------------------------------------------------

/** A cloud project (convex/schema.ts:199). */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("projects_by_workspace").on(t.workspaceId)],
);

/**
 * A sidebar folder grouping a project's tables (organizational only — one level
 * deep, no folder nesting). Deleting a folder unfiles its tables back to the
 * root via the `tables.folder_id` ON DELETE SET NULL foreign key.
 */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: doublePrecision("position").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("folders_by_project").on(t.projectId),
    index("folders_by_workspace").on(t.workspaceId),
  ],
);

/** A grid/table within a project (convex/schema.ts:206). */
export const tables = pgTable(
  "tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: doublePrecision("position").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    // The sidebar folder this table is filed under (null = root). SET NULL on
    // folder delete so removing a folder unfiles its tables, never deletes them.
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    // Optional row-deduplication config (mirrors the local engine): the column
    // whose value rows are deduped on, and which duplicate to keep. Null = off.
    // The `(): AnyPgColumn` annotation breaks the tables↔columns circular type
    // reference (columns.table_id → tables, tables.dedupe_column → columns).
    dedupeColumn: uuid("dedupe_column").references((): AnyPgColumn => columns.id, {
      onDelete: "set null",
    }),
    dedupeKeep: text("dedupe_keep"),
  },
  (t) => [
    index("tables_by_project").on(t.projectId),
    index("tables_by_workspace").on(t.workspaceId),
  ],
);

/** A column within a table (convex/schema.ts:217). */
export const columns = pgTable(
  "columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: columnType("type").notNull(),
    kind: columnKind("kind").notNull(),
    /** Connector provider for a function column, e.g. "ai". Nullable. */
    provider: text("provider"),
    /** Connector method, e.g. "generate". Nullable. */
    method: text("method"),
    /** JS body executed in the QuickJS sandbox for function columns. Nullable. */
    code: text("code"),
    /** Input mapping; templated with {{Column Name}}. v.any() -> jsonb. */
    params: jsonb("params"),
    /** Optional "only run if" boolean expression; null/empty means always run. */
    condition: text("condition"),
    position: doublePrecision("position").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("columns_by_table").on(t.tableId),
    index("columns_by_workspace").on(t.workspaceId),
  ],
);

/** A row within a table (convex/schema.ts:238). */
export const rows = pgTable(
  "rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    position: doublePrecision("position").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("rows_by_table").on(t.tableId),
    index("rows_by_workspace").on(t.workspaceId),
  ],
);

/** A cell keyed by (rowId, columnId) (convex/schema.ts:255). */
export const cells = pgTable(
  "cells",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    rowId: uuid("row_id")
      .notNull()
      .references(() => rows.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => columns.id, { onDelete: "cascade" }),
    /** Arbitrary JSON cell value. v.any() -> jsonb. */
    value: jsonb("value"),
    status: cellStatus("status").notNull(),
    error: text("error"),
    updatedAt: bigint("updated_at", { mode: "number" }),
  },
  (t) => [
    index("cells_by_row").on(t.rowId),
    // by_row_column uniquely addresses a single cell for setCell upserts.
    uniqueIndex("cells_by_row_column").on(t.rowId, t.columnId),
    index("cells_by_table").on(t.tableId),
    index("cells_by_workspace").on(t.workspaceId),
    // NEW (not in Convex): Convex had no by_column on cells, so column-delete
    // and webhook upsert scanned by_table then filtered by columnId in app
    // code. This (table_id, column_id) btree turns those hot paths into a
    // direct index range scan.
    index("cells_by_table_column").on(t.tableId, t.columnId),
  ],
);

/** Uploaded JSON-manifest connector extensions (convex/schema.ts:271). */
export const extensions = pgTable(
  "extensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Stable extension id from the manifest (e.g. "apollo"). */
    extensionId: text("extension_id").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    /** Connector manifest JSON. v.any() -> jsonb. */
    manifest: jsonb("manifest"),
  },
  (t) => [
    index("extensions_by_workspace").on(t.workspaceId),
    uniqueIndex("extensions_by_workspace_extension").on(
      t.workspaceId,
      t.extensionId,
    ),
  ],
);

/** Inbound webhook endpoints (convex/schema.ts:325). */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    name: text("name"),
    /** High-entropy public token (the URL segment). */
    token: text("token").notNull(),
    /** HMAC-SHA256 signing secret. Nullable for back-compat. */
    signingSecret: text("signing_secret"),
    /**
     * Field mapping array (path -> columnId). Modelled as jsonb: Convex stored
     * a structured array of {path, columnId} objects (v.array(v.object(...)));
     * jsonb preserves that shape losslessly without a join table.
     */
    mapping: jsonb("mapping").notNull(),
    enabled: boolean("enabled").notNull(),
    /** Skip auto-running function columns on insert. Nullable, default true. */
    autoRun: boolean("auto_run"),
    /** Receive behaviour. Nullable; default "create". */
    mode: webhookMode("mode"),
    /** Column matched on for upsert; null when not upserting. */
    upsertKey: uuid("upsert_key").references(() => columns.id, {
      onDelete: "set null",
    }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** Epoch ms of the most recent received payload, or null if never hit. */
    lastReceivedAt: bigint("last_received_at", { mode: "number" }),
    /** Total payloads received. */
    receivedCount: integer("received_count"),
  },
  (t) => [
    index("webhooks_by_workspace").on(t.workspaceId),
    index("webhooks_by_table").on(t.tableId),
    index("webhooks_by_token").on(t.token),
  ],
);

/**
 * A cloud table fed by a scheduled Trigify social-signal search. The Inngest
 * cron worker polls each enabled binding, pulls new results from Trigify, maps
 * them through `columns`, and inserts rows/cells — the scheduled analogue of a
 * webhook (which is push-driven).
 */
export const signalBindings = pgTable(
  "signal_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    /** Signal source id, e.g. "linkedin-posts". */
    sourceId: text("source_id").notNull(),
    label: text("label").notNull(),
    /** "search" | "profileEngagement". */
    kind: text("kind").notNull(),
    /** The Trigify search id; null until the search is created. */
    searchId: text("search_id"),
    /** Inputs used to create the Trigify search (jsonb). */
    config: jsonb("config").notNull(),
    /** "manual" | "hourly" | "daily" | "weekly". */
    schedule: text("schedule").notNull(),
    /** Result-field → column mapping: [{ key, name }] (jsonb). */
    columns: jsonb("columns").notNull(),
    /** Recently-seen result keys for cross-poll dedupe (jsonb string[]). */
    seen: jsonb("seen"),
    lastSyncedAt: bigint("last_synced_at", { mode: "number" }),
    lastError: text("last_error"),
    rowsPulled: integer("rows_pulled"),
    enabled: boolean("enabled").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("signal_bindings_by_workspace").on(t.workspaceId),
    index("signal_bindings_by_table").on(t.tableId),
  ],
);

/**
 * Durable per-binding dedupe set: every result key a binding has ever ingested.
 * Replaces the bounded `signal_bindings.seen` jsonb array (capped at 1000 keys),
 * whose truncation re-inserted duplicates once a binding crossed that cap. The
 * `(binding_id, key)` unique index lets the worker dedupe a poll's results with a
 * single indexed lookup AND insert only the genuinely-new keys via an
 * `ON CONFLICT DO NOTHING` bulk upsert, so the set stays correct without ever
 * loading the whole history into memory.
 */
export const signalSeenKeys = pgTable(
  "signal_seen_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => signalBindings.id, { onDelete: "cascade" }),
    /** The dedupe key (`resultKey`) for one ingested result. */
    key: text("key").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("signal_seen_keys_by_binding_key").on(t.bindingId, t.key),
  ],
);

/** Per-event webhook delivery log (convex/schema.ts:380). */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    /** HTTP-style status of the delivery (200 on success). */
    status: integer("status").notNull(),
    /** Rows created/updated by this delivery. */
    rowsAffected: integer("rows_affected").notNull(),
    mode: webhookMode("mode").notNull(),
    /** Idempotent content hash of the source record, when available. */
    recordId: text("record_id"),
    error: text("error"),
    /** Epoch ms the payload was received/recorded. */
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("webhook_deliveries_by_webhook").on(t.webhookId),
    index("webhook_deliveries_by_workspace").on(t.workspaceId),
  ],
);

// Re-export `sql` so consumers can build raw fragments without a second
// drizzle-orm import path; keeps the package the single DB surface.
export { sql };
