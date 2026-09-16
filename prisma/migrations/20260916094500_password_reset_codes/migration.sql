-- Password reset becomes a six-digit emailed code instead of a link token.
--
-- The old credential was 256 bits of base64url, mailed as a link. Nothing ever
-- mailed it: delivery was deferred to Batch 11 and never wired up, and the app
-- has no verified domain or release signing key, so an https link cannot be
-- claimed by the app on either platform yet. A code the user types works from
-- any mailbox on any device and needs neither.
--
-- Six digits are guessable in a way the old token was not, so two things change
-- with it: the code is only ever looked up alongside the account it belongs to
-- (never by hash alone), and wrong guesses are counted against the row.

-- DropIndex
-- A six-digit hash is no longer a global lookup key, and two accounts holding
-- the same six digits at once is ordinary rather than a collision to reject.
DROP INDEX "password_reset_tokens_token_hash_key";

-- AlterTable
ALTER TABLE "password_reset_tokens" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- Retire anything still outstanding. Those rows hold hashes of link tokens,
-- which the new endpoint has no way to accept — leaving them unused would keep
-- rows alive that can never be redeemed, and would let an account sit with a
-- stale credential it cannot see. Users with one in flight request a new code.
UPDATE "password_reset_tokens" SET "used_at" = now() WHERE "used_at" IS NULL;
