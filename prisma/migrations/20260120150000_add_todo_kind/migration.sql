DO $$
BEGIN
  CREATE TYPE "public"."TodoKind" AS ENUM ('OPEN_LOOP', 'COMMITMENT', 'HABIT', 'REMINDER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "public"."Todo"
ADD COLUMN IF NOT EXISTS "kind" "public"."TodoKind" NOT NULL DEFAULT 'OPEN_LOOP';
