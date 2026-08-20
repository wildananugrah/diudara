CREATE TABLE "user_tier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"price_amount" integer NOT NULL,
	"billing_cycle" varchar(16) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_tier" ADD CONSTRAINT "user_tier_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tier_owner_idx" ON "user_tier" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tier_id_owner_unique" ON "user_tier" USING btree ("id","owner_id");