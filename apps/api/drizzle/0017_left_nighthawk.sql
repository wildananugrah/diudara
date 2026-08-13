CREATE TABLE "join_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid
);
--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "access_mode" varchar(16) DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_tier_id_membership_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_decided_by_creator_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."creator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_request_community_member_pending_unique" ON "join_request" USING btree ("community_id","member_id") WHERE "join_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "join_request_community_status_idx" ON "join_request" USING btree ("community_id","status");