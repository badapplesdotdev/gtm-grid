CREATE TABLE "table_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid,
	"token" text NOT NULL,
	"name" text,
	"snapshot" jsonb NOT NULL,
	"snapshot_version" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"expires_at" bigint,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
ALTER TABLE "table_shares" ADD CONSTRAINT "table_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_shares" ADD CONSTRAINT "table_shares_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_shares" ADD CONSTRAINT "table_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "table_shares_by_workspace" ON "table_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "table_shares_by_table" ON "table_shares" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "table_shares_by_token" ON "table_shares" USING btree ("token");