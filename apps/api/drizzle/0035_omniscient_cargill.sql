CREATE TABLE "community" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"category" varchar(64) NOT NULL,
	"description" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "community_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community" ADD CONSTRAINT "community_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_member" ADD CONSTRAINT "community_member_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_member" ADD CONSTRAINT "community_member_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_owner_idx" ON "community" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "community_category_created_idx" ON "community" USING btree ("category","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "community_member_unique" ON "community_member" USING btree ("community_id","user_id");--> statement-breakpoint
CREATE INDEX "community_member_user_idx" ON "community_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "community_member_community_joined_idx" ON "community_member" USING btree ("community_id","joined_at");