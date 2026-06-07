CREATE TYPE "public"."cell_status" AS ENUM('empty', 'pending', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."column_kind" AS ENUM('manual', 'function');--> statement-breakpoint
CREATE TYPE "public"."column_type" AS ENUM('text', 'number', 'boolean', 'date', 'json');--> statement-breakpoint
CREATE TYPE "public"."credential_scope" AS ENUM('workspace', 'personal');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."webhook_mode" AS ENUM('create', 'upsert');--> statement-breakpoint
CREATE TABLE "cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"value" jsonb,
	"status" "cell_status" NOT NULL,
	"error" text,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "column_type" NOT NULL,
	"kind" "column_kind" NOT NULL,
	"provider" text,
	"method" text,
	"code" text,
	"params" jsonb,
	"position" double precision NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"scope" "credential_scope" NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"secrets_enc" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"manifest" jsonb
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"token" text NOT NULL,
	"status" "invitation_status" NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_by" text,
	"accepted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"position" double precision NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" double precision NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"status" integer NOT NULL,
	"rows_affected" integer NOT NULL,
	"mode" "webhook_mode" NOT NULL,
	"record_id" text,
	"error" text,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text,
	"token" text NOT NULL,
	"signing_secret" text,
	"mapping" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"auto_run" boolean,
	"mode" "webhook_mode",
	"upsert_key" uuid,
	"created_at" bigint NOT NULL,
	"last_received_at" bigint,
	"received_count" integer
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"cloud_actions_pending" integer,
	"cloud_actions_used" integer,
	"cloud_actions_limit" integer,
	"current_plan_id" text
);
--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_row_id_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_upsert_key_columns_id_fk" FOREIGN KEY ("upsert_key") REFERENCES "public"."columns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cells_by_row" ON "cells" USING btree ("row_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cells_by_row_column" ON "cells" USING btree ("row_id","column_id");--> statement-breakpoint
CREATE INDEX "cells_by_table" ON "cells" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "cells_by_workspace" ON "cells" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cells_by_table_column" ON "cells" USING btree ("table_id","column_id");--> statement-breakpoint
CREATE INDEX "columns_by_table" ON "columns" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "columns_by_workspace" ON "columns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credentials_by_workspace" ON "credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credentials_by_workspace_extension" ON "credentials" USING btree ("workspace_id","extension_id");--> statement-breakpoint
CREATE INDEX "credentials_by_workspace_extension_owner" ON "credentials" USING btree ("workspace_id","extension_id","scope","owner_user_id");--> statement-breakpoint
CREATE INDEX "extensions_by_workspace" ON "extensions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extensions_by_workspace_extension" ON "extensions" USING btree ("workspace_id","extension_id");--> statement-breakpoint
CREATE INDEX "invitations_by_workspace" ON "invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invitations_by_token" ON "invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "invitations_by_email" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_by_workspace_email" ON "invitations" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "members_by_workspace" ON "members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "members_by_user" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_by_workspace_user" ON "members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "projects_by_workspace" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rows_by_table" ON "rows" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "rows_by_workspace" ON "rows" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tables_by_project" ON "tables" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tables_by_workspace" ON "tables" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_webhook" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_workspace" ON "webhook_deliveries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhooks_by_workspace" ON "webhooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhooks_by_table" ON "webhooks" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "webhooks_by_token" ON "webhooks" USING btree ("token");--> statement-breakpoint
CREATE INDEX "workspaces_by_owner" ON "workspaces" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "workspaces_by_pending" ON "workspaces" USING btree ("cloud_actions_pending");