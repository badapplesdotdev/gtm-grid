CREATE TABLE "lifecycle_email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid,
	"template" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_prefs" jsonb;--> statement-breakpoint
ALTER TABLE "lifecycle_email_sends" ADD CONSTRAINT "lifecycle_email_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_email_sends" ADD CONSTRAINT "lifecycle_email_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_sends_once" ON "lifecycle_email_sends" USING btree ("user_id","template","dedupe_key");--> statement-breakpoint
CREATE INDEX "lifecycle_sends_by_user" ON "lifecycle_email_sends" USING btree ("user_id");