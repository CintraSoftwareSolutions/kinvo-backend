# CLAUDE.md — Kinvo Backend

Working notes for anyone (human or agent) touching this repository.
The authoritative product specification is `KINVO_BACKEND_BUILD.md`. **Read it before changing behaviour.** This file is the operational summary, not a replacement.

---

## What this is

REST API for **Kinvo**, a multi-mode social connection app. Clients: a Flutter mobile app, and a future admin web client. **APIs only** — no web frontend, no server-rendered views.

---

## The core architectural rule: mode scoping

Kinvo is not one social graph with a mode tag bolted on. It is **eight parallel graphs** sharing one user table, one media store, one billing account, and one moderation pipeline.

The eight modes: `dating`, `study_buddy`, `networking`, `trading`, `foodie`, `cuddle`, `pet_dates`, `fitness`.

- Swipes are unique on `(actor_id, target_id, mode)`. The same pair may like in one mode and pass in another.
- A match belongs to **exactly one** mode. Two users can hold several simultaneous matches in different modes.
- A conversation inherits its match's mode and never changes it.
- Discovery preferences are stored **per mode** (`UserMode`), not once per user.
- Decks are built per `(user, mode, day)`.
- Deck actions are always `pass` | `like` | `super_like`. Mode changes only the **label the app renders** — served from `GET /config`. Never create per-mode action enums.

**Trading is an interest category and nothing else.** No endpoint moves money or assets between users, records a trade, or serves market data. Its one asymmetry: scam/payment-language moderation checks must be globally scoped, not dating-scoped, because this mode attracts investment fraud.

---

## Stack

| Concern    | Choice                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Runtime    | **Node.js 24** (spec said 20 LTS; 20 reached end-of-life April 2026 — changed with the product owner's approval) |
| Language   | TypeScript, strict                                                                                               |
| Framework  | Express 4                                                                                                        |
| Database   | PostgreSQL 16 + PostGIS                                                                                          |
| ORM        | Prisma                                                                                                           |
| Validation | Zod                                                                                                              |
| Auth       | JWT access + refresh, `jsonwebtoken` + `argon2`                                                                  |
| Realtime   | Socket.IO                                                                                                        |
| Media      | AWS S3, presigned URLs                                                                                           |
| Push       | Firebase Cloud Messaging                                                                                         |
| SMS / OTP  | Twilio Verify                                                                                                    |
| Video      | LiveKit token issuance, behind a `VideoProvider` interface (was Twilio; see DECISIONS.md)                        |
| Payments   | **None in this codebase.** No processor, no checkout, no webhook — see the Subscriptions section below           |
| Jobs       | BullMQ + Redis                                                                                                   |
| Logging    | Pino                                                                                                             |
| Testing    | Jest + Supertest against a real Postgres                                                                         |

Do not substitute a library without asking.

---

## Commands

```bash
npm install
cp .env.example .env

npm run db:up          # docker compose up -d  (postgres + redis + seaweedfs)
npm run db:deploy      # apply committed migrations
npm run db:seed        # idempotent development data
npm run db:reset       # drop, re-migrate, re-seed
npm run dev            # tsx watch, hot reload
npm run build          # tsc -> dist, path aliases rewritten by tsc-alias
npm start              # run the build

npm test               # jest
npm run test:coverage  # with the 80% threshold enforced
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (flat config)
npm run format         # prettier --write
```

Docker exposes Postgres on **5433** and Redis on **6380** so they never collide with local installs.

---

## Layout

```
src/
  config/     env loading + validation, constants
  db/         prisma client, seeds                    (Batch 1)
  middleware/ auth, error handler, rate limit, validation
  modules/    one folder per domain module
    <module>/<module>.routes|controller|service|schema|types.ts
  realtime/   Socket.IO server, namespaces, handlers  (Batch 9)
  jobs/       BullMQ queues, workers, schedulers      (Batch 7+)
  providers/  external service adapters               (Batch 4+)
  types/      ambient type augmentation
  utils/      shared helpers
  routes.ts   versioned router assembly
  app.ts      express app assembly (exported without listening)
  server.ts   entry point: listen + graceful shutdown
```

Module folders: `auth`, `users`, `profiles`, `media`, `modes`, `settings`, `discovery`, `matches`, `chat`, `moderation`, `notifications`, `safety`, `plans`, `venues`, `subscriptions`, `calls`, `admin`, plus `entitlements` and `health`.

Path aliases: `@/*`, `@config/*`, `@middleware/*`, `@modules/*`, `@utils/*`. Declared in `tsconfig.json` and mirrored in `jest.config.js` — **change both together.**

---

## Non-negotiable conventions

**Layering.** Routes call controllers, controllers call services, services own business logic and touch the database. No business logic in a route handler. No database access from a controller.

**Validation.** Every endpoint validates with Zod via the `validate` middleware before business logic runs.

**Envelope (spec 4.2).** Every response goes through `src/utils/response.ts`. Never `res.json()` directly.

```jsonc
{ "success": true,  "data": {}, "meta": null }
{ "success": true,  "data": [], "meta": { "pagination": { "next_cursor": "…", "has_more": true, "limit": 20 } } }
{ "success": false, "error": { "code": "AUTH_TOKEN_EXPIRED", "message": "…", "details": null } }
```

`data` is always an object or array — wrap scalars as `{ "count": 4 }`. `message` is user-displayable. `code` is a stable machine contract; **renaming a shipped code is a breaking change.**

**Error codes.** Only from `src/utils/error-codes.ts`. Throw `ApiError`; never hand-roll an error response.

**Data formats (spec 4.6).**

- Timestamps: UTC ISO-8601 with `Z`, field names end in `_at`.
- Dates: `YYYY-MM-DD` (date of birth only — store DOB, never an age integer).
- IDs: UUID v4 strings. Never sequential integers.
- JSON fields: `snake_case`.
- Enums: lowercase snake_case strings, never integers.
- Money: integer minor units plus currency.
- **Distance: metres.** The client formats to miles.
- Null vs absent: return `null`, never omit the key. Empty lists are `[]`.

**Pagination.** Cursor-based (opaque base64) for decks, matches, messages, notifications. Messages paginate backwards. Offset pagination is acceptable on admin lists only.

**Auth.** Bearer tokens in the `Authorization` header, returned in the response body — not cookies. Access 30 min, refresh 60 days, rotated on every use. A replayed refresh token revokes the whole family. Keep `AUTH_REQUIRED`, `AUTH_TOKEN_EXPIRED`, and `AUTH_TOKEN_INVALID` distinct — the app does something different for each.

Mount `authenticate` on anything needing a user, then `requireOnboarded` on **every** discovery, matching, and chat route. That second gate is what keeps accounts created by social or phone sign-in — which have no date of birth yet — out of the product until onboarding runs the under-18 check. Omitting it is a legal problem, not a UX one.

`GET /config` `sign_in` tells the app which sign-in methods this server can complete, and the app shows only those. A new method, or a new way for one to be unavailable, belongs in `signInMethods()` so the button and the endpoint never disagree. Phone is the `PHONE_SIGN_IN_ENABLED` switch (DECISIONS.md, 25 Sep 2026).

`date_of_birth` is nullable because Google, Apple, and Twilio do not supply one. Call `assertAdult()` from `@utils/age` **wherever** a date of birth is set, never only at registration.

Never widen `req.user` from a token claim. `authenticate` loads the user on every request so suspension and deletion take effect immediately rather than whenever the 30-minute token happens to expire.

**Secrets in tests.** Rate limits are off by default under test and switched on by the suite that asserts them. External HTTP — Twilio, Google, Apple — is mocked at the provider boundary in `src/providers/`; nothing below that line is faked.

**Quota vs rate limit.** Infrastructure protection → `429 RATE_LIMITED`. Business limits that sell subscriptions → `422 QUOTA_EXCEEDED` with paywall context. Conflating them hides the paywall and costs revenue.

**Entitlements (spec §5.11).** The tier→flag matrix is **data**. Nothing branches on a tier name — not in this module, not anywhere downstream. Moving a feature between tiers is a seed edit and a re-seed.

- Flag keys live in `entitlements.types.ts` and are imported by both the seed and the resolver, so a typo is a compile error rather than a flag that is silently always off.
- `resolve(userId)` returns every flag in one call. Callers needing several flags resolve once — the same N+1 rule as compact objects.
- A missing or wrongly typed row **fails closed**. A broken seed must never hand out a paid feature.
- The **matrix** is cached 60s in process. The **user's tier is never cached** — it changes the moment a payment clears, and a stale tier tells a paying customer to upgrade.
- `requireEntitlement(flag)` middleware gates **boolean** features only. Numeric caps are consumed inside the service transaction that performs the action, so `refundQuota` can give the allowance back when that action fails. Never charge a user for a swipe the database rejected.
- Quota counters are keyed `quota:{name}:{user}:{utc-day}` and expire at the next **UTC** midnight. Check-and-consume is one Lua script; GET-then-INCR lets concurrent requests burst past the cap.
- Quotas **fail open** when Redis is down. They bind only the free tier, so failing closed would trade a total outage for revenue nobody is paying.

**Redis in tests.** The client uses `lazyConnect` with the offline queue **disabled** under test, so a command issued before an explicit `connectRedis()` fails instead of buffering. Any suite touching quota counters must call it in `beforeAll` and `disconnectRedis()` in `afterAll`. Skipping it does not fail loudly — `readCount` swallows connection errors and reports zero used, which looks exactly like a fresh counter, so the suite passes while proving nothing. Never wrap a live Redis call in `jest.useFakeTimers()`: ioredis drives its command queue on real timers and the call never resolves.

**Calls (spec §5.7, §7).** A token is scoped to ONE room and is short-lived.

The spec is explicit: _"never issue a token that grants access to arbitrary rooms."_
A leak here is not a data leak — it is a stranger appearing on someone's camera.

- The room name is **derived from the call id** and stored on the row. `issueToken` takes that stored name, not an id it re-derives, so the room a client is told to join and the room its token admits it to are the same string by construction. A `roomJoin` grant with no room grants every room on the project, so `room` is never optional.
- Starting a call names a **match**. Never a user, never a room — a client-supplied room name is the hole the spec is warning about, and the schema is `.strict()` so sending one is a 400.
- The permission check is `isPairReachable`, **the same function messaging uses**. It lives in `matches.service.ts` precisely so calling cannot drift into being the laxer of the two. Do not copy it.
- It is re-checked on **every token issue**, not just at the start. Blocking someone who is on your screen has to stop their next reconnect rather than take effect after they hang up.
- Token TTL is one hour, not ten minutes: LiveKit refuses the connection once a token expires. `GET /calls/{id}/token` re-issues, and that endpoint is what makes a short TTL workable instead of merely strict.
- Every refusal answers the **same 404** — blocked, unmatched, expired, account gone. Telling them apart confirms a block by elimination.
- Ringing timeout is decided at **read time**, like match expiry. A row still marked `ringing` reads as `missed`, so a late sweep never leaves a call ringing in history.
- Duration is measured from `answered_at`, not `started_at`. A call that rang for forty seconds and was picked up for ten lasted ten. Unanswered calls carry `null`, not `0` — zero reads as a call that connected silently.
- Hang-up is **idempotent**. Both apps send it, and the second must not surface an error.
- Safety actions are recorded **before** anything else happens, because the record is the point: a pattern of flags is what moderation acts on. `end_and_report` ends the call first — someone reaching for it wants the call to stop. `note` stays optional; a person reaching for a safety control mid-call cannot write an explanation.
  **Admin surface.** The admin PANEL is a separate codebase. What lives here are
  the endpoints it calls, and they are role-gated with `requireRole`, answering
  **403** rather than the block-style 404 — a moderator surface is not something
  to hide from the person holding the role.

- They follow the existing convention (`/reports/review`, `/moderation/flags`, `/verification/review`) rather than a separate `/admin/*` namespace. Three conventions would be worse than two. They carry the `Admin` tag in the generated contract so the panel finds them in one place.
- **The decision lives on this side, never in the panel.** A panel writing `status = approved` straight into a table skips the second-review check, the badge recomputation, the audit entry and the notification. Every state change a moderator makes goes through a service that does all four.
- **A second review answers 409**, not an overwrite. Two reviewers opening the same queue is normal, not an edge case.
- **Every admin decision writes an `AdminAuditLog` row** — actor, action, target, metadata, IP. Written after the decision, not inside its transaction: a failed log must not roll back a review that already happened, and a review with no log is recoverable while a lost decision is not.
- Review queues are ordered **oldest first**, unlike every other list. A queue is work to get through; newest-first strands whoever has waited longest.

**Provider webhooks.** `/webhooks/video` is the only one, and its SIGNATURE is
its authentication — there is no bearer token. LiveKit sends an `Authorization`
header holding a JWT that carries a sha256 of the body, so this one path is
given `express.raw` in `app.ts`: a body that has been parsed and re-serialised
no longer hashes to the claimed value, and every real callback would be refused.
The controller fails loudly if it is handed anything but a Buffer, because the
alternative is an outage that reads as a signature problem. Verification and
parsing are ONE step, inside the provider — the bytes that are checked must be
the bytes that are acted on.

- Without credentials the provider stub **refuses every callback**, and that is right: this endpoint ends calls, so accepting unverified ones would let anyone hang up anyone by guessing a room name.
- It exists to close the gap where a call is answered and both clients then vanish — nothing else ever sends the hang-up, and the row would read `active` for ever. `sweepStuckCalls` is the backstop when the callback never arrives.
- It cannot touch entitlement, and a test in the subscriptions suite asserts so.

**Subscriptions (spec §5.10).** Never grant entitlement from a client claim.

Payment processing is **not in this codebase**. There is no processor, no checkout,
no billing portal, no webhook and no receipt validation. Purchasing happens in the
mobile app; subscription rows arrive from outside.

That is what makes §5.10 enforceable here rather than merely intended:

- **No HTTP route can grant access.** `/subscriptions` exposes two READS — `/products` and `/me`. A test asserts that `/checkout`, `/portal`, `/restore` and the whole `/webhooks` namespace return **404**. If any of them ever answers something else, a path to granting entitlement has reappeared, and that is the bug.
- **One bounded exception: test purchases** (DECISIONS.md, 24 Sep 2026). `POST` and `DELETE /subscriptions/test-purchase` grant or end a `source = test` plan for the caller — staging's stand-in until RevenueCat. Fenced three ways: the routes answer only while `testPurchasesEnabled()`, and otherwise give the same 404 as a path that does not exist; a production boot with `TEST_PURCHASES_ENABLED` on is refused; and `resolveTier` honours test rows only while the switch is on, so a copied staging database unlocks nothing. It lives in `test-purchases.service.ts` and is **deleted, not adapted**, when RevenueCat arrives.
- **Entitlement resolves from Subscription rows**, never `user.subscription_tier`. That column is a denormalised copy for admin lists; a column somebody can edit is not an entitlement, and a test asserts that writing it grants nothing.
- `resolveTier` takes the **highest** entitling tier, because a mid-period upgrade leaves two rows briefly and the answer must be the better one rather than whichever row came back first.
- `cancelled`, `in_grace_period` and `on_billing_retry` **keep** access — the period is paid for, and a card that needs reissuing must not cost the customer both the money and the feature. A row with `refunded_at` or `revoked_at` set loses access **immediately**.
- Access ends on `current_period_end`, checked at **read time**. The nightly sweep only updates the status column for admin lists, so a late or failed sweep can never hand out free premium.
- Product prices are the **catalogue the paywall renders**, and are informational. Whoever takes the payment decides what is actually charged. A price change is a new `PriceVersion` row, never an edit, so the old amount survives for grandfathering and for reconciling what people were really charged.

If payment handling ever comes back into this codebase, the rule it must satisfy is
unchanged: access changes in exactly one place, reachable only from something whose
authenticity was verified server-side. Not from a request body, and not from what a
client SDK reports about itself.
**Money.** Integer minor units plus a currency code. Never a float, never a formatted string.
**Blocks (spec 5.5).** Blocks beat everything. The shared exclusion clause lives in `src/modules/safety/block.service.ts` and **must never be re-implemented**:

- `visibleUserFilter(viewerId, blockedIds)` — compose into the `where` of any query that can surface another user. It already excludes blocked-either-direction, self, suspended, soft-deleted, and snoozed.
- `assertVisible(viewerId, targetId)` — call before returning anything about a specific user. Throws `404`.

Return `404`, not `403`, when a block is the reason; a 403 confirms the resource exists. "Blocked", "suspended", "deleted", and "never existed" must be byte-identical from outside.

**Compact objects (spec 4.7).** `user_compact` is built only by `toUserCompact()` in `src/utils/compact.ts`. It becomes one Dart model, so every list that returns a user returns exactly that shape.

**Discovery (spec §5.3).** The deck is where six rules must hold at once — blocks, mode, radius, age, already-swiped, account state. Any one failing surfaces someone who should never have been shown.

- Decks are persisted per `(user, mode, day)`. Re-running a ranking algorithm per scroll lets a card move between pages and be seen twice or never.
- `getDeck` generates lazily when today’s deck is missing. The BullMQ precompute is an **optimisation, never a dependency** — a worker that is down must cost latency, not an empty product.
- **Ranking is not filtering.** Verification and boost move someone up a deck they already qualified for. Neither may place someone into a deck a filter excluded them from — that is how a paid boost would beat a block.
- The radius query cannot compose `visibleUserFilter`, so it takes an exclusion array and the shared clause runs on its result in Prisma. `CANDIDATE_POOL` stays far above `DECK_SIZE` so the split cannot truncate a correct answer.
- Already-swiped is scoped **per mode**. A pass in `dating` must not remove someone from the `study_buddy` deck.
- A pass costs no quota; only likes and super likes do. One constant in `swipe.service.ts`.
- **Incognito** shows someone only to people they have liked in that mode, and to their matches (DECISIONS.md, 24 Sep 2026). `incognitoFilter` lives in `deckCandidateFilter`, so it holds on every build and read; `assertIncognitoAllows` guards the profile and a direct swipe with the same 404 as a missing user. Never re-implement either.
- **Pause new matches** refuses the paused person's likes (`NEW_MATCHES_PAUSED`, before quota), and `createMatchIfMutual` makes no match while either side is paused. `matchLikesHeldByPause` makes the held matches when the pause ends — never for a pair that has had a match, and never across a block.
- **Verified people only everywhere** (`global_verified_only`) is OR'd with each mode's `verified_only` at build time; changing it discards today's decks in every mode.
- **Rewind never undoes a swipe that became a match** (DECISIONS.md, 25 Sep 2026). It answers 409 `ALREADY_MATCHED`, with `details.match_id` while `isMatchListed` holds and null otherwise. Unmatch is how a match ends; nothing deletes a match row.
- **`lockPair` before reading a pair.** Anything that can make a match, or take away the like one rests on, takes `lockPair(tx, …)` first: `createMatchIfMutual`, rewind and `matchLikesHeldByPause` do. Without it, READ COMMITTED lets two likes that land together miss each other for good.

**Chat (spec §5.4).** A conversation belongs to exactly one match, inherits its mode, and has exactly two participants (decision #11). It is created inside the match transaction — there is no endpoint that makes one, because users cannot message before matching (decision #5).

- **Messages paginate backwards.** Newest first, cursor walking into history. Every other list in this API goes the other way.
- A conversation is closed when the pair is blocked, the match expired or was unmatched, or the other account left. **Every reason answers one identical 403** — distinguishing them lets a block be confirmed by elimination.
- `is_writable` is returned on matches and conversations so the app hides the composer rather than learning the state from a rejected send.
- **Match expiry is decided at read time** by `isExpired`, never by trusting the status column. The sweeper job only updates the column for admin lists; it being late must change nothing a user sees.
- Only the recipient’s `unread_count` moves on send. A new message un-archives the thread for them.
- Media messages go through `claimAsset` like everything else, so a verification document can never become a chat attachment.

**Cursors.** Opaque base64, built and read only by `src/utils/cursor.ts`. Anything that parses a cursor elsewhere has turned it into an API surface, and the ordering key can never change again without a client release. Fetch `limit + 1` rows and let `paginate()` derive `has_more` — a COUNT over a large filtered set costs more than the page.

**Realtime (spec §7).** Socket.IO is a **delivery layer, never a second write path**. Persist first, then emit — every emitter is called after its transaction commits, never inside one, or a rollback would announce a message that does not exist.

- **Register socket handlers before any `await` in the connection handler.** Socket.IO drops packets that have no listener yet, so every await is a window where a client emitting on connect loses the event silently.
- The disconnect handler **waits for the connect sequence** before undoing it. A socket that opens and closes in milliseconds otherwise leaves a phantom online entry.
- Presence counts **connections, not users** — a boolean marks someone offline when one of two devices closes. Redis, 90s TTL so network switches do not flicker.
- Presence is sent **only to active matches, never across a block**. Anything wider is an activity feed on someone who never agreed to share one.
- Online state is Redis; `last_active_at` is Postgres on a throttle. Never write presence to a durable store.
- `is_online` is resolved in bulk via `onlineStatusFor` and passed into `toUserCompact`, like the photo URL. Per-row presence is the same N+1 compact objects exist to prevent.
- Socket payloads are as untrusted as request bodies: validated by the same Zod schemas that generate `/docs/realtime.json`, so the docs cannot describe a payload the server rejects.
- The handshake reuses `verifyAccessToken`'s error mapping. Do not re-catch `TokenExpiredError` — it has already been converted, and a duplicate mapping turns every expiry into a sign-out.

**Jobs.** BullMQ needs its own Redis connection with `maxRetriesPerRequest: null`; its blocking commands would otherwise stall every rate-limit and quota command behind a worker poll. Nothing starts on import — tests load the Express app and must not open queues. A scheduler that fans out on the queue it feeds must branch on **job name**, or the repeatable job arrives with empty data and the worker processes it as real work.

**Onboarding.** The requirement list is a declared checklist in `src/modules/users/onboarding.service.ts`. Adding a requirement is one entry there — never a new condition scattered into the transition. Batch 4 adds "≥1 approved photo", Batch 5 adds "≥1 enabled mode".

**Moderation (spec §5.4).** Rules-based v1 behind `ModerationProvider` (decision #8). Two rules govern the whole module:

- **Advisory, never blocking.** `can_send` is a constant `true`. If it ever becomes conditional, the product has started blocking messages on a regex.
- **Fail open.** A provider timeout returns severity `none` with `timed_out: true` and queues the content. This applies to the send path too, not just the check endpoint — never cost a user their message because a third party was down.

Also:

- Checked content is **hashed, never stored**. A copy of every message someone considered sending is a surveillance database.
- Scam and payment rules **take no mode argument**, so they cannot be dating-scoped by accident (spec §1 — Trading attracts investment fraud).
- A provider that cannot assess a subject type **queues it for a human** rather than marking it clean. A healthy-looking queue that checks nothing is worse than no queue.
- Flags are idempotent per subject and severity **ratchets upward only** — a later benign scan must not quiet an earlier serious finding.
- False-positive tests matter as much as true-positive ones. A warning users dismiss reflexively protects nobody.

**Reporter anonymity (spec 5.7).** A reported user must never learn who reported them through any endpoint, notification, or error message.

**Notifications (spec §7).** **Every notification is persisted to the feed AND pushed — never pushed alone.** The Notifications screen reads the feed, so a push-only notification vanishes when the banner is dismissed. Persisting first is what makes push, email, and socket delivery all best-effort.

- A **missing preference row means the default**, not "off". Absent-as-off would silently disable notifications for every existing account.
- **Safety notifications cannot be muted** for push or in-app (§5.7). Email can be.
- The "someone liked you" notification **never names who** — that is behind a paywall, and a banner would give it away.
- `total` in badge counts **excludes `discover`**: cards waiting is not a thing the user is behind on, and a permanently non-zero badge trains people to ignore it.
- FCM tokens belong to a **device**, not a user. Re-registering a token moves it off its previous device, because FCM issues one per install.
- Clear a token only on FCM's **permanent-failure** codes. A network blip is not a dead device.
- Scheduled work is a **sweep**, not a timer per row — sweeps survive restarts and edits, and the feed doubles as the idempotency key.

**Logging.** Pino only — `no-console` is an ESLint error. No PII in logs; redaction lives in `src/utils/logger.ts`. Log `req.path`, never `req.originalUrl`.

**Database.** Import the client from `@/db/prisma` — never from `src/generated/prisma`, which is Prisma 7's git-ignored output directory. Prisma 7 connects through `@prisma/adapter-pg`, not a URL on the client.

**PostGIS.** Prisma cannot read or write a `geography` column; those fields are `Unsupported()` in the schema. Every spatial query lives in `src/db/geo.ts` and nowhere else. Coordinate order is `(longitude, latitude)` — `ST_MakePoint` takes X then Y. Distances are always metres.

**Migrations.** GIST indexes, CHECK constraints, and partial unique indexes cannot be expressed in `schema.prisma` and are hand-written at the bottom of the migration SQL. **If you regenerate a migration, re-apply them.**

**Media.** Uploads are a two-step handshake: the API issues a presigned PUT, the client uploads straight to storage, then the API HEADs the object to record what actually landed. An asset with no `uploaded_at` is an intent, not an asset, and may never be attached to anything — the client saying "done" is a claim, not evidence.

Both buckets are private, so every media URL is presigned and time-limited, minted on read. `S3_MEDIA_BUCKET` holds photos, chat media, and voice notes; `S3_VERIFICATION_BUCKET` holds government ID images and report evidence, with a much shorter URL lifetime. **Never merge them.** Locally both live in SeaweedFS (docker-compose), which speaks the S3 API — the SDK and the presigning are real, only the endpoint differs from AWS.

`claimAsset()` is how anything attaches media. It checks ownership, completion, and kind together, so a verification document can never be promoted into the public photo table.

**Secrets.** Environment only, validated at boot. Never in code.

**Comments.** Explain _why_, not _what_. Business rules from the spec cite their section number.

---

## How work is sequenced

15 batches, defined in `KINVO_BACKEND_BUILD.md` §7. Rules:

1. One batch at a time, in order.
2. State the goal and the file list, then wait for confirmation before writing code.
3. Finish the batch — code, tests, docs.
4. Full test suite green.
5. Print the §0.6 completion report.
6. **Stop.** Do not start the next batch unbidden.

When blocked, ask. Do not invent a business rule and bury it in code.

**One test process per database.** `maxWorkers: 1` and `--runInBand` serialise
suites WITHIN a run; nothing serialises two runs. Starting a focused suite while
a full run is going gives both of them failures that look nothing like the cause
— `40P01 deadlock detected` in the entitlement seed, and `TRUNCATE` landing
mid-test in whichever run got there second. Wait for a run to finish, or point
the second one at its own database. In CI: one database per job.

**Tests are not optional.** Integration tests per endpoint covering happy path, validation failure, auth failure, and the permission boundary (can user A touch user B's resource?). Unit tests for pure logic. Real Postgres, mocks only for external HTTP. 80% line coverage on `src/` excluding config. Tests seed and clean their own data and run in any order.

---

## Decisions already made — do not re-ask

| #   | Decision                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Database:** PostgreSQL + PostGIS. S3 for media bytes only — never application records.                                                                                                                                                                                                                                            |
| 4   | **Trading mode:** interest category only, no trading functionality.                                                                                                                                                                                                                                                                 |
| 13  | **Payments are not this codebase's job.** No processor, no checkout, no webhook, no receipt validation. RevenueCat is handled in the mobile app. This backend READS subscription rows to resolve entitlement and serve the paywall catalogue, and has no way to create one.                                                         |
| 2,3 | **Four SKUs:** Basic and Premium × monthly and yearly. Annual is a third off. No quarterly (sells to nobody), no weekly (a churn machine), no free trial in v1. Tier matrix unchanged from the Batch 6 provisional. Prices here are the paywall CATALOGUE and are informational — the backend cannot change what anyone is charged. |
| 5   | **"Requests" tab:** a **likes-you inbox** — profiles, not messages. Users cannot message before matching, so a conversation always has a match behind it.                                                                                                                                                                           |
| 11  | **Study Buddy groups:** one-to-one only in v1. Every conversation has exactly two participants.                                                                                                                                                                                                                                     |
| —   | **Runtime:** Node 24 instead of the spec's EOL Node 20.                                                                                                                                                                                                                                                                             |

## Still open — ask before the batch that needs them

Nothing currently blocks a batch.

| #   | Question                              | Blocks | Status                                                                                     |
| --- | ------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| 12  | Admin analytics — which metrics?      | —      | **Moot here.** Admin moves to its own repository (DECISIONS.md §1.2o), so this follows it. |
| —   | Cloudflare R2 instead of S3 for media | —      | Not blocking. Same SDK, different endpoint; the argument is egress cost at real traffic.   |

**Shipped on engineering placeholders, not PO decisions** (DECISIONS.md §1.2e).
The PO can still overrule any of these; the table records what each costs to change.

| #   | Placeholder                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Free tier: 50 swipes/day per mode, 30 messages/day. Seed edit.                                                                      |
| 10  | Rewind is premium (basic and above). Seed edit.                                                                                     |
| 6   | Match expiry 14 days; the conversation goes read-only and stays visible. TTL is a constant; the conversation behaviour is **code**. |
| 8   | Moderation is rules-based v1 behind a provider interface. Provider swap.                                                            |
| —   | A blocked pair's conversation is frozen and visible; every other path 404s. **Code.**                                               |
| —   | Profile photo URLs are presigned S3 GETs, not CDN signed URLs — so Flutter's image cache misses on every render.                    |

---

## Trap checklist — run at the end of every batch

1. Does every new query filter by **mode** where it should?
2. Does every new endpoint use the shared **block** exclusion clause?
3. Timestamps UTC, ISO-8601, `Z`, `_at` suffix?
4. Distances in **metres**?
5. Enums as strings, not integers?
6. Do list endpoints return compact objects, or force **N+1** follow-up calls?
7. Quota returns **422 with paywall context**, not 429?
8. **404 instead of 403** where a block is the reason?
9. Can a reported user learn who reported them through any path?
10. Envelope on **everything** — errors and empty lists included?
