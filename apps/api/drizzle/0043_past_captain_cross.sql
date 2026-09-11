CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lower_user_id" uuid NOT NULL,
	"higher_user_id" uuid NOT NULL,
	"lower_last_read_at" timestamp with time zone,
	"higher_last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_ordered_pair" CHECK ("conversation"."lower_user_id" < "conversation"."higher_user_id")
);
--> statement-breakpoint
CREATE TABLE "direct_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_lower_user_id_app_user_id_fk" FOREIGN KEY ("lower_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_higher_user_id_app_user_id_fk" FOREIGN KEY ("higher_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_message" ADD CONSTRAINT "direct_message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_message" ADD CONSTRAINT "direct_message_sender_id_app_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_pair_unique" ON "conversation" USING btree ("lower_user_id","higher_user_id");--> statement-breakpoint
CREATE INDEX "conversation_lower_idx" ON "conversation" USING btree ("lower_user_id");--> statement-breakpoint
CREATE INDEX "conversation_higher_idx" ON "conversation" USING btree ("higher_user_id");--> statement-breakpoint
CREATE INDEX "direct_message_conversation_created_idx" ON "direct_message" USING btree ("conversation_id","created_at");