ALTER TABLE "webhooks" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "source_table_id" uuid;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_source_table_id_tables_id_fk" FOREIGN KEY ("source_table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhooks_by_source_table" ON "webhooks" USING btree ("source_table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_push_connection_unique" ON "webhooks" USING btree ("source_table_id","table_id") WHERE "webhooks"."source" = 'push';