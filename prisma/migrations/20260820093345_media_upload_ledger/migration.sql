-- Media upload ledger (spec §7, Batch 4).
--
-- `profile_photo` joins the media kinds so profile photo uploads use the same
-- two-step handshake as everything else, and `uploaded_at` records the moment
-- storage confirmed the bytes actually arrived.

-- AlterEnum
ALTER TYPE "media_kind" ADD VALUE 'profile_photo';

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "uploaded_at" TIMESTAMP(3);

-- ============================================================================
-- NOTE FOR WHOEVER GENERATES THE NEXT MIGRATION  (second occurrence)
--
-- Prisma again emitted four `DROP INDEX` statements here for the PostGIS GIST
-- indexes on profiles, venues, live_location_pings, and emergency_events.
-- Removed by hand, exactly as in 20260813204346_nullable_date_of_birth.
--
-- Prisma cannot see those indexes because their columns are Unsupported() in
-- schema.prisma, so it reads them as drift on EVERY migration and offers to
-- delete them. It will do this again next time. Dropping them applies cleanly
-- and silently turns every radius query into a sequential scan.
--
-- ALWAYS read generated migration SQL before applying it.
-- The GIST assertion in tests/integration/postgis.test.ts is the backstop.
-- ============================================================================
