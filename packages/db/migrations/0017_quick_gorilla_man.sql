CREATE TYPE "public"."pipeline_execution_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pipeline_execution_target" AS ENUM('local', 'cloud');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_status" AS ENUM('queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'partial', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."pipeline_trigger_type" AS ENUM('row_created', 'row_updated', 'schedule', 'webhook', 'api', 'crm', 'signal');--> statement-breakpoint
CREATE TYPE "public"."pipeline_version_status" AS ENUM('draft', 'deployed', 'superseded');--> statement-breakpoint
CREATE TABLE "pipeline_action_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"receipt_key" text NOT NULL,
	"row_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"actions" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_action_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"actions" integer NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"released" boolean DEFAULT false NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"input_mapping" jsonb NOT NULL,
	"output_mapping" jsonb NOT NULL,
	"execution_target" "pipeline_execution_target" NOT NULL,
	"auto_run" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_node_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"row_run_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"status" "pipeline_execution_status" NOT NULL,
	"error" text,
	"duration_ms" integer,
	"action_consumed" boolean DEFAULT false NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipeline_row_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"batch_id" uuid,
	"row_id" uuid NOT NULL,
	"status" "pipeline_execution_status" NOT NULL,
	"input_hash" text,
	"first_error" text,
	"trace_ref" text,
	"actions_consumed" integer DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipeline_run_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"selector" jsonb NOT NULL,
	"status" "pipeline_execution_status" NOT NULL,
	"lease_owner" text,
	"lease_expires_at" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"total_records" integer NOT NULL,
	"processed_records" integer DEFAULT 0 NOT NULL,
	"failed_records" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"binding_id" uuid,
	"trigger_id" uuid,
	"table_id" uuid,
	"execution_target" "pipeline_execution_target" NOT NULL,
	"status" "pipeline_run_status" NOT NULL,
	"trigger" text NOT NULL,
	"selection" jsonb NOT NULL,
	"requested_by" text,
	"total_records" integer DEFAULT 0 NOT NULL,
	"processed_records" integer DEFAULT 0 NOT NULL,
	"succeeded_records" integer DEFAULT 0 NOT NULL,
	"failed_records" integer DEFAULT 0 NOT NULL,
	"skipped_records" integer DEFAULT 0 NOT NULL,
	"estimated_actions" bigint DEFAULT 0 NOT NULL,
	"reserved_actions" bigint DEFAULT 0 NOT NULL,
	"consumed_actions" bigint DEFAULT 0 NOT NULL,
	"first_error" text,
	"orchestration_id" text,
	"created_at" bigint NOT NULL,
	"started_at" bigint,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipeline_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"binding_id" uuid,
	"type" "pipeline_trigger_type" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "pipeline_version_status" NOT NULL,
	"graph" jsonb NOT NULL,
	"compiled_plan" jsonb NOT NULL,
	"graph_hash" text NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"deployed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_action_ledger" ADD CONSTRAINT "pipeline_action_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_action_ledger" ADD CONSTRAINT "pipeline_action_ledger_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_action_reservations" ADD CONSTRAINT "pipeline_action_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_action_reservations" ADD CONSTRAINT "pipeline_action_reservations_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_bindings" ADD CONSTRAINT "pipeline_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_bindings" ADD CONSTRAINT "pipeline_bindings_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_bindings" ADD CONSTRAINT "pipeline_bindings_version_id_pipeline_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."pipeline_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_bindings" ADD CONSTRAINT "pipeline_bindings_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_node_runs" ADD CONSTRAINT "pipeline_node_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_node_runs" ADD CONSTRAINT "pipeline_node_runs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_node_runs" ADD CONSTRAINT "pipeline_node_runs_row_run_id_pipeline_row_runs_id_fk" FOREIGN KEY ("row_run_id") REFERENCES "public"."pipeline_row_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_row_runs" ADD CONSTRAINT "pipeline_row_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_row_runs" ADD CONSTRAINT "pipeline_row_runs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_row_runs" ADD CONSTRAINT "pipeline_row_runs_batch_id_pipeline_run_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."pipeline_run_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run_batches" ADD CONSTRAINT "pipeline_run_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_run_batches" ADD CONSTRAINT "pipeline_run_batches_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_version_id_pipeline_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."pipeline_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_binding_id_pipeline_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."pipeline_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_trigger_id_pipeline_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."pipeline_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_triggers" ADD CONSTRAINT "pipeline_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_triggers" ADD CONSTRAINT "pipeline_triggers_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_triggers" ADD CONSTRAINT "pipeline_triggers_version_id_pipeline_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."pipeline_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_triggers" ADD CONSTRAINT "pipeline_triggers_binding_id_pipeline_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."pipeline_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_triggers" ADD CONSTRAINT "pipeline_triggers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_action_ledger_receipt" ON "pipeline_action_ledger" USING btree ("receipt_key");--> statement-breakpoint
CREATE INDEX "pipeline_action_ledger_by_workspace_created" ON "pipeline_action_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_action_ledger_by_run" ON "pipeline_action_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pipeline_action_reservations_by_workspace" ON "pipeline_action_reservations" USING btree ("workspace_id","released","expires_at");--> statement-breakpoint
CREATE INDEX "pipeline_action_reservations_by_run" ON "pipeline_action_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_bindings_by_pipeline_table" ON "pipeline_bindings" USING btree ("pipeline_id","table_id");--> statement-breakpoint
CREATE INDEX "pipeline_bindings_by_table" ON "pipeline_bindings" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "pipeline_bindings_by_workspace" ON "pipeline_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_node_runs_once" ON "pipeline_node_runs" USING btree ("run_id","row_id","node_id","generation");--> statement-breakpoint
CREATE INDEX "pipeline_node_runs_by_run_node_status" ON "pipeline_node_runs" USING btree ("run_id","node_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_row_runs_by_run_row" ON "pipeline_row_runs" USING btree ("run_id","row_id");--> statement-breakpoint
CREATE INDEX "pipeline_row_runs_by_run_status" ON "pipeline_row_runs" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_run_batches_by_run_ordinal" ON "pipeline_run_batches" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "pipeline_run_batches_by_status" ON "pipeline_run_batches" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_by_pipeline_created" ON "pipeline_runs" USING btree ("pipeline_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_runs_by_workspace_status" ON "pipeline_runs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_runs_by_table_created" ON "pipeline_runs" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_triggers_by_pipeline" ON "pipeline_triggers" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "pipeline_triggers_by_workspace_enabled" ON "pipeline_triggers" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_versions_by_pipeline_version" ON "pipeline_versions" USING btree ("pipeline_id","version");--> statement-breakpoint
CREATE INDEX "pipeline_versions_by_pipeline_status" ON "pipeline_versions" USING btree ("pipeline_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_versions_by_workspace" ON "pipeline_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pipelines_by_project" ON "pipelines" USING btree ("project_id","archived","updated_at");--> statement-breakpoint
CREATE INDEX "pipelines_by_workspace" ON "pipelines" USING btree ("workspace_id");