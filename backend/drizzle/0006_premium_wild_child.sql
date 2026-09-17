CREATE TABLE IF NOT EXISTS "live_viewers" (
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_viewers_session_id_user_id_pk" PRIMARY KEY("session_id","user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_viewers" ADD CONSTRAINT "live_viewers_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_viewers" ADD CONSTRAINT "live_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_viewers_seen_idx" ON "live_viewers" USING btree ("session_id","last_seen_at");--> statement-breakpoint
ALTER TABLE "live_sessions" DROP COLUMN IF EXISTS "viewer_count";