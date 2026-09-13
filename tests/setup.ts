/**
 * Runs before the test framework and before any src module loads.
 *
 * src/config/env.ts throws on a missing required variable, so the test
 * environment must be complete here.
 */
process.env.NODE_ENV = 'test';

// Silences pino and, importantly, keeps pino-pretty's worker thread out of the
// run — an open worker prevents Jest from exiting.
process.env.LOG_LEVEL = 'silent';

/**
 * The test database is set UNCONDITIONALLY, not with `??=`.
 *
 * tests/helpers/db.ts truncates every table between tests. If .env leaked its
 * DATABASE_URL into a test run, that truncate would wipe the developer's
 * development data. Overriding here makes that impossible; TEST_DATABASE_URL is
 * the only way to point the suite elsewhere.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kinvo:kinvo@localhost:5433/kinvo_test';

// Fixed, obviously-fake signing keys. Tests must be deterministic, and a random
// secret per run would make a token minted in one suite unverifiable in another.
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-not-for-any-real-deployment-0001';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-not-for-any-real-deployment-002';

process.env.PORT ??= '3001';
process.env.HOST ??= '127.0.0.1';
process.env.CORS_ORIGINS ??= '*';
process.env.JSON_BODY_LIMIT ??= '1mb';
process.env.REDIS_URL ??= 'redis://localhost:6380';

/**
 * Media storage. Tests run against the MinIO container from docker-compose, not
 * a fake — the presigning, the direct PUT, and the private-bucket policy are all
 * exercised for real (spec §0.4 mocks external HTTP only, and this is ours).
 */
process.env.S3_ENDPOINT ??= 'http://localhost:9100';
process.env.S3_FORCE_PATH_STYLE ??= 'true';
process.env.S3_ACCESS_KEY_ID ??= 'kinvo';
process.env.S3_SECRET_ACCESS_KEY ??= 'kinvo-dev-secret';
process.env.S3_MEDIA_BUCKET ??= 'kinvo-media';
process.env.S3_VERIFICATION_BUCKET ??= 'kinvo-verification';
