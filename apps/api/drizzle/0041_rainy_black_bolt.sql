-- HAND-REORDERED after generation, and it must stay this way.
--
-- drizzle emitted `user_subscription_tier_community_fk` BEFORE the
-- `user_tier_id_community_unique` index it references, and Postgres refuses a
-- composite foreign key whose target has no matching unique constraint yet.
-- The unique index is therefore moved above the ALTER TABLE that needs it.
--
-- If this migration is ever regenerated, re-apply the same reordering.

DROP INDEX "user_subscription_one_active";--> statement-breakpoint
DROP INDEX "user_subscription_one_pending";--> statement-breakpoint
ALTER TABLE "user_subscription" ADD COLUMN "community_id" uuid;--> statement-breakpoint
ALTER TABLE "user_subscription" ADD CONSTRAINT "user_subscription_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscription_one_active_personal" ON "user_subscription" USING btree ("subscriber_id","owner_id") WHERE "user_subscription"."status" = 'active' and "user_subscription"."community_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscription_one_pending_personal" ON "user_subscription" USING btree ("subscriber_id","owner_id") WHERE "user_subscription"."status" = 'pending' and "user_subscription"."community_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_tier_id_community_unique" ON "user_tier" USING btree ("id","community_id");--> statement-breakpoint
ALTER TABLE "user_subscription" ADD CONSTRAINT "user_subscription_tier_community_fk" FOREIGN KEY ("tier_id","community_id") REFERENCES "public"."user_tier"("id","community_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscription_one_active" ON "user_subscription" USING btree ("subscriber_id","owner_id","community_id") WHERE "user_subscription"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscription_one_pending" ON "user_subscription" USING btree ("subscriber_id","owner_id","community_id") WHERE "user_subscription"."status" = 'pending';