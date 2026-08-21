CREATE TABLE "membership_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_subscription_id" uuid NOT NULL,
	"outcome" varchar(24) DEFAULT 'claimed' NOT NULL,
	"channels" varchar(32),
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_reminder" ADD CONSTRAINT "membership_reminder_subscription_fk" FOREIGN KEY ("user_subscription_id") REFERENCES "public"."user_subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_reminder_subscription_unique" ON "membership_reminder" USING btree ("user_subscription_id");