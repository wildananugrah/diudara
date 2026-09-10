DROP INDEX "post_live_created_idx";--> statement-breakpoint
DROP INDEX "post_author_created_idx";--> statement-breakpoint
CREATE INDEX "post_live_created_idx" ON "post" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "post"."deleted_at" is null and "post"."community_id" is null;--> statement-breakpoint
CREATE INDEX "post_author_created_idx" ON "post" USING btree ("author_id","created_at" DESC NULLS LAST) WHERE "post"."deleted_at" is null and "post"."community_id" is null;