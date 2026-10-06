-- Venues from a places provider (DECISIONS.md, 6 Oct 2026), alongside Kinvo's
-- own curated list. external_id is unique per source, so refreshing an area
-- updates the places it already has instead of adding them again.
CREATE TYPE "venue_source" AS ENUM ('curated', 'geoapify');

ALTER TABLE "venues"
  ADD COLUMN "source" "venue_source" NOT NULL DEFAULT 'curated',
  ADD COLUMN "external_id" VARCHAR(255);

CREATE UNIQUE INDEX "venues_source_external_id_key" ON "venues"("source", "external_id");
