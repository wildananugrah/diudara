ALTER TABLE "channel_membership" ADD COLUMN "link_minted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_membership" ADD COLUMN "mint_lease_until" timestamp with time zone;