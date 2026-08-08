ALTER TABLE "creator" ALTER COLUMN "whatsapp_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "slug" varchar(120) NOT NULL;--> statement-breakpoint
ALTER TABLE "creator" ADD COLUMN "password_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "community" ADD CONSTRAINT "community_slug_unique" UNIQUE("slug");