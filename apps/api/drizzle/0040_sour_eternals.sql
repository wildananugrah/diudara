ALTER TABLE "community_document" ADD COLUMN "members_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_tier" ADD COLUMN "community_id" uuid;--> statement-breakpoint
ALTER TABLE "user_tier" ADD CONSTRAINT "user_tier_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tier_community_idx" ON "user_tier" USING btree ("community_id") WHERE "user_tier"."community_id" is not null;