CREATE TABLE "lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lists_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "lists_name_length_check" CHECK (char_length("lists"."name") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "list_id" integer;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lists_user_id_name_idx" ON "lists" USING btree ("user_id",lower("name"));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_list_fk" FOREIGN KEY ("list_id","user_id") REFERENCES "public"."lists"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_list_id_idx" ON "tasks" USING btree ("list_id");