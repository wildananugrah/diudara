CREATE TABLE "stream_viewer_heartbeat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_id" uuid NOT NULL,
	"identity" varchar(64) NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stream_viewer_heartbeat" ADD CONSTRAINT "stream_viewer_heartbeat_stream_id_user_stream_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."user_stream"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stream_viewer_heartbeat_stream_identity_unique" ON "stream_viewer_heartbeat" USING btree ("stream_id","identity");--> statement-breakpoint
CREATE INDEX "stream_viewer_heartbeat_stream_last_seen_idx" ON "stream_viewer_heartbeat" USING btree ("stream_id","last_seen_at");