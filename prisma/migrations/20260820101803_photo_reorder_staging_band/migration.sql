-- Widen the photo position CHECK to allow a transient negative staging band.
--
-- Reordering photos cannot go straight from the old order to the new one: the
-- partial unique index on (profile_id, position) rejects any sequence that
-- passes through a duplicate position, and every non-trivial reorder does.
-- The fix is a two-phase update inside one transaction — park every photo at a
-- negative position, then land them in the requested order.
--
-- The original constraint from the init migration allowed only 0..5, so phase
-- one failed and reorder was impossible. The band is bounded at -6 because a
-- profile may hold at most 6 photos, and negative values only ever exist
-- between the two phases of a single transaction: no committed row is
-- reachable with one.

ALTER TABLE "photos" DROP CONSTRAINT "photos_position_range_check";

ALTER TABLE "photos"
  ADD CONSTRAINT "photos_position_range_check"
  CHECK ("position" >= -6 AND "position" <= 5);
