CREATE TABLE "user_stream" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(140) NOT NULL,
	"visibility" varchar(16) DEFAULT 'public' NOT NULL,
	"stream_key" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'live' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "user_stream_stream_key_unique" UNIQUE("stream_key")
);
--> statement-breakpoint
ALTER TABLE "user_stream" ADD CONSTRAINT "user_stream_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_stream_one_live" ON "user_stream" USING btree ("owner_id") WHERE "user_stream"."status" = 'live';--> statement-breakpoint
CREATE INDEX "user_stream_live_started_idx" ON "user_stream" USING btree ("started_at" DESC NULLS LAST) WHERE "user_stream"."status" = 'live';