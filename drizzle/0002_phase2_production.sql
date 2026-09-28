ALTER TABLE "projects" ADD COLUMN "voiceover_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "narration_timing_source" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "autopilot" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "render_report" jsonb;