CREATE TABLE "sheet_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_name" text NOT NULL,
	"sheet_title" text NOT NULL,
	"header_row" integer NOT NULL,
	"columns" jsonb NOT NULL,
	"key_header" text,
	"schedule" text NOT NULL,
	"enabled" boolean NOT NULL,
	"paused_reason" text,
	"last_synced_at" bigint,
	"last_error" text,
	"rows_synced" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_synced_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"values_hash" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_bindings" ADD CONSTRAINT "sheet_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_bindings" ADD CONSTRAINT "sheet_bindings_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_synced_rows" ADD CONSTRAINT "sheet_synced_rows_binding_id_sheet_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."sheet_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_synced_rows" ADD CONSTRAINT "sheet_synced_rows_row_id_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sheet_bindings_by_workspace" ON "sheet_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sheet_bindings_by_table" ON "sheet_bindings" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_bindings_by_table_source" ON "sheet_bindings" USING btree ("table_id","spreadsheet_id","sheet_title");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_synced_rows_by_binding_key" ON "sheet_synced_rows" USING btree ("binding_id","external_key");--> statement-breakpoint
CREATE INDEX "sheet_synced_rows_by_row" ON "sheet_synced_rows" USING btree ("row_id");