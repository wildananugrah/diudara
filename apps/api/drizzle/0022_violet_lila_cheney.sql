CREATE TABLE "post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_live_created_idx" ON "post" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "post"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "post_author_created_idx" ON "post" USING btree ("author_id","created_at" DESC NULLS LAST);