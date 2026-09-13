-- CreateEnum
CREATE TYPE "theme_preference" AS ENUM ('system', 'light', 'dark');

-- CreateEnum
CREATE TYPE "distance_unit" AS ENUM ('miles', 'kilometres');

-- CreateTable
CREATE TABLE "user_settings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "theme" "theme_preference" NOT NULL DEFAULT 'system',
    "text_scale" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "reduce_motion" BOOLEAN NOT NULL DEFAULT false,
    "high_contrast" BOOLEAN NOT NULL DEFAULT false,
    "distance_unit" "distance_unit" NOT NULL DEFAULT 'miles',
    "show_distance" BOOLEAN NOT NULL DEFAULT true,
    "show_last_active" BOOLEAN NOT NULL DEFAULT true,
    "incognito" BOOLEAN NOT NULL DEFAULT false,
    "global_verified_only" BOOLEAN NOT NULL DEFAULT false,
    "pause_new_matches" BOOLEAN NOT NULL DEFAULT false,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN
-- ============================================================================

-- Text scale is an accessibility multiplier, not an arbitrary number. Below
-- 0.8 the UI is unreadable; above 2.0 it stops laying out at all.
ALTER TABLE "user_settings"
  ADD CONSTRAINT "user_settings_text_scale_check"
  CHECK ("text_scale" >= 0.8 AND "text_scale" <= 2.0);

-- ============================================================================
-- NOTE FOR WHOEVER GENERATES THE NEXT MIGRATION  (third occurrence)
--
-- Prisma emitted DROP INDEX for the four PostGIS GIST indexes again. Removed by
-- hand, as in 20260813204346 and 20260820093345.
--
-- It cannot see them: their columns are Unsupported() in schema.prisma, so it
-- reads them as drift on EVERY migration. It will do this again. Dropping them
-- applies cleanly and silently turns every radius query into a sequential scan.
--
-- ALWAYS read generated migration SQL before applying it.
-- tests/integration/postgis.test.ts asserts all four still exist.
-- ============================================================================
