CREATE TABLE "signal_seen_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_seen_keys" ADD CONSTRAINT "signal_seen_keys_binding_id_signal_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."signal_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_seen_keys_by_binding_key" ON "signal_seen_keys" USING btree ("binding_id","key");