CREATE TABLE "community_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "community_document" ADD CONSTRAINT "community_document_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_document" ADD CONSTRAINT "community_document_uploader_id_app_user_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_document_community_created_idx" ON "community_document" USING btree ("community_id","created_at" DESC NULLS LAST) WHERE "community_document"."deleted_at" is null;