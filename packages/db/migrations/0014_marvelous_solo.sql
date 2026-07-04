CREATE TABLE "crm_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_label" text NOT NULL,
	"columns" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"schedule" text NOT NULL,
	"enabled" boolean NOT NULL,
	"paused_reason" text,
	"last_synced_at" bigint,
	"last_error" text,
	"rows_synced" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"rows_created" integer NOT NULL,
	"rows_updated" integer NOT NULL,
	"rows_skipped" integer NOT NULL,
	"rows_staled" integer NOT NULL,
	"fields_dropped" jsonb,
	"error" text,
	"started_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "crm_synced_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"match_key" text,
	"last_seen_run_id" uuid,
	"stale" boolean NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "crm_bindings" ADD CONSTRAINT "crm_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_bindings" ADD CONSTRAINT "crm_bindings_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_binding_id_crm_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."crm_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_runs" ADD CONSTRAINT "crm_sync_runs_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_synced_rows" ADD CONSTRAINT "crm_synced_rows_binding_id_crm_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."crm_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_synced_rows" ADD CONSTRAINT "crm_synced_rows_row_id_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_bindings_by_workspace" ON "crm_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "crm_bindings_by_table" ON "crm_bindings" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "crm_sync_runs_by_binding" ON "crm_sync_runs" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "crm_sync_runs_by_workspace" ON "crm_sync_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_synced_rows_by_binding_external" ON "crm_synced_rows" USING btree ("binding_id","external_id");--> statement-breakpoint
CREATE INDEX "crm_synced_rows_by_binding_match" ON "crm_synced_rows" USING btree ("binding_id","match_key");--> statement-breakpoint
CREATE INDEX "crm_synced_rows_by_row" ON "crm_synced_rows" USING btree ("row_id");