-- Records whether a call started as video or as voice.
--
-- Both kinds use the same room and the same token; the difference is what each
-- app publishes on joining. It has to live on the row rather than on the
-- caller's phone, because the person being rung decides whether to open their
-- camera before they have spoken to anyone — and the incoming event is all
-- they have to go on.
--
-- WRITTEN BY HAND, not generated. `prisma migrate dev` has twice produced
-- DROP INDEX statements against the PostGIS GIST indexes alongside the change
-- that was actually wanted: Prisma cannot see those columns, so it reads their
-- indexes as drift and removes them, turning every radius query into a
-- sequential scan with no error to notice. See DECISIONS.md.
--
-- The default is `video`, so a client that has never heard of this column
-- behaves exactly as it did before.
CREATE TYPE "call_kind" AS ENUM ('video', 'audio');

ALTER TABLE "call_sessions" ADD COLUMN "kind" "call_kind" NOT NULL DEFAULT 'video';
