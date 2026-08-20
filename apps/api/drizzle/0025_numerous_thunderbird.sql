CREATE TABLE "user_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_subscription_no_self" CHECK ("user_subscription"."subscriber_id" <> "user_subscription"."owner_id")
);
--> statement-breakpoint
CREATE TABLE "user_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_subscription_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"gateway_reference_id" varchar(255),
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_subscription" ADD CONSTRAINT "user_subscription_subscriber_id_app_user_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscription" ADD CONSTRAINT "user_subscription_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscription" ADD CONSTRAINT "user_subscription_tier_owner_fk" FOREIGN KEY ("tier_id","owner_id") REFERENCES "public"."user_tier"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_transaction" ADD CONSTRAINT "user_transaction_user_subscription_id_user_subscription_id_fk" FOREIGN KEY ("user_subscription_id") REFERENCES "public"."user_subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscription_one_active" ON "user_subscription" USING btree ("subscriber_id","owner_id") WHERE "user_subscription"."status" = 'active';--> statement-breakpoint
CREATE INDEX "user_subscription_owner_idx" ON "user_subscription" USING btree ("owner_id");