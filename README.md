# Kinvo Backend

REST API for Kinvo, a multi-mode social connection app. Clients are a Flutter mobile app and a future admin web console.

- **Product specification:** `KINVO_BACKEND_BUILD.md` — the source of truth for behaviour.
- **Working conventions:** `CLAUDE.md` — stack, layout, house rules, batch process.

## Requirements

- Node.js **24** (`.nvmrc`)
- Docker Desktop — Postgres 16 + PostGIS and Redis run in containers

## Setup

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run db:up             # postgres on :5433, redis on :6380
npm run db:deploy         # apply migrations
npm run db:seed           # catalogues, entitlements, venues, 30 dev users
npm run dev
```

Verify:

```bash
curl http://localhost:3000/api/v1/health
```

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "api_version": "v1",
    "environment": "development",
    "uptime_seconds": 3,
    "checked_at": "2026-08-13T09:41:00.000Z"
  },
  "meta": null
}
```

`/health` is also served unversioned at `/health` for container and load-balancer probes.

## Scripts

| Command                     | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| `npm run dev`               | Watch mode via tsx                                   |
| `npm run build`             | Compile to `dist/`, rewriting path aliases           |
| `npm start`                 | Run the compiled build                               |
| `npm test`                  | Jest suite                                           |
| `npm run test:coverage`     | Coverage with the 80% threshold enforced             |
| `npm run typecheck`         | `tsc --noEmit`                                       |
| `npm run lint` / `lint:fix` | ESLint                                               |
| `npm run format`            | Prettier                                             |
| `npm run db:up` / `db:down` | Start / stop Postgres and Redis                      |
| `npm run db:migrate`        | Create and apply a migration (development)           |
| `npm run db:deploy`         | Apply committed migrations (CI, staging, production) |
| `npm run db:seed`           | Populate development data (idempotent)               |
| `npm run db:reset`          | Drop, re-migrate, re-seed                            |
| `npm run db:generate`       | Regenerate the Prisma client                         |
| `npm run db:studio`         | Browse the database in Prisma Studio                 |

## Configuration

Every variable is documented in `.env.example` and validated by `src/config/env.ts` at boot. A missing or malformed required variable **exits the process** rather than starting half-configured.

## Notes

- The API is versioned at `/api/v1`.
- Docker publishes Postgres on **5433** and Redis on **6380** to avoid colliding with local installs. A `kinvo_test` database is created on first container start for the test suite.
- **MinIO** provides S3 locally: API on `:9100`, web console on `:9101` (login `kinvo` / `kinvo-dev-secret`). Buckets `kinvo-media` and `kinvo-verification` are created automatically and are both private.
- **Tests require Docker.** `npm test` migrates the `kinvo_test` database automatically before running, and truncates it between tests. It never touches `kinvo_dev`.
- After seeding, sign in as any dev user — for example `sarah.dev@kinvo.test` / `kinvo-dev-password`.
- Without Twilio credentials, phone OTP falls back to a development stub that sends no SMS and accepts the code `000000`. Production refuses to start without real credentials, so that stub cannot reach real users.
- Prisma 7 generates its client into `src/generated/prisma` (git-ignored, rebuilt on install). Import from `@/db/prisma`, never from that path directly.
- PostGIS columns cannot be read or written through Prisma. All spatial queries live in `src/db/geo.ts`.

---

## Deployment

Staging runs on a single EC2 instance behind CloudFront. Terraform in `infra/`
defines it; `infra/deploy.sh` runs on the instance and is invoked through SSM.

### How a deploy works

```bash
# 1. Package the committed tree. `git archive` honours .gitignore, so .env,
#    node_modules, dist and the generated Prisma client cannot ride along.
git archive --format=tar.gz -o /tmp/kinvo-src.tar.gz HEAD

# 2. Hand it to the instance through S3.
aws s3 cp /tmp/kinvo-src.tar.gz "s3://$BUCKET/_deploy/kinvo-src.tar.gz" --region us-east-1

# 3. Run the deploy over SSM. There is no inbound SSH; the security group
#    accepts only CloudFront's origin-facing prefix list.
aws ssm send-command --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"/opt/kinvo/deploy.sh $BUCKET $ECR_IMAGE_TAG\"]"
```

`deploy.sh` then replaces the extracted tree, builds the runtime image, builds
the builder stage as a migrator, applies migrations, restarts the API, and
health-checks it before reporting success.

**GitHub is not in the deploy path.** Where the repository lives has no bearing
on deployment.

### Why the image is built on the instance

An 877 MB image push from a typical office uplink times out repeatedly; the
source archive is around 500 KB and AWS builds it on its own network in a couple
of minutes. The trade is a slower, memory-tighter build host — the instance has
under 2 GB of RAM plus swap — in exchange for a deploy that finishes.

### Things that have actually gone wrong here

Each of these cost real time and is now guarded against. Read before changing
the deploy path.

| What happened                                                                                                                                                                                                                                     | Guard                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tar` unpacked over the previous tree, so files deleted in a commit stayed on the instance and were compiled alongside the new ones. The build failed on files that were not in the repository.                                                   | `deploy.sh` deletes the extraction directory before unpacking.                                                     |
| Build output was piped through `tail -5`, so a compile error scrolled past in the discarded lines and the log showed only `exit code: 2`.                                                                                                         | Build output goes to `/tmp/kinvo-build.log`; on failure the real tail plus any `error TS` / OOM lines are printed. |
| A deploy was pointed at a convenient image tag rather than the ECR URI compose actually runs, so it built an image, restarted nothing, health-checked the old container, and reported success.                                                    | Always pass the full ECR URI as the image tag.                                                                     |
| A one-line `Caddyfile` written through SSM took staging down for two minutes, because `printf` newlines were mangled through JSON.                                                                                                                | Send file content base64-encoded, and back up before overwriting.                                                  |
| Terraform wanted to **replace** the running instance, which would have destroyed the database.                                                                                                                                                    | `lifecycle { ignore_changes = [user_data] }` on the instance. **Always read a `terraform plan` before applying.**  |
| A migration generated by `prisma migrate dev` tried to drop the PostGIS GIST indexes, because those columns are `Unsupported()` and Prisma reads their indexes as drift. Applying it would have turned every radius query into a sequential scan. | **Read generated SQL before applying it.**                                                                         |

### Ordering rule for schema changes

Build first, then migrate, then restart. Applying a database change before the
new image is known to build leaves the old code running against the new schema —
which is how `/subscriptions/products` returned 500 on staging for half an hour
after a column was dropped.

### Verifying a deploy

```bash
BASE=https://<distribution>.cloudfront.net
curl -s $BASE/api/v1/health
curl -s $BASE/api/v1/docs/openapi.json | grep -c '"operationId"'   # endpoint count
```

Then sign in as a seeded user and walk the parameterless GETs. `/moderation/flags`
and `/reports/review` returning 403 for a normal account is correct.

### Seeding a deployed environment

**There is no supported path today.** The runtime image installs production
dependencies only, so it has no `tsx` and cannot run `prisma/seed.ts`. Staging
has been corrected with hand-written SQL when needed. Worth fixing before there
is data worth protecting.

---

## The contract as files

The running API serves `/api/v1/docs` (Swagger UI), `/api/v1/docs/openapi.json`
and `/api/v1/docs/realtime.json`. Those stay the authority.

`npm run docs:export` also writes them to `docs/`, and those files are
**committed on purpose**: a generated contract in the repository turns a
breaking change into a visible diff. Renaming an error code or dropping an
endpoint shows up in review rather than being discovered by a client at runtime.

```bash
npm run docs:export     # -> docs/openapi.yaml, docs/realtime.json
```

## Load-testing the deck

`GET /discovery/:mode/deck` is the only endpoint worth load-testing: it is the
one place a PostGIS radius search, six simultaneous filters and a ranking pass
run on every request, and it is the product's first screen. Everything else is
an indexed lookup or a cursor page.

```bash
npm run db:up
npm run dev                                  # in another terminal
npm run loadtest:seed                        # LOAD_POPULATION=20000 by default
npm run loadtest
npx tsx tests/load/seed-population.ts --clear  # remove the synthetic users
```

The test measures latency percentiles **and** checks the query plan, because a
load test passes happily on a sequential scan while the table is small and then
falls over in production. It fails if the radius query stops using the GIST
index — which is exactly what a generated migration tried to remove in Batch 14.

Tunable through the environment: `LOAD_TARGET`, `LOAD_POPULATION`,
`LOAD_DURATION`, `LOAD_CONNECTIONS`, `LOAD_VIEWERS`, `LOAD_P99_CEILING`.

**Do not point it at staging.** That instance has under 2 GB of RAM shared with
its own Postgres, so a run there measures the box, not the query.
