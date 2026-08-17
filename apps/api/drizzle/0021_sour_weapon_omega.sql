CREATE TABLE "follow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_no_self" CHECK ("follow"."follower_id" <> "follow"."followee_id")
);
--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_follower_id_app_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_followee_id_app_user_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_follower_followee_unique" ON "follow" USING btree ("follower_id","followee_id");--> statement-breakpoint
CREATE INDEX "follow_followee_created_idx" ON "follow" USING btree ("followee_id","created_at");--> statement-breakpoint
CREATE INDEX "follow_follower_created_idx" ON "follow" USING btree ("follower_id","created_at");