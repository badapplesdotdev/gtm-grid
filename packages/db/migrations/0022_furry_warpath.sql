ALTER TABLE "crm_sync_runs" ADD COLUMN "last_progress_at" bigint;
UPDATE "crm_sync_runs"
SET "last_progress_at" = COALESCE("finished_at", "started_at");
ALTER TABLE "crm_sync_runs" ALTER COLUMN "last_progress_at" SET NOT NULL;
