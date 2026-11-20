ALTER TABLE "tasks" ADD COLUMN "repeat_unit" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_every" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_anchor" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeated_from_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeated_from_id_tasks_id_fk" FOREIGN KEY ("repeated_from_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeated_from_id_unique" UNIQUE("repeated_from_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_unit_check" CHECK ("tasks"."repeat_unit" in ('day', 'week', 'month', 'year'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_every_check" CHECK ("tasks"."repeat_every" between 1 and 99);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_complete_check" CHECK (("tasks"."repeat_unit" is null) = ("tasks"."repeat_every" is null) and ("tasks"."repeat_unit" is null) = ("tasks"."repeat_anchor" is null));