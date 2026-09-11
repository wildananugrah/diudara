CREATE TABLE "community_event" (
	"post_id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" varchar(200),
	CONSTRAINT "community_event_ends_after_starts" CHECK ("community_event"."ends_at" is null or "community_event"."ends_at" > "community_event"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "community_event" ADD CONSTRAINT "community_event_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_event" ADD CONSTRAINT "community_event_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_event_community_starts_idx" ON "community_event" USING btree ("community_id","starts_at");