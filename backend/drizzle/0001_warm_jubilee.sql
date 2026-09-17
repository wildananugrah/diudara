ALTER TABLE "syllabus_items" ADD COLUMN "upload_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "syllabus_items" ADD CONSTRAINT "syllabus_items_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
