CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" varchar(30) NOT NULL,
	"email" varchar(255) NOT NULL,
	"whatsapp_number" varchar(32),
	"password_hash" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"bio" varchar(300),
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_handle_unique" UNIQUE("handle"),
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
