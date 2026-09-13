/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],

  // Runs before the test framework and before any src module is imported, so
  // src/config/env.ts sees a fully populated environment.
  setupFiles: ['<rootDir>/tests/setup.ts'],

  // Applies migrations to the test database once per run, so `npm test` works
  // from a clean checkout with only `docker compose up` (spec §0.4).
  globalSetup: '<rootDir>/tests/globalSetup.ts',

  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },

  // Must mirror the "paths" block in tsconfig.json.
  moduleNameMapper: {
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@middleware/(.*)$': '<rootDir>/src/middleware/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Spec 0.4: 80% line coverage on src/, excluding config and migrations.
  // server.ts is the process bootstrap (listen + signal handlers) and cannot be
  // exercised without binding a port.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/config/**',
    '!src/types/**',
    '!src/generated/**',
    '!src/server.ts',
  ],
  coverageThreshold: {
    global: { lines: 80, statements: 80, functions: 80, branches: 70 },
  },
  coverageReporters: ['text-summary', 'lcov'],

  // Every suite shares one test database and truncates it between tests, so
  // parallel workers would wipe each other's rows mid-test. `npm test` passes
  // --runInBand, but this makes a bare `npx jest` safe too rather than leaving
  // it as a convention someone can forget.
  //
  // WHAT THIS DOES NOT PROTECT AGAINST: two separate jest PROCESSES against the
  // same database. This setting is per-process, so running a focused suite while
  // a full run is going produces failures that look nothing like their cause —
  // `40P01 deadlock detected` inside the entitlement seed, and truncations
  // landing mid-test in whichever run got there second. Both runs then report
  // failures that neither the code nor the tests are responsible for.
  //
  // One test process per database. In CI that means one database per job, not a
  // shared instance two jobs happen to point at.
  maxWorkers: 1,

  clearMocks: true,
  restoreMocks: true,
  // Integration tests truncate and re-seed against a real Postgres.
  //
  // Sixty seconds is far more than any test needs and is deliberately a
  // CEILING rather than a delay: nothing waits for it. It was raised from 30s
  // after `beforeEach(resetDatabase)` — a single TRUNCATE ... CASCADE — began
  // exceeding the hook timeout on a host whose process spawning had slowed
  // sharply. Those failures said nothing about the code: the same suite passed
  // in isolation moments later. A timeout that fails on machine speed rather
  // than behaviour teaches the team to re-run rather than to read.
  testTimeout: 60000,
  verbose: false,
};
