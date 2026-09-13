import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 reads the datasource URL from here rather than from a `url` field in
 * schema.prisma. `dotenv/config` loads .env for CLI commands; the running server
 * validates the same variable through src/config/env.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
