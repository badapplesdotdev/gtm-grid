CREATE TABLE "signal_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"search_id" text,
	"config" jsonb NOT NULL,
	"schedule" text NOT NULL,
	"columns" jsonb NOT NULL,
	"seen" jsonb,
	"last_synced_at" bigint,
	"last_error" text,
	"rows_pulled" integer,
	"enabled" boolean NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_bindings" ADD CONSTRAINT "signal_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_bindings" ADD CONSTRAINT "signal_bindings_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_bindings_by_workspace" ON "signal_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "signal_bindings_by_table" ON "signal_bindings" USING btree ("table_id");