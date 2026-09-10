CREATE TABLE "post_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "community_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "type" varchar(16) DEFAULT 'diskusi' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_comment" ADD CONSTRAINT "post_comment_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comment" ADD CONSTRAINT "post_comment_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_comment_post_created_idx" ON "post_comment" USING btree ("post_id","created_at") WHERE "post_comment"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_community_created_idx" ON "post" USING btree ("community_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "post"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_personal_has_no_type" CHECK ("post"."community_id" is not null or "post"."type" = 'diskusi');--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_community_is_public" CHECK ("post"."community_id" is null or "post"."visibility" = 'public');