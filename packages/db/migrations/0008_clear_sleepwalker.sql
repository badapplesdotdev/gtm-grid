ALTER TABLE "tables" ADD COLUMN "dedupe_column" uuid;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "dedupe_keep" text;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_dedupe_column_columns_id_fk" FOREIGN KEY ("dedupe_column") REFERENCES "public"."columns"("id") ON DELETE set null ON UPDATE no action;