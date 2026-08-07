ALTER TABLE "subscription" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "activity_log_member_id_idx" ON "activity_log" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "activity_log_community_id_idx" ON "activity_log" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "channel_community_id_idx" ON "channel" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "community_creator_id_idx" ON "community" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "course_community_id_idx" ON "course" USING btree ("community_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_email_unique" ON "creator" USING btree ("email") WHERE "creator"."email" is not null;--> statement-breakpoint
CREATE INDEX "enrollment_member_id_idx" ON "enrollment" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "enrollment_course_id_idx" ON "enrollment" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "event_rsvp_member_id_idx" ON "event_rsvp" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "event_rsvp_event_id_idx" ON "event_rsvp" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_community_id_idx" ON "event" USING btree ("community_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_stream_key_unique" ON "event" USING btree ("stream_key") WHERE "event"."stream_key" is not null;--> statement-breakpoint
CREATE INDEX "membership_tier_community_id_idx" ON "membership_tier" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "subscription_member_id_idx" ON "subscription" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "subscription_tier_id_idx" ON "subscription" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "transaction_subscription_id_idx" ON "transaction" USING btree ("subscription_id");