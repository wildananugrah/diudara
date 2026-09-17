CREATE TABLE IF NOT EXISTS "live_watch_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_sessions" ADD COLUMN "publish_secret" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_watch_tokens" ADD CONSTRAINT "live_watch_tokens_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_watch_tokens" ADD CONSTRAINT "live_watch_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_watch_tokens_session_idx" ON "live_watch_tokens" USING btree ("session_id");