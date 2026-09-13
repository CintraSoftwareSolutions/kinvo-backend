-- Make users.date_of_birth nullable.
--
-- Google, Apple, and Twilio do not supply a date of birth, so a social or phone
-- signup cannot know the user's age at the moment the account is created
-- (spec §5.1). The under-18 rejection now fires when a date of birth is set,
-- and a user without one stays `pending` — blocked from discovery, matching,
-- and chat. Email registration still requires it up front.

ALTER TABLE "users" ALTER COLUMN "date_of_birth" DROP NOT NULL;

-- ============================================================================
-- NOTE FOR WHOEVER GENERATES THE NEXT MIGRATION
--
-- Prisma generated four `DROP INDEX` statements here for the GIST indexes on
-- profiles, venues, live_location_pings, and emergency_events. They were
-- removed by hand.
--
-- Prisma has no knowledge of those indexes because their columns are
-- Unsupported() in schema.prisma, so it reads them as drift and helpfully
-- offers to delete them. Dropping them would silently turn every radius query
-- into a sequential scan — the migration would apply cleanly and the app would
-- just get slower and slower as the user table grew.
--
-- ALWAYS read generated migration SQL before applying it. The GIST-index
-- assertion in tests/integration/postgis.test.ts is the backstop.
-- ============================================================================
