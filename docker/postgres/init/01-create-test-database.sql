-- Runs once, on first initialisation of the Postgres volume.
-- The test suite needs its own database so a `npm test` run never truncates
-- development data (spec 0.4: tests seed and clean their own data).
CREATE DATABASE kinvo_test OWNER kinvo;

-- The PostGIS extension is created per database by the first Prisma migration
-- (Batch 1), so it travels with the schema to CI and production rather than
-- depending on this local-only script.
