-- Admin panel: venue curation and plan rollout state (Batch 15).
--
-- PURELY ADDITIVE. One new enum and four new columns, every one with a DEFAULT
-- so existing rows are valid immediately. Nothing the mobile app reads changes:
-- `is_active` keeps its exact meaning on both tables, and these sit beside it
-- rather than replacing it.
--
-- `venues.is_reviewed` defaults TRUE on purpose. Seeded venues are reviewed by
-- definition, and defaulting false would drop all twenty into the review queue
-- the moment this is applied.
--
-- 4 GIST index drops were generated and removed again — the fourth time.
-- See tests/unit/migrations.test.ts, which now fails on them.
-- CreateEnum
CREATE TYPE "plan_rollout_state" AS ENUM ('live', 'promo', 'draft', 'grandfathered');

-- AlterTable
ALTER TABLE "subscription_products" ADD COLUMN     "rollout_note" VARCHAR(300),
ADD COLUMN     "rollout_state" "plan_rollout_state" NOT NULL DEFAULT 'live';

-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "is_featured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_reviewed" BOOLEAN NOT NULL DEFAULT true;
