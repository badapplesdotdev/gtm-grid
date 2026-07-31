DROP INDEX "credentials_by_workspace_extension_owner";--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "account_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Dedupe BEFORE the unique indexes, or `CREATE UNIQUE INDEX` aborts the whole
-- migration on any workspace that already lost the `CredentialRepo.upsert`
-- race (select-then-insert with no constraint behind it). Runs AFTER the
-- `account_id` backfill above, so every pre-existing row compares at `''` and
-- duplicates collapse on the key the new indexes actually enforce.
--
-- Keeps the NEWEST row per key. That is a judgement call, not a certainty:
-- there is no `updated_at`, and the old code UPDATEd whichever row an
-- unordered `LIMIT 1` happened to return, so the most-recently-INSERTed row is
-- not provably the one carrying the live tokens. Picking wrong costs one
-- reconnect (the stale token 401s and the connector reports auth-revoked);
-- picking nothing costs a failed deploy. Duplicates require an actual
-- concurrent write, so this should be a no-op almost everywhere.
DELETE FROM "credentials" a
USING "credentials" b
WHERE a."workspace_id" = b."workspace_id"
  AND a."extension_id" = b."extension_id"
  AND a."account_id" = b."account_id"
  AND a."scope" = b."scope"
  AND a."owner_user_id" IS NOT DISTINCT FROM b."owner_user_id"
  AND (a."created_at", a."id") < (b."created_at", b."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_shared_unique" ON "credentials" USING btree ("workspace_id","extension_id","account_id","scope") WHERE "credentials"."owner_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_owned_unique" ON "credentials" USING btree ("workspace_id","extension_id","account_id","scope","owner_user_id") WHERE "credentials"."owner_user_id" is not null;