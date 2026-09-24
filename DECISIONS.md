# DECISIONS.md — Kinvo Backend

A living record of **what was decided, what was done, and what each batch depends on.**

Three rules for this file:

1. Every decision that the spec did not dictate gets logged here, with its reasoning and who made it.
2. Every action taken against the repository or the environment gets logged here.
3. Nothing here overrides `KINVO_BACKEND_BUILD.md`. That document is the specification; this one is the audit trail.

Roles below: **PO** = product owner **Eng** = the implementing agent.

---

## 1. Decision log

### 1.1 Resolved by the specification — do not re-ask

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                   | Source                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 1   | **Database: PostgreSQL 16 + PostGIS.** S3 stores media bytes only, never application records.                                                                                                                                                                                                                                                                                              | Spec §6, confirmed Eng |
| 4   | **Trading mode is an interest category only.** No trading, transfers, brokerage, or market data.                                                                                                                                                                                                                                                                                           | Spec §1, §6            |
| 13  | ~~**Payment rails:** Apple StoreKit 2 + Google Play Billing primary; Stripe as US-only web link-out.~~ **SUPERSEDED — see §1.2o.** Payments left this codebase entirely on 2026-09-10; RevenueCat is handled in the mobile app. Kept struck through rather than deleted, because this table records what the SPECIFICATION said and a reader comparing the two should see that it changed. | Spec §2, §6            |

### 1.2 Resolved during this engagement

| #   | Decision                                                                                                                                             | Date       | By  | Reasoning                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | **Runtime is Node.js 24**, not the spec's Node 20 LTS.                                                                                               | 2026-08-13 | PO  | Node 20 reached end-of-life in April 2026 — four months before this build started. Shipping on an EOL runtime means no security patches from day one. Eng raised it; PO approved 24 (the version already installed locally).        |
| 5   | **The "Requests" tab is a likes-you inbox.** It lists _profiles_ of people who liked you and are awaiting your response — not messages.              | 2026-08-13 | PO  | Eng recommended it. Option B (message requests from unmatched users) would let a conversation exist with no match behind it, breaking spec §5.4's "conversation belongs to a match". Also a safety liability in Cuddle and Trading. |
| —   | **Users cannot message before matching.** Direct consequence of #5.                                                                                  | 2026-08-13 | PO  | Every conversation has exactly one match behind it. `Conversation.match_id` is non-nullable.                                                                                                                                        |
| 11  | **Study Buddy is one-to-one only in v1.** No multi-party group chats in any mode.                                                                    | 2026-08-13 | PO  | Eng recommended it. Groups would break read receipts, unread counts, typing indicators, block enforcement, and match expiry all at once, and the demand would immediately spread to Fitness and Foodie.                             |
| —   | **Every conversation has exactly two participants.** Direct consequence of #11.                                                                      | 2026-08-13 | PO  | Lets the schema use two user columns rather than a participants join table.                                                                                                                                                         |
| —   | **Deploy to AWS**, on the client's existing AWS account, rather than Render.                                                                         | 2026-08-13 | PO  | Eng initially recommended Render for lower operational overhead. PO has the client's AWS account, and the client expects it there. Nothing in the codebase is host-specific, so this is a deployment concern only.                  |
| —   | **AWS shape: EC2 (API in Docker) + RDS Postgres/PostGIS + ElastiCache Redis + S3.** Caddy terminates TLS. Terraform describes the infrastructure.    | 2026-08-13 | Eng | The production database must be managed (RDS), not self-run in a container — Batch 4 stores government ID images, and owning backup and recovery for that is not acceptable. Awaiting PO confirmation at the deployment interlude.  |
| —   | **Never use AWS root credentials.** An IAM user with scoped permissions, MFA on root, and a billing alert are prerequisites for any deployment work. | 2026-08-13 | PO  | The client supplied root credentials. Root cannot be permission-limited and can close the account. PO is creating the IAM user.                                                                                                     |
| —   | **Deploy staging after Batch 3**, not at Batch 15.                                                                                                   | 2026-08-13 | Eng | After Batch 3 the mobile team has auth, profiles, and onboarding — enough to build against. Deploying later blocks them for months, then surfaces every integration problem at once.                                                |

### 1.2b Resolved during Batch 2 (auth)

| Decision                                                                                                                             | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`users.date_of_birth` is nullable.** The under-18 rejection fires whenever a date of birth is set, not only at email registration. | 2026-08-14 | PO  | Google, Apple, and Twilio supply no date of birth, so a social or phone signup cannot know a user's age at account creation. A user without one stays `pending` and is blocked from discovery, matching, and chat, so nobody under 18 reaches the product — which is what spec §5.1 actually protects.           |
| **A new phone number creates a pending account** rather than being refused.                                                          | 2026-08-14 | PO  | Same reasoning. Consistent with social signup, and `requireOnboarded` is the single gate for both.                                                                                                                                                                                                               |
| **Libraries added:** `argon2`, `jsonwebtoken`, `twilio`, `google-auth-library`, `express-rate-limit`, `rate-limit-redis`, `ioredis`. | 2026-08-14 | PO  | PO delegated the choice. The first three are named in spec §2; the rest cover Google ID-token verification and the rate limiting §4.9 requires.                                                                                                                                                                  |
| **Apple ID tokens are verified with no JWKS library** — Node's `createPublicKey` plus `jsonwebtoken`.                                | 2026-08-14 | Eng | `jose` was planned and approved, but it is ESM-only and the CommonJS test runner cannot load it; `jwks-rsa` depends on it and fails the same way. Apple's JWKS is a small JSON document and Node imports a JWK natively, so this removed a dependency instead of adding one. **Deviates from what PO approved.** |
| **Rate limits are disabled under test** via a test-only switch, and enabled by the suite that asserts them.                          | 2026-08-14 | Eng | A suite makes far more requests from one address than any real client, so limits would fail unrelated tests. The switch throws if called outside tests.                                                                                                                                                          |
| **`X-RateLimit-*` legacy headers stay on.** The draft-7 `RateLimit` header is emitted alongside.                                     | 2026-08-14 | Eng | Spec §4.9 names `X-RateLimit-*` explicitly, so those are the client contract the Flutter app reads.                                                                                                                                                                                                              |
| **Dev seed users share the password `kinvo-dev-password`.**                                                                          | 2026-08-14 | Eng | The mobile team needs sign-in-able accounts on staging. Safe because the seed only ever runs against development and staging databases.                                                                                                                                                                          |

### 1.2c Resolved during Batches 4 and 5

| Decision                                                                                                                    | Date       | By  | Reasoning                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Free tier gets 3 simultaneous modes.** Basic 5, Advanced unlimited.                                                       | 2026-08-26 | PO  | Eng proposed 2; PO chose 3. One mode makes Kinvo look like every other dating app until you pay, so the multi-mode idea has to be visible to someone who has not subscribed. Seeded value, changeable without code.                                                                  |
| **Enabling Cuddle requires an approved verification.**                                                                      | 2026-08-26 | PO  | Spec §5.7 flags Cuddle as elevated risk: physical-contact meetups, and it will attract misuse. Far easier to require from day one than to impose later on existing users. `can_enable` is returned up front so the app greys the toggle rather than letting the user tap into a 403. |
| **Onboarding requires: display name, date of birth (18+), bio, location, ≥1 interest, ≥1 approved photo, ≥1 enabled mode.** | 2026-08-26 | Eng | A declared checklist in `onboarding.service.ts`, not scattered conditionals. Batch 4 added the photo, Batch 5 the mode. Adding a requirement is one entry there.                                                                                                                     |
| **Account deletion is a soft delete; PII is NOT scrubbed.**                                                                 | 2026-08-21 | PO  | Deferred to Batch 12, where reports and evidence retention are on the table and it can be decided what must survive an erasure request. **This is a GDPR exposure until then** — recorded so it is a known debt, not a surprise.                                                     |
| **Media auto-approval is an explicit env switch, forbidden in production.**                                                 | 2026-08-20 | Eng | Nothing moves a photo from pending to approved until Batch 10, so without it every uploaded photo is invisible to everyone. Same shape as the Twilio dev stub: useful locally, impossible to ship. **Batch 10 must delete `MEDIA_AUTO_APPROVE_UPLOADS` entirely.**                   |
| **Staging waives third-party integrations** via `REQUIRE_THIRD_PARTY_INTEGRATIONS=false`.                                   | 2026-08-25 | Eng | No Twilio, Google, or Apple accounts exist yet. Production still refuses to boot without them. The waiver deliberately does not relax the CORS or media-moderation rules, and a test asserts it cannot. **Must become true before real users sign in.**                              |
| **API documentation is served at `/docs`**, brought forward from Batch 15.                                                  | 2026-08-26 | PO  | The mobile team needed the contract. Request bodies generate from the Zod schemas the endpoints validate with, and a test fails the build if a route is undocumented.                                                                                                                |

### 1.2d Resolved during Batch 6 (entitlements)

| Decision                                                                        | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The entitlement matrix stays data; no code branches on a tier name.**         | 2026-08-26 | Eng | Spec §5.11 requires it, and it is what lets #2, #3, #7 and #10 be answered after launch. A test proves it: flipping Rewind on for free is a seeded row edit, and the endpoint reports the change with no deploy.                                                                             |
| **A missing or wrongly typed flag fails CLOSED** (boolean → false, number → 0). | 2026-08-26 | Eng | A broken seed must never hand out a premium feature or an unlimited quota. Closed is loud — someone reports the feature missing within the hour. Open is silent and leaks revenue indefinitely. The seed additionally refuses to run if a declared key has no row.                           |
| **The matrix is cached in process for 60s; the user’s TIER IS NEVER CACHED.**   | 2026-08-26 | Eng | The matrix is global and changes quarterly. A tier changes the instant a payment clears, and a stale tier tells someone who just paid to upgrade — the worst bug this module could have. Same reasoning as `authenticate` reloading the user rather than trusting a token claim.             |
| **Quota counters fail OPEN when Redis is unreachable.**                         | 2026-08-26 | Eng | Quotas bind only the free tier; paid tiers are unlimited and never reach the counter. Failing closed turns a cache outage into "nobody can swipe or send a message" — a total outage to protect revenue from users who are not paying. Logged at error level so the outage is still visible. |
| **Check-and-consume is a single Lua script, not GET-then-INCR.**                | 2026-08-26 | Eng | Two concurrent requests both read "49 of 50" and both proceed otherwise. The limit that is supposed to sell a subscription would be quietly exceedable by anyone tapping fast. A test fires 20 concurrent consumes at a cap of 5 and asserts exactly 5 succeed.                              |
| **Numeric caps are consumed in the service, not in middleware.**                | 2026-08-26 | Eng | A daily cap must be spent inside the transaction that performs the action so it can be refunded when that action fails — otherwise a user is charged a swipe the database rejected. Middleware cannot see that far. `requireEntitlement` therefore gates boolean features only.              |
| **The mode cap now reads the resolver** rather than querying the matrix itself. | 2026-08-26 | Eng | Batch 5 read `tier_entitlements` directly because the resolver did not exist. Two places interpreting the same rows drift; the Batch 5 copy is gone.                                                                                                                                         |
| **Tests seed the REAL matrix**, via production’s own seed function.             | 2026-08-26 | Eng | Batch 5’s mode tests hand-built a one-row stub, which proves the resolver works against fixtures nobody ships. Calling the real seed means a broken matrix fails the suite instead of surfacing in staging.                                                                                  |

### 1.2e Provisional answers taken under autonomous execution

On 2026-08-26 the PO authorised running Batches 6→10 without stopping between
them, accepting that the open decisions below would be answered with documented
defaults. **These are engineering placeholders, not PO decisions.** Each is
listed with what it costs to change later.

| #   | Question                             | Placeholder                                                  | Cost to change                                                     |
| --- | ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| 7   | Free daily swipe cap                 | **50/day**                                                   | Seed edit + re-seed. Free.                                         |
| 7   | Free daily message cap               | **30/day**                                                   | Seed edit + re-seed. Free.                                         |
| 10  | Rewind free or premium               | **Premium (basic and above)**                                | Seed edit + re-seed. Free.                                         |
| 6   | Match expiry TTL                     | **14 days**                                                  | Config constant. Cheap.                                            |
| 6   | What expiry does to the conversation | **Read-only, stays visible**                                 | **Code.** Affects the chat query and the match list.               |
| —   | Block visibility                     | **Conversation frozen and visible; 404 on every other path** | **Code.** Affects the shared exclusion clause and the chat module. |
| 8   | Moderation provider                  | **Rules-based v1, behind a provider interface**              | Provider swap. Cheap by design.                                    |

### 1.2f Resolved during Batch 7 (discovery and matching)

| Decision                                                                      | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A pass costs no quota; only likes and super likes do.**                     | 2026-08-26 | Eng | The spec says "daily swipe cap" and the flag is `daily_swipe_limit`. Read literally that would cap passes too, which strands a free user on a profile they do not want and extracts no value — nobody has ever paid to skip someone faster. Read as a cap on the actions that can lead to a match, it does the job it exists for. **This is an interpretation, not a PO decision** — one constant in `swipe.service.ts` reverses it. |
| **Rewind deletes the match its swipe created.**                               | 2026-08-26 | Eng | Keeping it leaves a conversation neither person can trace, and the unique index on `(user_a, user_b, mode)` would stop the pair ever matching again in that mode. Rewind means restoring the pre-swipe state or it means nothing.                                                                                                                                                                                                    |
| **Decks are generated lazily on read; BullMQ precompute is an optimisation.** | 2026-08-26 | Eng | Built the other way round, a worker that is down, behind, or not yet deployed shows users an empty product. This way a queue outage costs latency on first open and nothing else.                                                                                                                                                                                                                                                    |
| **Boost and verification are RANKING inputs only.**                           | 2026-08-26 | Eng | Neither can place someone into a deck a filter excluded them from. Conflating ranking with filtering is precisely how a paid boost would start beating a block. A test asserts a boosted, blocked user still does not appear.                                                                                                                                                                                                        |
| **The deck pre-excludes cheaply, then applies the shared clause in Prisma.**  | 2026-08-26 | Eng | PostGIS cannot compose `visibleUserFilter`, so the radius query takes an exclusion array (self, blocks, already-swiped) and the real clause runs on the result. `CANDIDATE_POOL` is 500 against a deck of 50, so the two-phase split cannot truncate a correct answer.                                                                                                                                                               |
| **Cursors are opaque base64, never parsed outside `@utils/cursor`.**          | 2026-08-26 | Eng | The moment anything reads a cursor payload it becomes an API surface, and the ordering key can never change again without a client release.                                                                                                                                                                                                                                                                                          |

### 1.2g Resolved during Batch 8 (matches and chat)

| Decision                                                               | Date       | By                          | Reasoning                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Block visibility: the conversation stays VISIBLE and FROZEN.**       | 2026-08-26 | Eng (placeholder, see 1.2e) | Spec §5.5 says read-only, §4.4 says do not confirm a block; these pull in opposite directions. Hiding the thread makes history vanish mid-scroll and reads as data loss. Leaving it writable defeats the block. Visible-and-frozen satisfies both, and the send error is identical for every closed reason. |
| **Every closed-conversation reason answers the SAME 403.**             | 2026-08-26 | Eng                         | Blocked, expired, unmatched, and other-account-deleted return byte-identical errors. Distinguishing them would let someone confirm a block by elimination — the same leak a 403 on a blocked profile causes. A test asserts the blocker and the blocked side get identical status, code, and message.       |
| **`is_writable` is returned on matches and conversations.**            | 2026-08-26 | Eng                         | The app hides the composer on a flag rather than discovering the state by having a send rejected. Without it the only way to learn a thread is frozen is to type a message and lose it.                                                                                                                     |
| **Match expiry is computed at READ time; the sweeper is bookkeeping.** | 2026-08-26 | Eng                         | A row whose `expires_at` has passed is expired the moment it passes. Trusting the status column would leave matches writable for however long the job is behind, so a queue outage would silently extend everyone. The job only updates the column for admin lists and analytics.                           |
| **Extend adds to the CURRENT expiry, not to now.**                     | 2026-08-26 | Eng                         | Extending a match with three days left must give the full window on top, not reset it to a shorter one. An already-expired match extends from now, so it becomes usable again rather than staying expired.                                                                                                  |
| **The conversation is created inside the match transaction.**          | 2026-08-26 | Eng                         | A match can never exist without somewhere to talk, and the chat module never has to handle a missing conversation. Both `conversation_state` rows are created at the same time so the unread badge has somewhere to live from the first message.                                                            |
| **Unmatch is a status change, not a delete.**                          | 2026-08-26 | Eng                         | `unmatched_by_id` is what a later report investigation needs, and it is never exposed to the other person. The swipes stay so the pair is not offered to each other again in that mode.                                                                                                                     |
| **A new message un-archives the thread for the recipient.**            | 2026-08-26 | Eng                         | Otherwise an archived conversation is silently unreachable while its unread badge counts up.                                                                                                                                                                                                                |

### 1.2h Resolved during Batch 9 (realtime)

| Decision                                                                         | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Realtime is a DELIVERY layer, never a second write path.**                     | 2026-08-26 | Eng | Spec §7: persist first, then emit. Every socket event describes something already committed, and every emitter is called after its transaction. A dropped socket costs a refresh, never a message, and the whole feature can be switched off without the product losing correctness.          |
| **Typing indicators are addressed to the other participant, not a shared room.** | 2026-08-26 | Eng | A conversation room has to be joined first, which makes delivery depend on a join the sender cannot observe — the recipient silently misses indicators. Every conversation has exactly two people (#11), so addressing the other one directly is simpler and cannot race.                     |
| **Presence counts CONNECTIONS, not users.**                                      | 2026-08-26 | Eng | A boolean marks someone offline the moment one of two devices closes. A Redis set of socket ids, with a 90s TTL so a commuter switching networks does not flicker offline and fan an event out to every match.                                                                                |
| **Presence is only ever sent to active matches, never across a block.**          | 2026-08-26 | Eng | Broadcasting it widely tells strangers when someone is at their phone; telling a blocked person hands them a live activity feed of the person who blocked them. Two tests assert both negatives.                                                                                              |
| **Online state in Redis, `last_active_at` in Postgres.**                         | 2026-08-26 | Eng | Online state changes on every connect and is worthless after a restart. `last_active_at` is shown on profiles long after the socket is gone, so it is durable — written on a 5-minute throttle rather than on every heartbeat.                                                                |
| **`is_online` is resolved in BULK by the caller.**                               | 2026-08-26 | Eng | `toUserCompact` takes it as a parameter for the same reason it takes the photo URL: reading presence per row is the N+1 that compact objects exist to prevent. It defaults to false, so a list that has not resolved presence understates activity rather than claiming someone is available. |
| **The socket contract is its own document at `/docs/realtime.json`.**            | 2026-08-26 | Eng | OpenAPI has no vocabulary for socket events. Generated from the same Zod schemas the server validates against, so the document cannot describe a payload the server would reject, and a drift test fails the build on an undocumented event.                                                  |
| **The socket shares the HTTP server and port.**                                  | 2026-08-26 | Eng | A separate port needs its own load-balancer rule and its own certificate. Riding the same server means realtime inherits the TLS termination and CORS policy the REST API already has.                                                                                                        |

### 1.2i Resolved during Batch 10 (moderation)

| Decision                                                                      | Date       | By                           | Reasoning                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#8 answered: rules-based v1**, behind a `ModerationProvider` interface.     | 2026-08-26 | Eng (placeholder — see 1.2e) | No account and no key, so it cannot become the thing blocking a launch. No per-call cost, so it runs on every message rather than being rationed. And it does not send users’ private messages to a third party, which for a dating app is a real privacy property rather than a cost saving. It is worse at nuance than a model and is meant to be replaced — that is what the interface is for. |
| **The check is advisory at every severity.** `can_send` is a constant `true`. | 2026-08-26 | Eng                          | Spec §5.4. It is written as a constant deliberately: the day it becomes conditional, the product has started blocking messages on a regex.                                                                                                                                                                                                                                                        |
| **Fail open, everywhere.**                                                    | 2026-08-26 | Eng                          | A provider outage returns `timed_out: true`, severity `none`, and queues the content for review. Blocking a user’s message on a third party’s outage is a worse failure than reviewing it late. The message send path fails open too, not just the check endpoint.                                                                                                                                |
| **Checked content is hashed, never stored.**                                  | 2026-08-26 | Eng                          | The row has to be linkable so a moderator can tell two reports about the same text apart. Keeping a copy of every message a user _considered_ sending — including the ones they edited away — is a surveillance database nobody asked for.                                                                                                                                                        |
| **Scam and payment rules take no mode argument at all.**                      | 2026-08-26 | Eng                          | Spec §1 requires these checks to be global rather than dating-scoped, because Trading attracts investment fraud. Making the function unable to accept a mode is stronger than remembering not to pass one.                                                                                                                                                                                        |
| **`MEDIA_AUTO_APPROVE_UPLOADS` deleted**, as promised in 1.2c.                | 2026-08-26 | Eng                          | Replaced by the real pipeline: photos go live on upload and are queued for post-hoc human review (spec §7 asks for a "post-hoc scanning queue"). Every photo pending a moderator would mean nobody can finish onboarding until one is awake.                                                                                                                                                      |
| **A provider that cannot assess a subject queues it rather than passing it.** | 2026-08-26 | Eng                          | Rules read words and cannot look at pixels. Claiming image support would mark every photo clean and leave a queue that looks healthy while nothing is checked — worse than admitting the gap.                                                                                                                                                                                                     |
| **Flags are idempotent per subject, and severity ratchets upward only.**      | 2026-08-26 | Eng                          | A message scanned twice must not appear twice in the queue, and a later benign scan must never quiet an earlier serious finding.                                                                                                                                                                                                                                                                  |
| **The queue answers 403 for non-moderators, not 404.**                        | 2026-08-26 | Eng                          | Unlike a block, where 404 hides whether something exists (§4.4), an admin surface is a documented part of the API. There is nothing to conceal and a clear error is more useful.                                                                                                                                                                                                                  |

### 1.2j Scope decisions — 2026-08-26

| Decision                                                                | By               | Detail                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No Apple in-app purchase work at all.**                               | PO               | The mobile team owns App Store Connect, StoreKit, and the IAP bridge. Batch 13 builds Stripe and the shared subscription lifecycle only. Sign in with Apple (Batch 2) is authentication, not payments, and stays.                                                                                                                                                                                            |
| **Stripe and Twilio: build the functionality, credentials come later.** | PO               | Both go behind provider interfaces and are exercised against mocks, the same shape as the existing Twilio stub. The PO attaches real keys when the client supplies them.                                                                                                                                                                                                                                     |
| **Firebase is set up live, together.**                                  | PO               | Eng stops before Batch 11 and the PO runs the Firebase CLI so the project is configured for real rather than mocked.                                                                                                                                                                                                                                                                                         |
| **Apple/Play accounts are NOT a blocker for building Batch 13.**        | Eng (correction) | Eng had earlier advised starting Apple enrolment urgently. That was wrong: JWS verification uses Apple's public root certificates, and the interface, webhook handlers, lifecycle, and idempotency all build and test without an account. Accounts are needed for sandbox end-to-end verification, which is normal and comes later — and are typically handed to the backend team rather than created by it. |

### 1.2k Resolved during Batch 11 (notifications)

| Decision                                                                               | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ---------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every notification is persisted to the feed AND pushed. Never pushed alone.**        | 2026-08-27 | Eng | Spec §7 states it and the whole module is shaped by it. A push banner is gone the moment it is dismissed, and the Notifications screen reads the feed — so push-only means someone who swiped away a "new match" banner has no route back to it. Persisting first is also what makes push, email, and socket delivery all best-effort. |
| **A missing preference row means the DEFAULT, not "off".**                             | 2026-08-27 | Eng | Users who never opened notification settings have no rows. Treating absent as off would have silently disabled notifications for every existing account the day this shipped.                                                                                                                                                          |
| **Safety notifications cannot be muted** (push or in-app).                             | 2026-08-27 | Eng | Spec §5.7: they carry emergency and moderation outcomes. Someone who muted "safety" a month ago and misses the result of a report they filed is the failure this product cannot have. Their email channel can still be turned off, because that is not the alert.                                                                      |
| **The "someone liked you" notification never names who.**                              | 2026-08-27 | Eng | Who liked you is behind a paywall (`see_who_liked_you`). Naming them in a push banner gives the paid feature away. The notification carries a deep link to the paywalled screen instead. A test asserts neither the name nor the id appears in the payload.                                                                            |
| **`total` in badge counts excludes `discover`.**                                       | 2026-08-27 | Eng | Cards waiting in a deck is not something the user is behind on. Counting it would make the app badge permanently non-zero, which trains people to ignore it.                                                                                                                                                                           |
| **FCM tokens belong to a device, not a user.**                                         | 2026-08-27 | Eng | One person may have a phone and a tablet, each with its own token. Registering a token that was previously on another device MOVES it, because FCM issues one token per install and leaving it on both fans one push out to a device that no longer exists.                                                                            |
| **Plan reminders are a half-hourly sweep, not a timer per plan.**                      | 2026-08-27 | Eng | A timer would have to survive restarts, redeploys, and every edit to the plan time. A sweep asking "what starts soon and has not been reminded?" survives all three, and the feed itself is the idempotency key — no extra column.                                                                                                     |
| **A dead push token is cleared on the provider's say-so, transient failures are not.** | 2026-08-27 | Eng | Only FCM's permanent-failure codes clear a token. Treating a network blip as a dead token would unsubscribe a working device.                                                                                                                                                                                                          |

### 1.2l Scope and correction — 2026-08-28

| Decision                                                     | By               | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Google Play billing is out, as Apple already was.**        | PO               | Both stores belong to the mobile team. Batch 13 is now the provider-agnostic subscription core plus **Stripe only** — no StoreKit, no Play Billing, no store webhooks. The `PaymentProvider` interface stays, so a store implementation can be added later without touching the lifecycle. This removes the batch's largest risk entirely.                                                                                                                                                                                     |
| **A domain is a LAUNCH requirement, not a development one.** | Eng (correction) | Eng had listed the domain as blocking three items. It is not. CloudFront already terminates TLS for clients; the origin hop is unreachable from anywhere but CloudFront; and SES sandbox delivering only to verified addresses is exactly the right shape for development. Spam filtering does not matter when nobody real is receiving. What the domain actually gates — DKIM/SPF alignment, SES production access, branded URLs, origin TLS — all belong to launch. Raising it as urgent created pressure that was not real. |

### 1.2m Resolved during Batch 12 (safety, plans, venues)

| Decision                                                               | Date       | By           | Reasoning                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Erasure destroys identity and KEEPS safety records.**                | 2026-08-28 | Eng          | Closes the GDPR debt from §1.2c. Two obligations pull opposite ways: erasure says a deleted user's data must go, safety says a report about them must survive — otherwise deleting your account becomes the way to erase your own misconduct record. Identifying fields are destroyed; reports, moderation history, and payment records survive pointing at a row that no longer says who it was. |
| **Identifiers are replaced with a random token, not a hash.**          | 2026-08-28 | Eng          | A hash of an email address is still an email address to anyone holding a list to check against. That is precisely how "anonymised" datasets are de-anonymised.                                                                                                                                                                                                                                    |
| **Stopping live-location sharing DESTROYS the trail.**                 | 2026-08-28 | Eng          | Spec §5.7: retain no historical trail beyond the immediate need. The session row survives as the record that sharing happened — a safety investigation needs that — but the positions do not. A stored movement history is the single most damaging thing this database could leak.                                                                                                               |
| **Trusted contacts get no endpoint returning coordinates.**            | 2026-08-28 | Eng          | They have no account here, so there is nothing to authenticate them with, and a shareable link to someone's live position is exactly the artefact §5.7 warns about. They are told sharing STARTED and can contact the person directly.                                                                                                                                                            |
| **A ping on an expired session is refused, never extends it.**         | 2026-08-28 | Eng          | The TTL is the user's consent boundary. A client that keeps sending must not be able to push it outward.                                                                                                                                                                                                                                                                                          |
| **A plan DRAFT is invisible to the other participant.**                | 2026-08-28 | PO-confirmed | Spec §5.8. Someone sketching an idea they might not send must not have it appear on the other person's screen — that is the entire difference between a draft and a message. No notification either.                                                                                                                                                                                              |
| **Only the non-proposer may respond to a plan.**                       | 2026-08-28 | Eng          | Otherwise someone could accept their own proposal and produce a confirmed meeting the other person never agreed to.                                                                                                                                                                                                                                                                               |
| **Only a CONFIRMED plan can be shared with trusted contacts.**         | 2026-08-28 | Eng          | Telling someone's family about a plan that was never accepted is noise, and it leaks the other person's availability before they agreed to anything.                                                                                                                                                                                                                                              |
| **Blocking unmatches; unblocking does NOT restore the match.**         | 2026-08-28 | PO-confirmed | A block alone leaves the match visible and frozen, which is right for a lapsed match and wrong for one deliberately cut. Unblocking means "I am willing to see this person again", not "undo everything" — and the pair can simply match again.                                                                                                                                                   |
| **Venue suggestions centre on the CALLER's location, not a midpoint.** | 2026-08-28 | PO-confirmed | A midpoint sounds fairer but requires reading the other person's coordinates to compute, and exposing where someone lives — even indirectly, through which venues appear — is not worth the convenience.                                                                                                                                                                                          |

### 1.2n Resolved during Batch 13 (subscriptions)

| Decision                                                                                     | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Four SKUs: Basic and Premium, monthly and yearly.** $9.99 / $79.99 / $19.99 / $159.99 USD. | 2026-08-28 | PO  | Quarterly sells to nobody — someone weighing a commitment picks monthly, someone convinced picks yearly for the discount. Annual is a third off, which is what makes it worth offering. Weekly was never added; it is a churn machine.                                                                                                                                      |
| **No free trial in v1.**                                                                     | 2026-08-28 | PO  | Adds trial-to-paid conversion, trial abuse, and an extra lifecycle state. Easy to add later, hard to remove once people expect it.                                                                                                                                                                                                                                          |
| **Tier matrix unchanged from the Batch 6 provisional.**                                      | 2026-08-28 | PO  | See-who-liked-you, boost, and extend-matches stay Advanced-only: they are what people upgrade to Advanced FOR, and moving them to Basic removes most of the reason Advanced exists.                                                                                                                                                                                         |
| **Entitlement resolves from Subscription rows, not `user.subscription_tier`.**               | 2026-08-28 | Eng | Spec §5.10 asks for this explicitly. A column somebody can edit is not an entitlement. The column survives as a denormalised copy for admin lists. This broke 28 tests that granted premium by writing the column — which is the change working: had entitlements kept the column as a fallback, all 28 would have passed and a writable premium switch would have shipped. |
| **Checkout accepts a product SLUG and nothing else.**                                        | 2026-08-28 | Eng | No tier, no price, no receipt. The schema is `.strict()`, so a client sending `tier: advanced` gets a 400 rather than being quietly ignored. Spec §5.10: "a client-trusting implementation is trivially exploitable and will be exploited."                                                                                                                                 |
| **Cancelled, grace-period, and billing-retry all KEEP access.**                              | 2026-08-28 | Eng | Cancelling means "do not renew" and the period is already paid for. A card that needed reissuing must not cost the customer and the payment. Access ends on `current_period_end`, checked at read time.                                                                                                                                                                     |
| **Refund and dispute revoke access immediately.**                                            | 2026-08-28 | Eng | Spec §5.10: a refunded user keeping premium is a straightforward revenue leak. A dispute is treated the same — the money is gone either way, and waiting for the outcome means weeks of free access.                                                                                                                                                                        |
| **Webhook idempotency by provider event id, in its own table.**                              | 2026-08-28 | Eng | Both Stripe and the stores retry; duplicates are routine. The unique constraint is what makes a concurrent duplicate a no-op rather than a double-apply.                                                                                                                                                                                                                    |
| **`express.json()` skips `/webhooks/*`.**                                                    | 2026-08-28 | Eng | Caught before shipping. The global parser ran before the router, so the webhook would have received a parsed object instead of raw bytes and EVERY Stripe signature would have failed — presenting as a wrong webhook secret rather than a middleware ordering bug.                                                                                                         |

### 1.2o Payments leave the backend — 2026-09-10

| Decision                                    | By  | Detail                                                                                                                                                                                                               |
| ------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All Stripe work is removed.**             | PO  | RevenueCat is being handled in the mobile app. The backend keeps no processor, no checkout, no billing portal, no webhook and no receipt validation.                                                                 |
| **Batch 15 admin is out of this codebase.** | PO  | The PO has an existing admin panel frontend, which will live in its own repository. Batch 15 proceeds with everything else: the security pass, the generated contract, the deck load test and the deployment README. |

**What the removal actually touched.** The Stripe adapter, the `PaymentProvider`
interface (its only implementation was Stripe), the provider factory, the checkout
and portal schemas, `applyProviderEvent`, `ProcessedWebhookEvent`, the webhook
router, the raw-body carve-out in `app.ts`, `stripe_price_id`, the `stripe` member
of `PaymentSource`, the four `STRIPE_*` environment variables, the `stripe`
package, and the OpenAPI entries. Roughly 700 lines.

**What deliberately stayed.** The subscription data model — `Subscription`,
`SubscriptionProduct`, `PriceVersion` — plus `resolveTier`, the expiry sweep, and
the two read endpoints. Entitlement resolves from Subscription rows, so removing
these would have broken Batches 6, 7 and 8. The PO asked for Stripe gone and
nothing else touched, and this is where that line falls.

**The §5.10 guarantee got STRONGER, not weaker.** With no writer and no webhook,
there is no code path from a request to a subscription row at all. A test asserts
that `/checkout`, `/portal`, `/restore` and the entire `/webhooks` namespace answer 404,
and that writing `user.subscription_tier` by hand grants nothing. Those two
assertions are the whole contract now.

**One thing the PO should know.** RevenueCat reports entitlement to the app through
its SDK. Nothing may grant access on the strength of that report — an app claiming
"I am premium" is exactly the client claim §5.10 forbids. Whatever eventually
writes Subscription rows has to verify server-side, whether that is this backend
receiving RevenueCat webhooks later or something else doing it. Flagged, not
blocking.

**Migration history was BASELINED rather than extended.** A forward `remove_stripe`
migration would have left the word in the SQL trail, which is the opposite of what
was asked. Instead the `init` migration no longer declares the removed column or
enum value, the hand-written webhook migration is gone, and the recorded checksum
was corrected on every database. `prisma migrate status` reports 5 migrations and
no drift. No environment was reset and no data was lost — checked first that no row
anywhere carried the enum value being dropped, or the type recreation would have
failed.

**What still records that Stripe existed:** this log, and git history. The client
mirror is a single fresh commit, so the repository a contractor sees carries
neither.

### 1.2p Resolved during Batch 14 (video calling)

| Decision                                                      | Date       | By  | Reasoning                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Token TTL is one hour, not ten minutes.**                   | 2026-09-10 | Eng | Eng first proposed ten minutes as "short-lived". Twilio DISCONNECTS a participant when their token expires, so ten minutes would have cut people off mid-conversation. An hour plus a re-issue endpoint gets the security property without the defect: a leaked token is worth little, and a long call reconnects. |
| **Verification is NOT required to call, in v1.**              | 2026-09-10 | Eng | The spec leaves this to policy ("both verified if policy requires"). No such policy exists, and imposing one would block calling for nearly everyone, since verification is only mandatory for Cuddle. Behind `REQUIRE_VERIFICATION_TO_CALL`, so turning it on is one line.                                        |
| **Ringing times out after 60 seconds, decided at read time.** | 2026-09-10 | Eng | Same shape as match expiry. A row still marked `ringing` reads as `missed`, so a late or failed sweep cannot leave a call ringing in someone's history.                                                                                                                                                            |
| **`call` added to `NotificationCategory`.**                   | 2026-09-10 | Eng | `system` would have meant that muting system notices also silenced calls; `safety` would have made calls unmutable, since safety notifications cannot be muted. Neither is right, so the category is its own — a one-value enum addition.                                                                          |
| **A second call on a live match returns the existing call.**  | 2026-09-10 | Eng | Two rows means two rooms, and the pair sit in different ones wondering why they cannot hear each other.                                                                                                                                                                                                            |
| **An API key pair, not the account auth token.**              | 2026-09-10 | Eng | The auth token is the master credential for the whole Twilio account. An API key can be revoked on its own, so a leaked video credential does not also hand over SMS and billing.                                                                                                                                  |

**The shared permission gate.** Calling asks exactly the question messaging
asks — same match, still active, not expired, other account alive, not blocked
— and that logic was a PRIVATE helper inside `chat.service.ts`. It is now
`isPairReachable` in `matches.service.ts`, and chat delegates to it.

Copying five lines would have been quicker and is the thing worth avoiding: the
copy gets updated when a rule changes and the original does not, and whichever
falls behind is a feature that has quietly stopped checking blocks. It is also
re-checked on every token issue rather than only at the start, so blocking
someone who is on your screen stops their next reconnect instead of taking
effect after they hang up.

### 1.3 Still open

**Carried from Batch 13:**

- **`seedEntitlements` is not concurrency-safe, and now we know why it flaked.**
  It is a loop of independent statements — upsert a flag, upsert its three tier
  rows, repeat — so two processes seeding at once interleave and Postgres reports
  `40P01 deadlock detected`. Reproduced on 2026-09-10 by running a focused suite
  while a full run was in progress, which is almost certainly the original
  unexplained flake this was first written to fix.

  The fix is NOT a transaction on its own — a transaction can deadlock just the
  same. It is either one test process per database (now documented in
  `jest.config.js` and CLAUDE.md, and free), or a `pg_advisory_xact_lock` around
  the seed if parallel CI jobs ever have to share one instance. Atomicity is
  still worth having for the interruption case — a half-applied matrix fails
  CLOSED, so the symptom is a paid feature silently switched off rather than an
  error — but it is a separate concern from the deadlock.

- **Build and adopt `Dockerfile.test`.** The suite cannot run natively on the current host. This also belongs in CI regardless.

**Questions** — must be answered before the batch listed:

| #   | Question                                                               | Blocks batch | Status                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12  | Admin analytics — which metrics exactly?                               | —            | **Moot here.** Admin moves to its own repository (§1.2o), so this decision follows it.                                                                                                                                                |
| —   | **Cloudflare R2 instead of S3** for media bytes?                       | —            | **Open, not blocking.** Identical API, no egress charges; for a photo-heavy app egress is the fastest-growing line on the bill. Same SDK code, different endpoint — so it stays cheap to switch right up until there is real traffic. |
| —   | **Profile photo URLs:** CDN signed URLs vs expiring S3 presigned GETs. | —            | **Shipped as presigned GETs.** Works, but each URL is unique per request, so Flutter re-downloads every photo on every render. Revisit when the app is being tuned, not before.                                                       |

**No longer open:**

| #           | Question                                             | Where it was answered                                                                                                                                                        |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2, 3, 14    | Tier split, pricing shape, Stripe-vs-IAP             | §1.2n — four SKUs, matrix unchanged, Stripe only.                                                                                                                            |
| 9           | Cuddle verification                                  | §1.2c — required.                                                                                                                                                            |
| 6, 7, 8, 10 | Match expiry, free caps, moderation provider, Rewind | §1.2e — **shipped on engineering placeholders, not PO decisions.** All but one are a seed edit or a config constant to change. What expiry does to the conversation is code. |
| —           | Block visibility                                     | §1.2e — frozen and visible; 404 everywhere else. Also a placeholder.                                                                                                         |
| —           | RevenueCat                                           | Moot. It abstracts Apple and Google receipt validation, and neither store is in scope.                                                                                       |

---

### 1.4 Questions awaiting an answer — full options

**Emptied 2026-08-31.** This section held the full trade-off write-ups for the
four decisions that blocked Batches 7, 8 and 13 — swipe cap, message cap, match
expiry, and Rewind. All four are answered: the caps and Rewind in §1.2e as
engineering placeholders, the pricing and tier questions in §1.2n by the PO.

They are deleted rather than kept, because a page of options for a question that
already has an answer is the kind of document that gets read as still-open and
re-litigated. The answers, and what each costs to change, live in §1.2.

The one decision still genuinely blocking a batch — admin analytics, #12,
Batch 15 — is in §1.3 and will get its write-up there when Batch 15 starts.

---

## 2. Action log

Newest last. Every entry is something that changed the repository or the machine.

### 2026-08-13 — Specification review

- Read `KINVO_BACKEND_BUILD.md` in full. Produced the §9 first-action reply: mode-system restatement, pushback list, database answer, Batch 0 file plan.
- Raised 11 items of pushback. Acted on: Node 20 EOL, decision #5, decision #11. Recorded for later: block visibility, photo URL strategy, deck-vs-mutable-filters, match expiry side effects, user status model.
- **No code written.** Awaited approval per spec §0.1.

### 2026-08-13 — Batch 0: Foundation

- Created 40 files: TypeScript strict config with path aliases, ESLint 9 flat config, Prettier, Jest + ts-jest, `docker-compose.yml`, `.env.example`, `CLAUDE.md`, `README.md`.
- Built `src/`: env validation, error-code table, `ApiError`, response envelope, Pino logger with PII redaction, request-id and request-logger middleware, error handler, not-found handler, Zod validate middleware, health module, app assembly, server with graceful shutdown.
- Wrote 49 tests across 5 suites.
- **Verified:** `npm run typecheck` clean · `npm run lint` clean · `npm run format:check` clean · 49/49 tests passing · 96.71% line coverage against an 80% threshold · `npm run build` succeeds · compiled server boots and serves the envelope · `tsx` dev server boots and serves the envelope.
- Printed the §0.6 completion report. Stopped.

### 2026-08-13 — Environment verification

- Docker Desktop 29.7.2 installed by PO. `npm run db:up` pulled images and started both containers.
- **Verified:** `kinvo-postgres` healthy on host port 5433 · `kinvo-redis` healthy on host port 6380.
- **Verified:** PostgreSQL 16.4 · databases `kinvo_dev` and `kinvo_test` both present, confirming the init script ran · extensions available: `postgis` 3.4.3, `uuid-ossp` 1.1, `pg_trgm` 1.6 · Redis 7.4.10 responds to PING.
- **Verified PostGIS end to end:** ran a live `ST_DWithin` radius query. A 5 km radius around Westminster returned Westminster (0 m) and Camden (3,688 m) and correctly excluded Manchester. This is the exact query shape the Batch 7 deck builder depends on. Extension created in the throwaway `postgres` database and dropped afterwards, so the Batch 1 migration still does the real work.

### 2026-08-13 — Version control

- `git init -b main`. Default branch is `main`.
- **Verified before committing:** `.env` is ignored (`.gitignore:5`) and `node_modules/` is ignored (`.gitignore:1`). No secret or dependency directory is tracked.
- Initial commit: 41 files, Batch 0 foundation.
- Created this file.
- **Verified after push:** no `.env`, `.pem`, `.key`, or credentials file appears in any commit in history. 44 files tracked.
- **Resolved:** `KINVO_BACKEND_BUILD.md` was missing from the repository. Eng deliberately did not transcribe it from the chat — a reconstructed specification could drift from the master in ways nobody would notice, and this document governs fifteen batches of work. Located the canonical copy at `C:\Users\hp\Downloads\KINVO_BACKEND_BUILD.md` and copied it into the repository root unmodified (39.1 KB, 556 lines, all ten sections present). Verified clean UTF-8 — the corruption seen when the document was pasted into chat was a paste artifact, and a second apparent corruption was PowerShell 5.1 misreading UTF-8-without-BOM as ANSI. `CLAUDE.md`'s reference to the specification now resolves.
- **Defect found in the specification, not fixed:** in §1, a stray blank line at line 109 splits the eight-mode table into a four-row table followed by four orphaned lines of literal pipe text. Content is intact — all eight modes are present and match what has been built. Cosmetic only; renders wrongly. Left for PO to correct, since this is the governing document.

---

### 2026-08-14 — Batch 1: Database schema

- Installed Prisma **7.9.1**. Prisma 7 differs from 5/6 in three ways that shaped this batch:
  1. The datasource URL moved out of `schema.prisma` into a root `prisma.config.ts`.
  2. The generator is `prisma-client` (TypeScript output) with a required `output` path — the client is emitted into the project tree, not `node_modules`. Placed at `src/generated/prisma` so the compiler's `rootDir` covers it; the first attempt at repository root broke `npm run build`.
  3. **The client no longer connects by URL.** A driver adapter is mandatory, so `@prisma/adapter-pg` was installed. Flagged because it is a real dependency the spec did not anticipate.
- Wrote `prisma/schema.prisma`: 48 models, 31 Postgres enums, indexes on every foreign key and every query path the spec names.
- Hand-wrote what Prisma cannot express at the foot of the migration: `CREATE EXTENSION postgis`, 4 GIST indexes, 12 CHECK constraints, 3 partial unique indexes.
- **Verified:** migration applies clean to an empty database · 50 tables · 31 enum types · PostGIS 3.4.3 · every GIST index, CHECK constraint, and partial unique index present in `pg_indexes` / `pg_constraint`.
- Seeded 43 interests, 13 prompt questions, 11 entitlement flags across 3 tiers, 6 subscription products with price versions, 20 venues, and 30 dev users. **Verified idempotent** by running the seed twice and confirming row counts did not double.
- **Verified:** 111 tests passing, 92.12% line coverage · `npm test` bootstraps a dropped-and-recreated `kinvo_test` from nothing · typecheck, lint, format, and build all clean.
- Two Windows-specific problems found and fixed in `tests/globalSetup.ts`: Node refuses to spawn `npx.cmd` without a shell (EINVAL, post-CVE-2024-27980), and passing args through a shell does not escape them (DEP0190). Resolved by running the Prisma CLI's JavaScript with `process.execPath`, which also works unchanged on Linux for CI.

### 2026-08-14 — Batch 2: Auth

- Twelve endpoints: register, login, refresh, logout, forgot/reset/change password, OTP send and verify, Google, Apple, and `GET /auth/me`.
- Middleware every later batch depends on: `authenticate`, `optionalAuth`, `requireOnboarded`, `requireRole`, plus Redis-backed rate limiting.
- Migration `20260813204346_nullable_date_of_birth`. **Prisma generated four `DROP INDEX` statements for the PostGIS GIST indexes** — exactly the fragility flagged in the Batch 1 report, arriving on the very next migration. Removed by hand; the migration now carries a warning block. The GIST assertion in `postgis.test.ts` is the backstop and would have caught it.
- **Verified:** 274 tests passing, 87.21% line and 86.56% function coverage · typecheck, lint, format, and build clean · seed still runs and is still idempotent · GIST indexes survived the migration.
- **Verified end to end against the running build**, not only through Supertest: login → `/auth/me` → refresh → replay rejected 401 → wrong password rejected 401.
- `jose` was installed, then removed: ESM-only, unloadable by the CommonJS test runner. `jwks-rsa` was tried next and failed identically because it depends on `jose`. Apple verification ended up needing no library at all.

### 2026-08-14 — Security audit of Batches 0–2

Requested by PO before starting Batch 3. Findings and fixes:

- **CRITICAL — account takeover via registration. Fixed.** Social sign-in records the user's verified address as an email identity with no password, so a later Google or Apple sign-in links rather than duplicating. `register` treated that empty password as an invitation to set one and returned tokens, so anyone who knew the address of a Google- or Apple-created account could take it over with no proof of mailbox ownership. Registration now always returns 409 for an existing address; the legitimate route to a first password is forgot-password, which requires mailbox control. A test had asserted the vulnerable behaviour and was rewritten. `tests/integration/auth/security.test.ts` now covers it.
- **HIGH — no rate limit on four public endpoints. Fixed.** `generalRateLimit` existed but was never mounted, so `/refresh`, `/reset-password`, `/google`, and `/apple` had no ceiling at all. `/google` and `/apple` make outbound calls to Google and Apple, so an unbounded endpoint let anyone spend our provider quota. Mounted `generalRateLimit` under the whole versioned router and added specific limiters for those four. `/health` is deliberately ahead of the limiter so load-balancer probes are never throttled.
- **MEDIUM — identical JWT secrets were accepted. Fixed.** If both keys matched, only the `type` claim separated a 30-minute token from a 60-day one. Env validation now refuses to start.
- **MEDIUM — wildcard CORS was accepted in production. Fixed.** Harmless while the only client is a mobile app, but the admin web console is coming. Env validation now refuses `*` in production.
- **LOW — tests could corrupt each other.** All suites share one database and truncate between tests; only `npm test`'s `--runInBand` prevented parallel workers wiping each other. `maxWorkers: 1` is now in the Jest config so a bare `npx jest` is safe too.

Verified clean, no change needed: no secrets in any commit; no `console.*` in `src/`; every response goes through the envelope; all raw SQL parameterised through tagged templates, with the one `$executeRawUnsafe` confined to test teardown over `pg_tables` names; PII redaction configured for authorization, cookie, password, token, email, and phone; request logger records `req.path` and never the query string; helmet emitting CSP, HSTS, nosniff, and frame-options.

Accepted risks, recorded rather than fixed:

- ~~`forgot-password` returns the reset token in the response body outside production, so the flow is testable before email lands in Batch 11. **Staging must run `NODE_ENV=production`**, or reset tokens are exposed.~~ Closed 2026-09-16: the endpoint emails a six-digit code, and hands it back only where there is no mail transport at all — which `NODE_ENV` alone never decided correctly, since staging runs as production on purpose. See the entry for that date.
- `display_name` is stored verbatim, including markup. Correct for a Flutter client that renders text, but the admin web console must escape on output (Batch 15).
- ~~`resetPassword` resolves the email identity with `findFirst`. Unambiguous today because the linking rules give a user at most one email identity; it would become ambiguous if that ever changes.~~ Closed 2026-09-16: it now looks the identity up by the address the request names, which is unique by construction.
- **Account deletion does not scrub personal data.** `DELETE /users/me` soft-deletes, revokes every session, and removes the user from every read path, but email, phone, display name, and bio are retained in full. Reports, moderation history, and evidence retention all reference the user, and deciding what must survive an erasure request is a safety question Batch 12 answers. **This is a GDPR exposure until then** — recorded deliberately rather than discovered later, and it must be closed before real users exist.
- Refresh rotation is not transactional, so two simultaneous refreshes can both succeed and leave two live chains in one family. Replay detection still works; worth a row lock if it ever shows up in practice.

### 2026-08-14 — Batch 3: Users, profiles, onboarding

- Eleven endpoints: `GET /config`, profile read/update, location, interests, prompts, preview, public profile, account deletion, and the onboarding status/date-of-birth/complete trio. Added `GET /health/ready`.
- **Built the shared block exclusion clause now rather than in Batch 12.** `GET /users/:id` is the first endpoint that exposes another user, so deferring it would have shipped a leak for Batch 12 to remember to close. `src/modules/safety/block.service.ts` holds it; Batch 12 adds the block/unblock endpoints on top of a helper that is already enforced and tested.
- **`GET /config` landed here.** Spec §4.12 defines it but assigns it to no batch, and Batch 3 is the first that needs interest tags and prompt questions client-side. It serves the per-mode deck action labels, which is what keeps spec §1's "the mode only changes the label" true without an app release per mode.
- **Onboarding requirements are a declared checklist**, not scattered conditionals: display_name, date_of_birth (18+), bio, location, ≥1 interest. Batch 4 and 5 add one entry each.
- **Account deletion is a soft delete only.** Personal data is deliberately not scrubbed — see the accepted risk below.
- **Two production bugs found while fixing a hanging test.** `server.ts` never opened or closed its Postgres and Redis connections: a bad connection string became a 500 on a user's first request instead of a failure at deploy time, and shutdown severed in-flight queries and leaked pool connections. Now connects before accepting traffic and disconnects after the HTTP server drains.
- **Verified:** all Batch 3 suites green.

### 2026-08-20 — Batch 4: Media and verification

AWS access was delayed, so S3 runs locally as **MinIO** in docker-compose. This is not a stubbed storage layer: the application uses the real `@aws-sdk/client-s3`, issues real presigned URLs, and the buckets are genuinely private. Moving to AWS is a change of endpoint and credentials in `.env` with no code change.

- Two buckets, kept apart deliberately: `kinvo-media` for photos, chat media, and voice notes; `kinvo-verification` for government ID images and report evidence, with a much shorter presigned-URL lifetime (spec §7 Batch 4).
- Uploads are a two-step handshake — presign, client PUTs directly to storage, then the server HEADs the object and records what actually landed. An asset without `uploaded_at` may never be attached to anything.
- Migration `media_upload_ledger`: added `profile_photo` to the media kinds and `uploaded_at` to media assets. **Prisma emitted the four PostGIS `DROP INDEX` statements again** — the second occurrence, exactly as the previous migration's warning predicted. Removed by hand; the GIST assertion in `postgis.test.ts` remains the backstop.
- Migration `photo_reorder_staging_band`: the Batch 1 CHECK constraint allowed positions 0–5 only, which made reordering impossible. Reordering has to park photos at temporary positions inside one transaction, because the partial unique index on `(profile_id, position)` rejects any sequence passing through a duplicate. The CHECK now permits −6…5, where negatives exist only between the two phases of a single transaction.
- **Bug found by a test, not in review:** the first reorder attempt promoted the new first photo before demoting the old primary, tripping the one-primary-per-profile partial unique index. Phase one now clears every primary flag as well as parking positions.
- Broke a genuine import cycle: `profiles.service` needed photos for the primary photo URL while `photos.service` needed `ensureProfile`. Moved `ensureProfile` into `profiles/profile.repository.ts`. The cycle resolved at runtime under CommonJS, but only by accident of module ordering.
- Onboarding now requires at least one approved photo, and profile completion scores photos — both as planned in Batch 3. Because completion is normalised over whatever criteria exist, adding one re-weighted the rest automatically.
- Readiness (`/health/ready`) now probes storage alongside Postgres and Redis: with photos on every deck card, unreachable storage is as fatal as an unreachable database.

**`MEDIA_AUTO_APPROVE_UPLOADS` — a temporary switch, recorded so it is not forgotten.** spec §4.8 keeps pending media visible to its owner alone, but nothing moves a photo from pending to approved until the moderation pipeline lands in Batch 10. Without a switch, no uploaded photo would be visible to anyone and no deck card would ever render. It defaults on for development and staging and is **forced off in production** by env validation — the same shape as the Twilio dev stub. **Batch 10 must delete it.**

**Still open, unchanged:** whether profile photo URLs move to CDN signed URLs instead of expiring presigned GETs, and whether media bytes move to Cloudflare R2 (identical API, no egress charges — which matters most for a photo-heavy app). Presigned GETs are correct for now; both remain decisions for the deployment.

### 2026-08-25 — Deployment: AWS staging

- Live at **https://dm9o5kgscmnxv.cloudfront.net/api/v1**. Terraform in `infra/`, ~$18/month against $120 of credits, $60 budget alert at 85% and 100%.
- EC2 t3.small running the API, Postgres+PostGIS, Redis and Caddy in Docker. S3 replaces local MinIO. CloudFront supplies HTTPS on a `*.cloudfront.net` hostname, which satisfies iOS App Transport Security without a domain.
- **Six bugs found by running it, none visible to a passing test suite:**
  1. Prisma emitted ESM because `tsconfig.json` was copied after `prisma generate` — container died on boot, worked locally.
  2. `req.path` is router-relative, so every request logged as `/`.
  3. `postgis/postgis` publishes no arm64 image — crash-looped on Graviton. Switched to x86; architecture must agree in three places (instance type, AMI, Compose plugin).
  4. `set -x` traced the JWT keys and database password into `/var/log/cloud-init-output.log`. Secrets rotated, tracing disabled around the block.
  5. Caddy declared `depends_on: [api]`, so it could not start before the first image existed.
  6. Env validation demanded static S3 keys in production — on AWS the instance role supplies them, so the check mandated the worse practice.
- `infra/tfplan` was caught at `git add` — saved plans embed generated secrets in plaintext. Now git-ignored.
- Deploys build **on the instance**: source is 280KB over S3, versus an 877MB image push that timed out repeatedly on this uplink.

### 2026-08-26 — API documentation

- `/api/v1/docs` (Swagger UI) and `/api/v1/docs/openapi.json`.
- Request bodies generate from the same Zod schemas the endpoints validate with, so they cannot drift.
- `tests/integration/docs.test.ts` parses the route files and fails if any endpoint is undocumented or documented-but-nonexistent.
- Bug caught immediately: the document advertised `http://` because CloudFront sets `CloudFront-Forwarded-Proto`, not `X-Forwarded-Proto`. "Try it out" would have failed on first use.

### 2026-08-26 — Batch 5: Modes and settings

- 12 endpoints: modes (list, get, configure, primary), settings (get, update, snooze, resume), devices (list, revoke, revoke others).
- Migration `user_settings` plus a CHECK bounding text scale to 0.8–2.0. **Prisma tried to drop the four PostGIS GIST indexes for the third time.**
- Per-mode preference validation: one Zod schema per mode, `.strict()`, so `pet_type` on `dating` is rejected rather than stored where it would become a filter matching nobody.
- **Security bug found by its own test: "revoke device" did not revoke.** The Device row recorded the id from the header or body; the refresh token recorded only the body. Signing in with `X-Device-Id` made them disagree, so the revoke matched no tokens, returned 200, and left the session alive. One resolved id now flows to both.

### 2026-08-26 — Batch 6: Entitlements

- `GET /me/entitlements` returns the whole plan in one call: every flag, every quota with what is left of it, the tier, and whether an upgrade exists. The app renders paywalls and remaining-swipe counters from this rather than inferring them from 403s and 422s.
- `EntitlementService.resolve` / `hasFeature` / `getLimit` / `requireFeature`; `requireEntitlement(flag)` middleware.
- Redis quota counters keyed `quota:{name}:{user}:{utc-day}`, TTL to the next UTC midnight, so yesterday expires on its own and no sweeper job is needed.
- **Found a false green in my own new tests.** The endpoint suite passed while Redis was never connected: `readCount` swallows connection errors and reports zero used, which is indistinguishable from a fresh counter. The suite proved nothing. Redis is now connected explicitly in `beforeAll`, and the helper documents why skipping it does not fail loudly.
- Avoided a second trap: `jest.useFakeTimers()` around a live Redis call deadlocks, because ioredis drives its command queue on real timers. The UTC-day test writes yesterday’s key directly instead.
- Batch 5’s duplicate matrix read in `modes.service` deleted.

### 2026-08-26 — Batch 7: Discovery and matching

- 6 endpoints: deck, swipe, rewind, likes-you, boost, stats — all mode-scoped through a path parameter, so no request can reach a service without a mode.
- The deck builder applies six rules at once: the shared block clause, radius, age window, mode-enabled, already-swiped-in-this-mode, and account state. Each has its own test rather than one composite assertion.
- BullMQ added: queue, worker, and a UTC-midnight scheduler. Jobs never start under test.
- **Bug found by its own test: the likes-you filter was inverted.** It excluded actors whose `swipes_made` included a swipe at the viewer — which is the very like being listed, so every admirer silently excluded themselves and the premium inbox was always empty. The correct question is whether the actor RECEIVED a swipe from the viewer. Five tests caught it.
- **Bug found while writing the worker:** the scheduler fans out on the queue it feeds, so the repeatable job arrived with empty data and the worker tried to build a deck for an undefined user. The worker now branches on job name.
- Cursor pagination added (`@utils/cursor`), first used here and reused by matches, messages, and notifications from Batch 8.

### 2026-08-26 — Batch 8: Matches and chat REST

- 11 endpoints: matches (list, detail, unmatch, extend) and conversations (list, detail, messages, send, read, archive/mute, unread-count).
- **Messages paginate BACKWARDS** — the only list in the API that does. A chat opens at the bottom, so the first page is the newest and the cursor walks into history.
- The three Connections tabs are split across two modules by design: Matches and Archived are `GET /matches`; Requests is `GET /discovery/{mode}/likes-you` from Batch 7, because Requests holds profiles who liked you, not conversations (decision #5).
- Media messages go through `claimAsset`, so a verification document cannot be promoted into a chat image. Tested directly.
- Every closed-conversation reason answers one identical 403. A test asserts the blocker and blocked sides receive the same status, code, and message.
- Match expiry sweep added to the daily job — bookkeeping only, since expiry is decided at read time.

### 2026-08-26 — Batch 9: Realtime

- Socket.IO on the same HTTP server. JWT handshake, per-user rooms, message delivery, typing, read receipts, presence, plan updates.
- The contract is published at `GET /docs/realtime.json`, generated from the Zod schemas the server validates with. A drift test fails the build if an event is added without a documented shape.
- `is_online` in `user_compact` became real. It was hardcoded false since Batch 3 — a lie in a shipped contract.

**Four bugs found by the tests, three of them real production defects:**

- **Handlers were registered after several awaits in `onConnection`.** Socket.IO drops a packet with no listener, so a client that emits the moment it connects — exactly what a chat app does when reopening a thread — silently lost the event. Three tests failed on this one cause. Handlers now register before any await.
- **A short-lived connection left a phantom "online" entry.** `markOnline` could land after `markOffline` when a socket opened and closed within milliseconds, leaving the user online until the TTL lapsed. The disconnect handler now waits for the connect sequence before undoing it.
- **Every expired token read as INVALID.** The handshake caught `TokenExpiredError`, but `verifyAccessToken` had already mapped it to an `ApiError` — so the catch never matched. The app signs the user out on INVALID and refreshes on EXPIRED, so this turned every routine 30-minute expiry into a forced sign-out. Now reuses the existing mapping instead of repeating it.
- Typing indicators depended on a room join the sender could not observe; switched to addressing the other participant directly.

### 2026-08-26 — Batch 10: Moderation

- 3 endpoints: `POST /moderation/check` (pre-send, advisory), `GET /moderation/flags` and `PATCH /moderation/flags/{id}` (the moderation queue, moderator/admin only).
- Rules-based provider with 15 rules across 7 categories: scam/payment, contact info, sexual content, hate speech, threats, self-harm, minor safety.
- Post-hoc scanning wired into message send and photo upload. The pre-send check is offered, never required — what was actually sent is scanned regardless of whether the client called it.
- **`MEDIA_AUTO_APPROVE_UPLOADS` is gone**, closing the debt recorded in 1.2c. Photos now go live and are queued for human review.
- Evasion handling split in two after a test caught the first attempt merging adjacent obfuscated words: `normalise()` rejoins letters split by punctuation only, and `compact()` strips everything for a short list of high-value terms. Collapsing spaces in `normalise` turned "w-a-l-l-e-t a-d-d-r-e-s-s" into one word and stopped it matching the phrase it plainly is.
- Ten "ordinary message" cases assert the rules do NOT fire. A warning users learn to dismiss reflexively protects nobody, so the false-positive tests carry as much weight as the true positives.

### 2026-08-26 — AWS hardening

Four gaps closed before starting Batch 11. All $0.

**The security group was open to the world.** Ports 80 and 443 accepted `0.0.0.0/0`, so CloudFront was a suggestion rather than a gate — anyone who found the Elastic IP reached the API directly, skipping the CDN. Port 80 is now restricted to the AWS-managed CloudFront prefix list, and 443 is only opened when a domain exists, because without one nothing listens on it.

**That prefix list covers every CloudFront customer**, so it alone is not enough: someone could aim their own distribution at our IP and be inside the allowed ranges. CloudFront now sends a secret header and Caddy returns 403 without it. Prefix list proves "a CloudFront"; the header proves "our CloudFront".

**Terraform state moved to S3** — versioned, encrypted, with a DynamoDB lock table. It was an 88KB file on one laptop, holding generated secrets in plaintext, and it was the only record of what exists.

**Nightly database backups.** Postgres runs in a container on the API instance with its data in a local volume, so the instance _is_ the database. A dump goes to `s3://…/_backups/` at 03:20 UTC, kept 14 days. A restore drill into a scratch database confirmed 53 tables, 30 users, and 3 matches came back — an untested backup is not a backup.

**A landmine found on the way.** `terraform plan` wanted to REPLACE the running instance, because `user-data.sh` had been edited after launch (the `REQUIRE_THIRD_PARTY_INTEGRATIONS` line) and `user_data_replace_on_change = true`. Any `terraform apply` — including a routine one — would have destroyed the instance and the database with it, and the plan says "must be replaced", not "will delete your data". `user_data` is now under `ignore_changes` with a comment explaining that rebuilding must be deliberate (`-replace=aws_instance.api`) and preceded by a restore plan.

**Two mistakes made while doing this, both mine:**

- Writing the Caddyfile through an SSM `printf` mangled the newlines into literal `n`. Caddy could not parse it and crash-looped, taking staging down for about two minutes. Restored from the backup copy taken immediately before. Subsequent config changes go over base64 with a rollback built into the script.
- The origin secret leaked into terminal output because a redacting `sed` did not match the line it was aimed at. **The secret was rotated** via `terraform apply -replace=random_password.origin_secret`.

**Still open on AWS:** the CloudFront→origin hop is still HTTP. A public certificate authority will not issue for a bare IP, so real TLS there waits on a domain. Until then the hop is inside AWS's network and reachable from nowhere else, which is a mitigation rather than a fix. Postgres should move to RDS before production.

### 2026-08-27 — Batch 11: Notifications

- 9 endpoints: feed, unread count, badges, mark read, mark all read, preferences (list + update), push token register/unregister.
- **Firebase configured live with the PO.** Project `kinvo-staging-48a73c26` created via the Firebase CLI; the Admin SDK service account is held in SSM Parameter Store as a SecureString and injected as one environment variable. It is never written to disk on the instance — a key file on a box ends up in an image, a backup, or a support ticket.
- Push and email both sit behind provider interfaces that fall back to a no-op when credentials are absent. That is only safe because the feed is written first, which is the same reasoning as the socket layer.
- Notifications wired into real events: new match (both sides), new message (recipient only, titled with the sender), new like (target only, without naming who).
- Plan reminders join the BullMQ scheduler on a half-hourly cadence, separate from the daily deck job — a daily sweep would miss anything booked in the morning for that evening, which is most plans.
- SMTP is built and unwired: `SMTP_*` variables are read, and email falls back to a no-op until the PO supplies credentials.

### 2026-08-28 — Batch 12: Safety, plans, venues

- 33 endpoints across three parts: safety (18), plans (8), venues (6), plus the erasure path. 113 endpoints total.
- **The GDPR debt from Batch 3 is closed.** Account deletion scrubs identity while keeping safety and payment records. Both halves are tested — what is destroyed AND what survives.
- Live location is treated as the highest-risk data in the product: explicit start only, a hard TTL that cannot be extended by a client, and destruction of the position trail the moment sharing stops.
- Reporter anonymity has its own test block. The moderation queue is the only path that returns a reporter identity, and it is behind a role gate.
- The block rule is tested across decks, profiles, matches, chat, and plans in one case, as spec §7 asks.
- Location and plan sweeps joined the existing half-hourly scheduler rather than adding another cadence.

**Test-infrastructure note.** Two social-auth tests failed on `beforeEach(resetDatabase)` exceeding the 30-second hook timeout — a single TRUNCATE. They passed in isolation immediately afterwards, and the full run took 47 minutes against roughly 14 earlier in the project. The cause is host degradation (see §1.2n), not the code. The jest timeout was raised to 60s as a ceiling, not a delay.

### 2026-08-31 — Batch 13: Subscriptions (Stripe)

- 6 endpoints plus the webhook. 119 endpoints total. Apple and Google are out of scope; the `PaymentProvider` interface exists anyway so adding a store later is a new class and nothing else.
- Entitlement resolution moved off the editable column onto Subscription rows, completing the switch spec §5.10 asks for.
- Products reduced from six provisional SKUs to four. The dropped ones are DEACTIVATED, not deleted: deleting a product breaks the foreign key on any subscription that ever referenced it, and price history is worth keeping.
- `ProcessedWebhookEvent` migration was written BY HAND and applied with psql, because Prisma's schema engine is blocked on this host (see below). The SQL is what `migrate dev` would have produced, and the ledger row was inserted so schema and history agree. The same hand-written approach already applies to the GIST indexes.

**Host degradation — the reason this batch shipped the way it did.**

Windows Smart App Control moved to Enforced on the development machine partway through this project and progressively blocked unsigned native binaries: first Prisma's schema engine (worked around in globalSetup), then argon2's binding, at which point the test suite could not start at all. Docker was then also unusable — an `apt-get update` ran for over thirty minutes and a bare `docker run node openssl version` timed out.

A Linux test-runner image (`Dockerfile.test`) is committed as the permanent answer and belongs in CI, but it could not be built on this host today.

What shipped is therefore EXACTLY the tree that last ran green at 934/934 across 49 suites. One later change — making the entitlement seed atomic — was reverted rather than committed unverified. It addressed a flake that did not reproduce, and shipping the payments batch verified is worth more than shipping an unverified robustness tweak. It is recorded in §1.3 as outstanding.

### 2026-08-31 — Batch 13 deployed and verified on staging

118 endpoints live. Six of them are Batch 13: products, me, checkout, portal,
restore, and the Stripe webhook.

**The guarantee this batch exists to make, verified against the deployed build.**
Entitlement must come from a Subscription row and never from a column somebody
can edit. Proven directly on staging:

| Database state                                        | Resolved tier                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `users.subscription_tier = advanced`, no subscription | **free** — the column grants nothing                           |
| Active subscription on `advanced_monthly`             | advanced                                                       |
| Status `cancelled`, period still paid                 | **advanced** — cancelling means do not renew                   |
| Status `on_billing_retry`                             | **advanced** — a card being reissued must not cost the feature |
| `refunded_at` set                                     | **free**, immediately                                          |
| `current_period_end` in the past                      | **free** — expiry is decided at read time, not by the sweep    |

Also confirmed: the webhook answers 400 to an unsigned body and to a forged
signature; checkout rejects `{product_slug, tier}` with VALIDATION_FAILED
naming `tier` as unrecognised, which is the `.strict()` schema refusing to let
a client name its own tier. All test data removed afterwards; staging holds no
subscription rows.

32 parameterless GETs across every module return 2xx. The two exceptions are
`/moderation/flags` and `/reports/review`, both 403 for a non-moderator, which
is correct.

**Staging was serving the wrong catalogue, and re-seeding would not have fixed it.**
It still had the six provisional SKUs at the old prices. Two bugs in
`seedProducts`, both found by verifying rather than by any test:

1. The upsert deactivated products missing from the list but never reactivated
   ones that returned — a product pulled and restored would stay invisible, and
   `listProducts` filters on `is_active`, so the only symptom is a plan quietly
   missing from the paywall.
2. A PriceVersion was created only when none was open, so the seed could
   introduce a price but never correct one. Any environment seeded before a
   pricing decision kept the old amount forever while re-seeding reported
   success.

Both fixed. A price change now closes the open version and opens a new one in
one transaction — a new row, never an edit, because the old amount has to
survive for grandfathering and for reconciling what people were actually
charged. Staging was corrected through the same mechanism and now quotes
999 / 7999 / 1999 / 15999, with the superseded amounts retained as closed rows.

The production image carries no `tsx`, so `prisma/seed.ts` cannot run there.
The correction went in as SQL mirroring the seed exactly. **Seeding a deployed
environment has no supported path today** — worth fixing before there is data
worth protecting.

### 2026-09-10 — Batch 14: video calling

- 7 endpoints, 121 total. No migration for the tables: `call_sessions` and
  `call_safety_actions` were created in Batch 1. One migration for the `call`
  notification category.
- The provider is mocked-free: with no credentials it issues a token that is
  deliberately NOT a JWT and could never authenticate against Twilio. A
  plausible-looking fake would be worse — a client would believe it had
  connected when it had not.
- 32 tests. Most of them are the permission boundary, because that boundary is
  the feature: it is the only thing between a stranger and someone's camera.

**A generated migration tried to drop the PostGIS GIST indexes.**

`prisma migrate dev` produced the enum addition and then four `DROP INDEX`
statements against `profiles`, `venues`, `emergency_events` and
`live_location_pings`. That is not drift. Those columns are
`Unsupported("geography")` because Prisma cannot model them, so Prisma cannot
see their indexes either and reads every one as something to remove.

Applying it would have cost nothing at migrate time and turned every radius
query into a sequential scan — the deck builder, venue search and the safety
trail all go through them. A silent full-table scan on the hottest query in the
product, with no error to notice.

The drops were removed and the reason recorded in the migration file itself.
This is the hazard CLAUDE.md already flags under Migrations, and it fired on
the first generated migration since those indexes were written. **Read
generated SQL before applying it.**

### 2026-09-11 — Two bugs staging caught that tests could not

**Providers branched on `NODE_ENV` instead of the integration waiver.**

Staging runs `NODE_ENV=production` with `REQUIRE_THIRD_PARTY_INTEGRATIONS=false`,
which exists so an environment with no Twilio, Google or Apple accounts still
serves. Both the OTP provider and the video provider tested `isProduction`
alone — true on staging — so they threw a raw Error and the endpoint answered
**500** rather than falling back to a stub.

**Phone sign-in had been broken on staging since Batch 2.** Nobody noticed
because nothing had exercised it there; it surfaced only when a video call hit
the identical guard, copied from it. Both now test
`thirdPartyIntegrationsRequired` (production AND the waiver), exported from
`env.ts`. Real production leaves the waiver at its default, so the hard stop
still fires where it matters.

The existing waiver tests covered env PARSING — whether the process boots —
and never which provider the waiver then SELECTED, which is why a suite at
900-plus tests missed it for six batches. `tests/unit/provider-fallback.test.ts`
now covers selection under four environments and fails against the old code.

**Seeded matches expired, and took three features down with them.**

`seedConnections` goes through `createMatchIfMutual` deliberately, so seeded
matches inherit the production 14-day TTL. Right for the creation path, wrong
for the data: two weeks after a seed every seeded match expires, and chat,
plans and calling all refuse at once because all three check reachability.
Staging had been in that state since 2026-09-09 and read as "the API is
broken". Dev matches are now pushed a year out after creation; staging's rows
were refreshed.

**What both have in common.** Neither was reachable from the test suite,
because both are properties of a DEPLOYED environment — one of its
configuration, one of its data ageing. Staging is not a formality before a
release; it is the only place these two classes of bug exist.

**Batch 14 verified end to end on staging:** call started, room name derives
from the call id, token TTL ~3600s, both participants hold tokens for the same
room, client-supplied `room_name` 400s, outsider 404s on token and end,
initiator 403s answering their own call, flag records without ending, invalid
action 400s, duration measured from `answered_at` (25s), hang-up idempotent,
token after the call 409s, history carries no token. 121 endpoints; 33
parameterless GETs 2xx apart from the two moderator-only 403s.

### 2026-09-11 — Batch 15 (admin excluded): contract files, load test, hardening

Admin moves to its own repository (§1.2o), so this batch is the remainder:
generated contract files, the deck load test, and the security pass.

**Deck load test — the first real baseline.**

|               |                                                                    |
| ------------- | ------------------------------------------------------------------ |
| Population    | 20,000 discoverable users, scattered 0–31 km across Greater London |
| Throughput    | 70.8 req/s over 20 connections                                     |
| Latency       | p50 **228 ms**, p97.5 **773 ms**, p99 **1389 ms**                  |
| Errors        | 0 errors, 0 non-2xx                                                |
| Spatial index | **USED** — `Index Scan using profiles_location_gist_idx`           |

Measured on a memory-constrained Windows/Docker host, so treat it as a floor
rather than a target. It deliberately mixes COLD deck builds with warm reads:
decks are persisted per (user, mode, day), so the first request of a day for a
user builds one and the rest read it back. A test that measured only warm
reads would report a latency the product never experiences at nine in the
morning.

The test checks the QUERY PLAN as well as the timing. A load test passes
happily on a sequential scan while the table is small and then falls over in
production, so it fails outright if the radius query stops using the GIST
index — the thing a generated migration tried to drop in Batch 14.

**Two findings from the first two runs, both from the test doing its job.**

The first run reported exactly 300 successes and 6,611 failures: it was
measuring `generalRateLimit`, not the deck. The limiter allows 300 requests
per fifteen minutes **keyed on IP**, and a load test drives everything from one
address. The ceiling is now `RATE_LIMIT_GENERAL_MAX`.

That is not only a testing concern. **Mobile users share carrier NAT in large
groups**, so a busy cell can put many people behind one address and they would
throttle each other. 300 per quarter hour is generous for one person and may
not be for a hundred. Raising it is now a deploy rather than a release; keying
authenticated routes on the account instead is a decision for the PO.

The second run reported 12,188 responses with a healthy-looking p50 of 29 ms —
all of them 429s from a stale process. Stopping a `npx tsx` wrapper had killed
the wrapper and not its node child, so the port stayed bound and the new API
died with EADDRINUSE while the old one kept answering. A counter wired to
autocannon's event stream reported zero rate limits throughout.

The test now makes ONE real request after the run and prints its status and
error code. A single request costs nothing and turns "the endpoint is erroring"
into the actual reason — which is the difference between the two wasted runs
above and a diagnosis.

**Contract files.** `npm run docs:export` writes `docs/openapi.yaml` (121
endpoints across 102 paths) and `docs/realtime.json` (16 socket events). They
are committed on purpose: a generated contract in the repository turns renaming
an error code or dropping an endpoint into a visible diff, rather than
something a client discovers at runtime.

### 2026-09-16 — Password reset: delivery, and a code instead of a link

Requested by PO while integrating the Flutter app, which found the flow dead
end to end.

**Nothing was ever emailed.** `requestPasswordReset` returned the token with a
comment saying Batch 11 would wire the mailer; Batch 11 built the mailer and
wired it to notifications only. The response body carried the token outside
production, and staging runs `NODE_ENV=production` deliberately, so on the only
deployed environment the endpoint answered "a reset link is on its way" and
nothing was on its way. No test could see it: every one of them ran in
`NODE_ENV=test`, where the token came back in the body.

**A six-digit code, not a link (PO decision).** An https link has to be claimed
by the app, which needs a verified domain hosting `assetlinks.json` and an
Apple app-site-association file, and on Android the release signing key's
fingerprint. The app has none of those yet — its id is still
`com.example.kinvo`. A `kinvo://` scheme link needs none of it but can be
claimed by any app on the device, and several mail clients refuse to open one.
A code the user reads also survives the common case of the email arriving on a
different device from the app.

**What the code being low-entropy changed.** A 256-bit token could be looked up
by hash across the whole table and needed no guess counting. Six digits can be
neither:

- The code is hashed with **argon2**, not sha256. A sha256 of six digits is a
  million-entry rainbow table; anything that could read the row — a dump, a
  backup, a replica — could redeem every outstanding reset.
- It is looked up **against one account**, the one the address in the request
  resolves to, never by hash alone. Six digits collide across users constantly,
  and a global lookup would let a caller who knows no address at all walk into
  whichever account shared their guess. `POST /auth/reset-password` therefore
  takes `{ email, code, password }`.
- Wrong guesses are counted on the row and the code is destroyed after
  `PASSWORD_RESET_MAX_ATTEMPTS` (default 5), so it does not live out its hour
  as a target.
- `passwordResetConfirmRateLimit` is now keyed on the address, not the IP.
  Every request from the app arrives through one CloudFront distribution, so an
  IP key is one shared bucket: someone grinding codes spends everyone's
  allowance, and the people locked out are the ones trying to get back in.

**Production now refuses to boot without a mail transport** (SES sender, or all
four SMTP variables). The endpoint cannot report undeliverable mail — its
response is identical whether or not the address is registered, precisely so it
cannot be used to enumerate accounts — so a deployment with no transport looks
healthy while every reset goes nowhere. The integration waiver still lets
staging run without one; there, and in development and tests, the code comes
back as `reset_code`, which is what the suite and the app's staging build use.

**Migration `20260916094500_password_reset_codes`.** Drops the unique index on
`token_hash`, adds `attempts`, and retires every outstanding row: they hold
hashes of link tokens the new endpoint has no way to accept.

**Still open, for the PO.** `app.set('trust proxy', 1)` is one hop short of the
deployed chain — CloudFront, then Caddy, then Node — so `req.ip` is the
CloudFront address on every request. Every IP-keyed limiter is therefore one
shared bucket, registration's ten an hour included. Reset no longer depends on
it, but sign-up still does. The fix is a `TRUST_PROXY_HOPS` setting rather than
a constant 2, because a deployment with a domain has one proxy fewer and
trusting a hop that is not there is what makes `X-Forwarded-For` spoofable.

**Verified:** typecheck, lint and format clean; `docs/openapi.yaml` re-exported.
The suite could not be run on the machine this was written on — it needs
Postgres and Redis from `docker compose`, and Docker is not installed there — so
`npm test` is unrun on these changes and must pass before deploy.

### 2026-09-16 — CI broke on a dependency nobody changed

The build failed before it reached a single test:

    docker: Error response from daemon: pull access denied for minio/minio,
    repository does not exist or may require 'docker login'

Nothing in the repository had changed about MinIO. **`docker.io/minio/minio` no
longer exists** — the Docker Hub repository now 404s, and Docker reports a
missing public repository the same way it reports a private one, so the message
sends you looking for credentials that were never needed.

quay.io is MinIO's own registry and where the images have always been published.
CI and `docker-compose.yml` now pull from there, **pinned** rather than
`:latest`:

- `quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z`
- `quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z`

Pinned for two reasons. This is the second way a moving tag can break a build
with no commit behind it, and the release after this one removes the web console
that `docker-compose.yml` exposes on 9101 — so `:latest` would have quietly
taken the console away from local development as well.

Both tags were checked against quay's registry API before being written in; both
pull anonymously.

### 2026-09-17 — Changed filters took effect a day late

Found while connecting the app's Discover filters. `PATCH /modes/{mode}` saved
a new radius, age range or verified-only setting, and nothing else happened:
today's deck had already been precomputed from the old filters, and
`getDeck` only builds a deck when the day has none. Someone who narrowed their
radius to 5 km kept being shown people 30 km away until midnight UTC, which
reads as the filter being broken.

**Fix:** `updateMode` now calls `discardTodaysDeck` whenever one of the four
fields that build a deck is in the request. The next read of the deck builds a
new one lazily, exactly as a day's first read does, so changing the filters of a
mode nobody is browsing costs nothing.

Deleting rather than regenerating in place is safe because the deck is not
where "already swiped" lives. `generateDeck` excludes swiped people using the
swipes table, so a rebuilt deck never brings back a card the user answered —
asserted by a test. Mode-specific `preferences` are not deck inputs and leave
the deck alone, also asserted.

**Verified:** typecheck and lint clean. The three new cases in
`tests/integration/discovery/deck.test.ts` run in CI; this machine has no
Docker to run them locally.

### 2026-09-17 — Two gaps found while connecting the app's chat

**Reporting with "also block" left the match standing.** "Blocking unmatches"
is PO-confirmed (2026-08-28), but only `POST /blocks` did it: the unmatch was
written inside `block`, and `POST /reports` with `also_block: true` called
the lower-level `blockUser`, which only wrote the block row. Someone who
reported harassment and ticked block still had that person in their matches,
frozen, which is the exact state the decision rules out.

**Fix:** the unmatch moved into `blockUser`, the one function both paths
share, so no future way of blocking can skip it. Two tests in
`tests/integration/safety/safety.test.ts`: reporting with the box ticked
unmatches (and records the reporter as the one who did), and reporting without
it leaves the match alone.

**The socket contract promised a typing:stop the server never sent.** The
published description of `typing:stop` says it is "sent automatically by the
server when you send a message, so the client does not have to". Nothing sent
it. A client that took the documentation at its word would show "typing…"
under a message that had already arrived, until the other person typed again.

**Fix:** `sendMessage` now emits `typing` with `is_typing: false` to the
recipient straight after `message:new`. Typing emits go through a named
`emitTyping`, as the socket handlers' do now too, so the event name and payload
live in one place. One socket test asserts the event on send.

**Verified:** typecheck, lint and format clean. The three new tests run in CI;
this machine has no Docker to run them locally.

### 2026-09-17 — Flagged messages arrived marked unflagged

Found while connecting the app's chat, which shows the recipient a scam warning
on any message with `moderation_flagged` set. `sendMessage` scans a text
message after saving it and sets the flag on the row, but then built the
response and the `message:new` event from the copy it had read before the
scan. Both said `moderation_flagged: false` for a message the database had
flagged, so the warning only appeared once the conversation was reloaded,
which is after the person has already read the message.

**Fix:** the view is built with the flag the scan decided. Nothing else about
moderation changes: it is still advisory, still after the write, and a scan
that fails still leaves the message unflagged and delivered.

**Tests:** the existing post-hoc scan test now also asserts the response says
flagged, and a socket test asserts the live copy does.

**Verified:** typecheck, lint and format clean. The tests run in CI; this
machine has no Docker to run them locally.

### 2026-09-17 — Push notifications: what connecting the app turned up

Found while connecting the app to push notifications. Five fixes, one commit.

**Only email log-in recorded the device.** `POST /notifications/tokens` refuses
a device that isn't recorded ("That device is not signed in"), and devices were
recorded in the `login` controller alone. Every account that signed up, or
signed in with a phone number, Google or Apple, could never register for push.
The same sessions were missing from the device list, so they couldn't be signed
out from another phone either. The OTP and social routes also bound the refresh
token only to a `device_id` in the body, ignoring the header the app sends on
every request.

**Fix:** the controller resolves the device once per sign-in (body, else
`X-Device-Id`) for both the refresh token and the Device row, and every
sign-in route records it. `POST /auth/refresh` records it too, which keeps
last-seen and app version current and gives sessions started before this fix
their device on their next refresh — no data migration needed.

**Signing out left the phone receiving pushes.** `POST /auth/logout` revoked
the refresh token family and nothing else, so the device's FCM token stayed
registered and the account's message previews kept arriving on a phone nobody
was signed in to. **Fix:** logout clears that device's push token, best effort
like the rest of sign-out. The app also removes it before signing out, while it
still can.

**Muting a conversation changed nothing.** `is_muted` was stored and never
read. **Fix:** a message to someone who muted the conversation creates no
notification — no push, no feed entry. The message itself is delivered and
counted unread as before.

**Reading a conversation left its message notifications unread.** Every
message creates a `new_message` feed entry, and nothing marked those read when
the conversation was, so the notifications badge — and the iOS app icon badge,
which is pushed from that count — only ever grew. **Fix:** marking a
conversation read also marks its `new_message` notifications read, in the same
transaction.

**A match notification couldn't open its conversation.** Its data carried the
match id only, so the app needed a request before it could open the chat.
**Fix:** it carries `conversation_id` as well. The `match:new` socket event
already did.

**`notification:new` was emitted but not in the contract.** The service
emitted it with a string literal, which the realtime docs drift test can't see.
It is now in `SERVER_EVENTS` with a schema and description, so it's published
with the rest.

**Tests:** sign-up, phone and Google sign-in record the device (sign-up then
registers a push token); refresh records a missing device and updates its app
version; logout clears the push token; a muted conversation creates no
notification but still counts unread; reading a conversation marks only its
message notifications read; a match notification carries its conversation; the
socket delivers `notification:new`.

**Verified:** typecheck, lint and format clean. The tests run in CI; this
machine has no Docker to run them locally.

### 2026-09-18 — Plans: what connecting the app turned up

Found while connecting the app's Plans tab. One commit.

**Cancelling a draft showed it to the other person.** A draft is visible only
to its creator, but `cancel` turned it into a cancelled plan, and cancelled
plans are visible to both people: the draft appeared in the other person's
history, with its notes and address. This is the second half of blocker 11 in
the 14 September review. **Fix:** `cancel` now refuses a draft, and a new
`DELETE /plans/{id}` deletes one. Only the creator can, only while it is a
draft, and nobody is told. The delete is conditional on the row still being a
draft, so a draft sent a moment ago in another request is never deleted after
the other person heard about it.

Existing leaked rows can't be cleaned up: nothing records whether a cancelled
plan was ever proposed. The app had never used plans before, so there should
be none.

**Plans outlived the match.** Unmatching or blocking left the pair's plans
under Upcoming and Pending for both of them, with nothing either could do
about them. The reminder sweep already skipped them, so the plans said a
meeting was on while the reminders said it wasn't. **Fix:**
`closePlansOnEndedMatches`, called inside the unmatch transaction and inside
`blockUser` (so reporting with "also block" does it too), cancels proposed and
upcoming confirmed plans and deletes drafts. Past plans are left to the
completion sweep. Nobody is notified: the match ending is the news, and a
"plan cancelled" push straight after a block would hint at the block. It lives
in its own file because the matches service importing the plans service would
make an import cycle.

**Plans didn't say who they were with.** A plan carried `match_id` only, so a
list of plans needed a request per row to name the other person. **Fix:** every
plan carries `user`, the other person's `user_compact`, with photos and
presence looked up once per page. Plans with an account that was deleted or
suspended are no longer listed or readable (404), as the matches list already
hides them: showing them would tell those accounts apart from ones that never
existed.

**A proposal whose time passed could still be accepted.** Nothing stopped it,
which confirmed a meeting in the past, and the proposal stayed in Pending, and
on the Plans badge, forever. **Fix:** accepting one is refused (declining is
still fine). Pending and the badge count leave it out, and it lists under
History, as a confirmed plan whose time passed already did. Sending a draft
whose time has passed is refused the same way creating one always was.

**Editing a proposal told nobody.** The creator could change the time or place
after the other person had read it, and they would answer a plan they hadn't
seen. **Fix:** editing a proposal notifies the other person ("Plan changed").
Editing a draft still doesn't.

**Editing could break a plan.** A `venue_id` that didn't exist reached the
database and failed as a 500, and nothing stopped an edit from leaving a plan
with no place at all. There was also no way to switch between a venue and a
typed location, because neither field could be cleared. **Fix:** the venue is
checked as it is on create (404 if it isn't listed). `venue_id` and
`custom_location` accept `null` to switch between them, and one must remain
(`VALIDATION_FAILED`). `cancel` also refuses a declined plan now, like a
completed or cancelled one: there is nothing left to cancel.

**Docs:** `docs/openapi.yaml` and `docs/realtime.json` re-exported. The
realtime document had been missing `notification:new` since that event was
added to the catalogue on 2026-09-17.

**Tests** (`tests/integration/plans/plans.test.ts`):

- A draft is deleted, not cancelled. Only drafts can be deleted, and only by
  their creator.
- Editing a proposal notifies the other person, and editing a draft doesn't.
- You can switch between a venue and a typed location, but one must remain.
  An unknown venue gets a 404.
- Each side sees the other person on the plan.
- A suspended account's plan is hidden.
- A proposal whose time has passed can be declined but not accepted. It moves
  to History and leaves the badge.
- A draft whose time has passed can't be sent.
- Unmatching and blocking close the pair's open plans, and tell nobody.

**Verified:** typecheck, lint and format clean. The tests run in CI; this
machine has no Docker to run them locally.

### 2026-09-18 — Trusted contacts are really told now

Blocker 01 of the 14 September review. Emergency alerts, shared plans and
in-call updates all told the user that their trusted contacts had been alerted.
None of them reached anyone: no email, SMS or push ever went to a contact.

**Email, not SMS (PO decision, 2026-09-18).** SES already sends password reset
codes, works in every country, and costs nothing per message. SMS can be added
in `contact-alerts.ts` later without the callers changing.

**Emergency** (`POST /safety/emergency`) emails every trusted contact who has an
address. The email says:

- when the button was pressed;
- where, as a map link, if the app sent a position;
- the note, if there is one;
- the plan the user is on, if there is one: a confirmed plan that started in
  the last six hours or starts in the next two. It names who they are with,
  where and when.

The safety team gets a copy when `SAFETY_ALERT_EMAIL` (new, optional) is set.

What the user is told is now the truth:

- `contacts` says what happened to each contact: `emailed`, `no_email` or
  `failed`.
- `contacts_notified` counts only the contacts that were emailed.
- `summary` is the sentence to show the user.
- The safety notification says the same thing.

**Shared plans** (`POST /plans/{id}/share`) email each chosen contact the plan.
A contact counts as told (a `plan_shares` row) only once an email to them was
sent. So `shared_with_contacts` counts people who know, and a contact with no
address can be tried again once they have one. A contact already told about a
plan isn't emailed again (`already_told`).

**In-call updates** (`send_live_update`) email the contacts that the user is on
a call, and the notification says who was reached.

**Times** are the user's own. The app sends `utc_offset_minutes`, because the
server knows nobody's time zone. Without it, times are in UTC and say so.

**Abuse.** Alerts could otherwise be used to email anyone the user typed in as
a contact. So there are limits:

- Emergencies and call updates email contacts at most five times an hour per
  user. Every press is still recorded, and the user is told why nobody was
  emailed.
- A plan is emailed to a contact once.
- Everything the user typed is escaped in the HTML, and subject lines drop line
  breaks.

**Also fixed.** `shared_with_contacts` counted both people's shares, so each
could see how many contacts the other had told. Each person now sees only
their own.

**History.** `GET /safety/emergency` returns `contacts_notified: null` instead
of the hard-coded `0` it returned before, because the count isn't stored.
Keeping it needs a new column on `emergency_events`. That is a migration, so it
is left for the PO to decide.

**Not done.** Live location (`/safety/location`) still reaches nobody: only the
sharer can read the trail. Giving contacts a view needs its own design, and the
app doesn't offer live sharing.

**Deploying.** Emails only go out where a sender is configured
(`SES_SENDER_ADDRESS`). While the SES account is in the sandbox, it delivers
only to verified recipient addresses. AWS has to grant production access before
trusted contacts can receive anything.

**Tests:**

- `tests/integration/safety/safety.test.ts`:
  - The emergency emails contacts with an address, and says exactly who was
    reached.
  - An email that didn't send is never counted.
  - No contacts still records the event, and says so.
  - The email names the plan the user is on.
  - What the user typed is escaped in the HTML.
  - Five alerts an hour, then no more emails.
  - The safety team gets a copy.
  - History has no count.
- `tests/integration/plans/plans.test.ts`:
  - The plan is emailed, in the user's time.
  - A contact is emailed about a plan once.
  - A contact with no address isn't counted as told.
  - Each person sees only their own share count.
- `tests/integration/calls/calls.test.ts`: a live update emails contacts.
- The recording mailer moved to `tests/helpers/email.ts`, and the password tests
  use it too.

**Verified:** typecheck, lint and format clean, and `docs/openapi.yaml`
re-exported. The tests run in CI; this machine has no Docker to run them
locally.

### 2026-09-18 — Two details found building the Safety screens

**A contact's phone number or email couldn't be taken away.** The edit schema
required a valid value in each field sent, so an edit could never clear one.
**Fix:** an empty phone, email or relationship now clears it. A contact must
still keep a phone or an email, as when it was created.

**The emergency email said exactly where the user was.** The app only asks for
approximate location, so the map pin is rough. **Fix:** it now says "Roughly
where they were".

**Tests:** in `tests/integration/safety/safety.test.ts`, an edit clears a phone
number, and can't leave a contact with no way to reach them.

**Verified:** typecheck, lint and format clean. The tests run in CI.

### 2026-09-18 — Profile and settings: what connecting the app turned up

Found while connecting the app's Profile tab and Settings. One commit.

**Decks kept showing people until midnight.** A deck is built once a day, and
reading it never checked the people on it again. Someone who took a break,
blocked the viewer, turned the mode off, or was suspended or deleted stayed on
the viewer's cards, photo included, until the next UTC day. Swiping them gave a
404, but the card had already been shown, which is the leak spec §5.5 warns
about. **Fix:** `deckCandidateFilter` holds the rules about the people
themselves: the shared exclusion clause, the mode switched on, onboarded.
Building a deck and reading one both apply it, and the stats' `cards_remaining`
counts only the cards a read would return. The viewer's own filters stay out of
it, because changing those already discards the deck.

**"Show my distance" and "Show when I'm active" were saved and did nothing.**

- `show_distance` false: `distance_metres` is null on deck cards (checked when
  the deck is read, so decks already built follow at once) and on
  `GET /users/{id}`.
- `show_last_active` false: `toUserCompact` returns `is_online: false` and
  `last_active_at: null`. Every list builds people there, so cards, likes,
  matches, chat, plans, calls and blocks all follow, and `USER_COMPACT_SELECT`
  selects the setting so no caller can forget it. No presence update is sent
  about them. Turning it off sends their matches one update with
  `is_online: false, last_active_at: null`, so an open chat stops showing them
  online; turning it back on sends the real state.
- **Contract change:** `last_active_at` in `user_compact` and in
  `presence:update` is now nullable. The app changes with this commit, and no
  released app reads it.
- Hiding your own activity doesn't hide other people's from you. PO decision,
  2026-09-18: "hide theirs only".
- No settings row still means the defaults: both shown.
- `incognito`, `global_verified_only` and `pause_new_matches` are still stored
  and not applied. The API docs now say so, and the app doesn't offer them.

**The owner's preview said 0 metres away.** `GET /users/me/preview` measured
from the owner to themselves, which the app shows as "less than a mile away".
**Fix:** it is null there, since every stranger sees a different distance. The
test that expected 0 now expects null.

**A signed-out device kept working for up to 30 minutes.** Revoking a device
revoked its refresh tokens, but its access token worked until it expired, and
its socket stayed open, still delivering messages. **Fix:** access tokens carry
the device (`did`: the X-Device-Id at sign-in). `authenticate` and the socket
handshake refuse a token whose device was signed out, with AUTH_TOKEN_INVALID
so the app signs out, and revoking closes that device's sockets through a new
`device:{user}:{device}` room. Tokens issued before this change have no `did`
and run out within 30 minutes as before. The check is one indexed lookup per
request, run alongside the user lookup.

**The device list couldn't be trusted.**

- Logging out left the device listed as signed in. It is now signed out, as if
  revoked.
- A password reset or change revoked every refresh token but left every device
  listed, with its access token still working. They are now all signed out.
- A refresh re-registered the device with `revoked_at: null`, so a refresh that
  raced a sign-out from another phone could undo it. A refresh now only updates
  a device that is still signed in (`touchDevice`). Only a new sign-in brings a
  signed-out device back.
- Nothing sent the phone's model or system version, so two Android phones
  looked the same, and the sign-in upsert never updated `model` anyway. New
  optional headers `X-Device-Model` and `X-OS-Version` are recorded at sign-in
  and on every refresh, cut to the column widths.

**A main photo didn't stay main.** Setting one flagged the photo where it stood,
and the next reorder made the first photo primary again. **Fix:** setting a
primary moves the photo to the front, so the primary is always the first photo.

**The last photo could be deleted after onboarding.** Onboarding requires one,
and every card and match row shows it. **Fix:** 409 CONFLICT with
`details.min_photos: 1`. During onboarding it can still be swapped out.

**Completion was a number with nothing to act on.** **Fix:** `GET /users/me`
returns `completion_missing`: the steps not done yet, each with a key and a
label, the ones worth most first. The bio step's label now says it needs 20
characters, since a shorter bio never counted.

**Noticed, not changed:**

- The `discover` and `requests` badge counts include cards from earlier days'
  decks and likes from people now hidden. The app shows neither, but both need
  fixing before anything does.
- Suspending or deleting an account doesn't close its open sockets. They are
  refused at the next connect.

**Tests:**

- `discovery/deck.test.ts`: a deck built today drops people who then take a
  break, block the viewer, are suspended or deleted, or turn the mode off, and
  the stats agree. Hidden distance and activity on cards.
- `users/visibility.test.ts`: hidden distance and activity on profiles, through
  the settings endpoint too. Hiding yours still shows other people's. The
  preview has no distance and follows your own setting.
- `users/profile.test.ts`: `completion_missing` order, steps dropping out as
  they're done, the bio label.
- `settings/settings.test.ts`: a revoked device's access token stops at once, and
  so do the others after "sign out everywhere else". Logging out takes a device
  off the list and signing in again brings it back. Model and system version are
  recorded and updated on refresh, and an over-long header is cut. A refresh
  never revives a signed-out device. A password change signs every device out.
- `realtime/socket.test.ts`: nothing is announced about someone hiding their
  activity; one update when they turn it off, the real state when they turn it
  on. A revoked device's socket is closed and can't reconnect.
- `media/photos.test.ts`: setting a primary moves it to the front and survives a
  reorder. The last photo stays after onboarding and can go during it. Two
  existing tests now add a second photo or run mid-onboarding.

**Verified:** typecheck, lint and format clean, unit tests pass locally. The
integration tests run in CI.

### 2026-09-20 — Video callback and the verification review surface

Both asked for by the backend developer taking the codebase on.

**The video gap was not the endpoints — it was what closes a call.** The seven
call endpoints were complete. What was missing is that a call goes `active`
when answered and stays that way until somebody sends a hang-up. If both
clients vanish — crash, dead battery, tunnel — nothing ever does, and the row
reads `active` for ever at the top of both histories. `sweepRingingCalls` only
ever handled `ringing`.

So: `POST /webhooks/video` for the provider's `room-ended` event, and
`sweepStuckCalls` as the backstop for when that callback never arrives —
unconfigured provider, lost request, anything. The sweep is the one in this
codebase that is NOT merely cosmetic.

Twilio signs the request URL plus sorted form parameters rather than raw bytes,
so unlike the old Stripe webhook this needs no raw-body carve-out in `app.ts`.
It validates against the account auth token, not the API key secret — passing
the key secret fails every time in a way that reads like a misconfigured URL.

The stub refuses every callback when Twilio is unconfigured. Nothing is lost:
no account means no callbacks, and the sweep closes abandoned calls anyway.
Accepting unverified ones would let anyone end anyone's call by guessing a
room name.

**`reviewVerification` already existed and had no route.** The transition was
written in Batch 4 and never exposed. Added `GET /verification/review` and
`POST /verification/{id}/review`, role-gated, on the `/reports/review`
convention rather than a new `/admin/*` namespace — three conventions would be
worse than two. They carry an `Admin` tag in the contract so the panel finds
them together.

The decision stays on this side rather than letting the panel write the row.
That is what makes the rules hold: a second review 409s instead of
overwriting, the badge is recomputed from the records, the action is audited,
and the user is told. A panel setting `status = approved` directly would skip
all four — and this badge is a hard discovery filter and the gate on Cuddle
mode, so who approved an account has to be answerable later.

`AdminAuditLog` has existed since Batch 1 and had never been written to. It is
now, with actor, action, target, metadata and IP.

**A new `verification` notification category**, rather than reusing
`moderation`. Someone who mutes moderation notices would otherwise never hear
that their ID was approved, which is the one thing they are actively waiting
for.

**The GIST-index trap fired for the second time.** `prisma migrate dev`
generated the enum addition plus four `DROP INDEX` statements against the
PostGIS indexes. Stripped again, with the reason recorded in the migration
file. This will keep happening on every generated migration; reading the SQL
before applying it is the only defence.

**Tests:** 42 in the calls suite (was 32), 14 new for verification review, and
the subscriptions assertion that the webhook namespace grants nothing was
narrowed from "no webhooks at all" to the specific payment paths, plus a new
test that the one webhook which does exist cannot move a tier.

### 2026-09-21 — Video moves from Twilio to LiveKit

Found while connecting the app's calling screens, and decided by the product
owner.

**The service was never the problem; the client SDK is.** Twilio Programmable
Video is alive — the December 2026 end-of-life was reversed in October 2024 and
new customers can still sign up. But Twilio publishes no Flutter SDK. The only
one is a community plugin, last released in 2023, which says on its own page
that it should not be used in production. Building the app's call screen on a
three-year-old plugin means a package that may not compile against current
Flutter and Android tooling, no iOS privacy manifest, and nobody to fix either.

Three options were put to the owner: LiveKit and Agora, both of which publish
and maintain their own Flutter SDKs, or keeping Twilio and running the call
inside a WebView with `twilio-video.js`. The WebView costs no backend change
and costs the call instead — audio routing, backgrounding and
picture-in-picture all become unreliable. Agora cannot be self-hosted. LiveKit
was chosen: a maintained Flutter SDK, a free tier, and the option of running it
on our own infrastructure later.

**This file is the whole change, which is what the interface was for.** The
comment at the top of `video.provider.ts` said a vendor swap must be a new
class there rather than a change to the call lifecycle. It held: nothing in
`calls.service.ts` learned which vendor is behind it. The interface itself
moved in three places.

- `issueToken` is **async**. LiveKit signs with WebCrypto. `withToken` and its
  three callers grew an `await` and nothing else.
- `verifyWebhook` became **`readWebhook`**, which verifies AND parses. Each
  vendor names its events differently and signs them differently; splitting the
  two would let one body be verified and a different parse be acted upon.
- `closeRoom` is new. See below.

**The raw-body carve-out that yesterday's entry said was unnecessary is now
necessary.** Twilio signed the request URL plus sorted form parameters, so the
global parser was fine. LiveKit signs a sha256 of the raw body, so
`/api/v1/webhooks/video` gets `express.raw` ahead of `express.json`, and the
controller refuses anything that is not a Buffer. That last check matters: if
the carve-out is ever moved, every genuine callback starts failing, and without
the check it presents as a signature problem rather than a parser ordering
problem.

**`closeRoom` exists because telling an app to stop is not the same as
stopping.** Ending a call writes the row and emits `call:ended`, and until now
that was the whole of it — an app that ignored the event, or was killed with
the media still running, kept the camera up. That is tolerable for an ordinary
hang-up and not tolerable for `end_and_report`, where the person reaching for
the control wants to stop being seen. The room is now deleted after a hang-up,
a decline, and the abandoned-call sweep. It is best-effort by contract and
never awaited by the request: a provider outage must not fail a hang-up and
leave someone in a call they cannot leave. The promise is not dropped either,
so a failure is always logged.

**`video.server_url` is returned with the token**, and is null where no media
server is configured. A token is worthless without the host it was minted for,
and a client holding one but not the other has nothing to act on. Null is a
working answer rather than an error — staging runs with no LiveKit project, the
call still rings, is answered and ends, and the app says video is unavailable
instead of failing. The stub's token stays deliberately not-a-JWT for the same
reason it always was.

The token grant is `roomJoin` for one room, `canPublish`, `canSubscribe`, and
**`canPublishData: false`** — Kinvo's messages go over Kinvo's socket where they
can be moderated and stored, and a data channel here would be an unmoderated
side channel between two people who may have just met. No `roomAdmin`: a
participant must not be able to mute or remove the other from the client.
`identity` is the user id, which the other participant can read, so it carries
no name or email.

Twilio stays in the codebase for SMS and OTP. `TWILIO_API_KEY_SID` and
`TWILIO_API_KEY_SECRET` are gone; `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` are required in production in their place. An empty
`LIVEKIT_URL` reads as unset rather than as a malformed URL, because compose
files and env templates carry empty keys and refusing to boot over one would
stop an environment that is deliberately running without video.

**Tests:** the provider-selection suite now asserts the grant by decoding the
signed token — `roomJoin` true, `room` exactly the room asked for, `sub` the
user id — because an accidental `roomJoin` without a room is a token for every
call on the project, and that is the one mistake this file exists to prevent.
The webhook tests refuse an unsigned callback, a forged header and a body whose
hash cannot match, and assert in each case that the call is still active
afterwards.

### 2026-09-21 — Voice calls: a kind on the call, not on the caller's phone

Asked for by the product owner, who wants the chat header to offer both a
video call and a voice call, as every messaging app does.

**Why this is a column and not a client setting.** A voice call could almost be
done in the app alone: the caller simply does not publish their camera. Almost,
because the other phone has to decide whether to open ITS camera the moment the
call is answered, and the only thing it has at that point is the
`call:incoming` event. Keep the kind on the caller's phone and answering a
voice call opens the callee's camera — the one thing a voice call must not do.

So `call_sessions.kind` is `video` or `audio`, defaulting to **video**: a
client that has never heard of the column keeps behaving exactly as it did, and
so does an old row. `POST /calls` takes an optional `kind`, `call:incoming`
repeats it, and every call view carries it.

**The kind is what the call STARTED as.** Either side may turn video on
mid-call, and that does not rewrite the row: history should say what was
started, and a call that began as voice and became video is a fact about the
conversation, not a correction to it.

Nothing else changed. Both kinds use the same room, the same token and the same
permission check — a voice call is not a cheaper or looser call, it is the same
call with one track fewer at the start.

**The migration was written by hand.** The GIST-index trap has now fired twice
on generated migrations; this one adds an enum and a column, so there was
nothing to generate that was worth the risk of stripping four DROP INDEX
statements again.

**Tests:** a voice call is stored and read back as `audio` by both sides, an
unknown kind is a 400, and the default is asserted where a call is started
without one.

### 2026-09-21 — A call push Android has to wake the app for

The app is adding a ringing call screen for a phone whose app is closed. That
screen is drawn by Android, and Android only hands a push to the app when the
message carries NO notification block: with one, it goes straight to the tray
and the app is never woken. A tray banner cannot ring, cannot cover the lock
screen, and has no Answer button.

So a call now goes out as a data-only message at high priority — to ANDROID.
Apple keeps the ordinary payload: a real incoming-call screen there needs
CallKit and VoIP push, which need a paid developer account and a final app id,
and until then a normal banner is the honest thing to send.

Two platforms, two shapes, so the platform had to travel with the token:
`send` now takes `PushTarget[]` rather than a list of strings. It is already
on the device row — nothing new is stored, it was simply being dropped on the
way to the provider.

`drawnByApp` is set from the category rather than passed in by each caller.
One place decides, and it is the same place that already decides everything
else about a notification.

The title and body still travel in a data-only message, as data, so the app
can draw them. Nothing else about push changed: every other notification goes
out exactly as before, which a test asserts alongside the new one.

### 2026-09-22 — Credentials a rebuilt server keeps

Phone sign-in got its Twilio account today, and video got its LiveKit project
yesterday. Both were typed straight into /opt/kinvo/.env on the running
instance, which works exactly until that instance is replaced: the settings
file is rebuilt from user-data.sh, and whatever was typed into the old one is
gone. Calling and phone sign-in would stop, quietly, with nothing to say why.

So every third-party credential now lives in SSM Parameter Store beside the
ones that were already there, and user-data.sh appends each one it finds. A
missing parameter is not an error — an environment with no Twilio account
still boots and falls back to the stub, the way development does.

They are NOT in Terraform. Putting them there would mean holding the client
credential in a variable file or in state, and rotating a token would become a
code change. Terraform manages the secrets this stack generates; the ones
somebody else issues are put in by hand, under a path the instance policy
already grants.

### 2026-09-22 — A number Twilio will not text is not an outage

Staging's first live phone sign-in answered `503 SERVICE_UNAVAILABLE`, "We
could not verify that code right now. Please try again shortly." Nothing was
down. Twilio had refused the number with error 60200, `Invalid parameter To` —
the number used in the smoke test is a UK range reserved for drama, real
enough to pass an E.164 regex and impossible to text.

The provider caught every Twilio exception the same way, so "this number
cannot receive a text" and "Twilio is having a bad day" produced the same
answer. That answer is advice nobody can act on, on the one screen a new user
cannot get past, and the app would keep retrying a number that can never work.

`twilioRefusal` now sorts the failures Twilio blames on the request from the
ones it blames on itself:

- 60200 invalid `To` and 60205 landline become `VALIDATION_FAILED` with the
  message on the `phone` field, so the app can put it under the box the person
  is looking at.
- 60202 (too many wrong codes), 60203 (too many codes sent) and 60212 (one
  already on its way) become `RATE_LIMITED`, each saying which one it is —
  they clear with time, and two of them mean asking for a new code rather than
  trying the old one again.
- A bare `429` from Twilio is a rate limit even when no code comes with it.
- Anything else is still logged at error and still answers 503. A refusal is
  logged at warn with the last four digits only, as before.

`status === 404` keeps its own path ahead of this: an expired or already-used
verification is a wrong-code outcome, not a refusal, and must read as one.

Verified with unit tests over the mapping itself (`tests/unit/otp-provider.test.ts`),
which needs no Twilio account, plus the staging request that started this. The
stub's doc comment was corrected while here: staging has had Twilio credentials
since this morning, so the stub is now a local-development fallback only.

A follow-up the same day: the refusal was being logged with the exception
attached, and Twilio writes the number into its own message ("Invalid
parameter `To`: +44…"). The redaction in `logger.ts` covers fields named
`phone`, not text inside another field, so the number reached the log next to
the `phone_suffix` that exists to avoid exactly that. The refusal now logs the
Twilio code, the HTTP status and the last four digits, which is what a report
is recognised by. The outage path still logs the whole error: diagnosing an
outage needs it, and those messages carry no number.

The same afternoon, the first real phone sign-in from a handset failed with
Twilio 21608: _"To send messages or make calls to unverified numbers, you must
have an approved Primary Compliance Profile."_ The account is a full one, not
a trial — that was checked when it was set up — but Twilio now gates sending
to any unverified number behind a compliance profile, and this one has not
been completed. Until it is, Verify can only text numbers added as verified
caller IDs in the console.

That is not an outage and not the number's fault, so neither existing answer
fitted. It now maps to its own message: _"We cannot send text messages at the
moment. Please sign in with your email address instead."_ — the app does offer
email, so the person is pointed at something that works rather than told to
try again shortly, which would never have succeeded.

21408 (the destination country switched off in the account's geo permissions)
is mapped with it. It is the same class of problem, only an operator can clear
either, and it is the usual next surprise once the profile is approved. Both
are logged at error with the whole exception, because both need somebody to go
into the Twilio console.

### 2026-09-22 — One photo was all anyone could see of anyone

Every screen that shows another person — a deck card, a match, a profile —
rendered `user_compact.primary_photo_url`, and that was the only photo the API
would give. People upload up to six, arrange them, and nobody but they
themselves ever saw past the first. On a dating product that is not a missing
nicety; it is the thing being decided on.

Two shapes now carry the album:

- `GET /users/{id}` gains `photos`: every approved photo, in the order its
  owner arranged them. A full profile is one person, so the album belongs on
  it. `user.primary_photo_url` now comes from `photos[0]` instead of a second
  query and a second presign — the same image either way.
- A deck card gains the same list. The card is where the looking happens, and
  the two alternatives were both worse: a request per card as it is opened is
  the N+1 §4.7 exists to prevent, and fetching on first swipe makes the swipe
  wait on the network.

`user_compact` is unchanged, deliberately. It is one Dart model shared by every
list — matches, likes-you, conversation headers, call screens — and presigning
a whole album per row for lists that show one thumbnail would cost real work on
every screen to feed a gallery none of them has.

`PublicPhotoView` is smaller than the owner's `PhotoView`: no
`moderation_status`, because that is the owner's business and a viewer is only
ever shown approved photos anyway, and no `is_primary`, because the list is
ordered and the first one is it. Width and height travel with each photo so the
app can hold the right shape of space while the picture loads.

Pending moderation still means invisible to everyone but the owner (§4.8),
which is tested on both paths: a photo set back to `pending` disappears from
the gallery and from the card while staying in its owner's own album.

`getApprovedPhotosForMany` is the bulk form, one query and one presign pass for
a whole deck page. Presigning is local work — an HMAC, not a round trip — so
the cost of a page of albums is the response size, not the latency.

### 2026-09-23 — Google sign-in, switched on

The endpoint and the verification have been there since Batch 2; what was
missing was an audience. `GOOGLE_OAUTH_CLIENT_IDS` was empty on staging, so
`verifyGoogleIdToken` refused every token before looking at it — correctly,
since an audience of nothing can match nothing.

The project's Google sign-in was enabled in the Firebase console (it had never
been: the Identity Toolkit answered `CONFIGURATION_NOT_FOUND`, and enabling a
provider through the API needs a client id and secret that only the console
mints). That created the web client id, which is now the single audience in
`GOOGLE_OAUTH_CLIENT_IDS`, in Parameter Store beside the other third-party
settings and appended by `user-data.sh` so a rebuilt server keeps it.

It is not a secret — it identifies the application and ships inside the app —
but it lives with the secrets because the alternative is a server that boots
fine and refuses every Google sign-in with nothing to say why.

The Android side needed the app's signing fingerprint registered against
`com.example.kinvo`, which is what lets Google issue a token to the app at
all. That was added through the Management API rather than by hand.

Verified on staging: a made-up token now comes back `401
AUTH_TOKEN_INVALID`, where an unconfigured server answers `503 Google sign-in
is not available right now`. The difference is the whole point — the first
means the audience is set and Google's keys were consulted.

### 2026-09-23 — A message sent twice is still one message

Sending had no protection against duplicates. A send that timed out on its way
to the server had usually arrived, and the app offering "try again" — which is
the right thing for it to offer — sent it a second time. The person on the
other end saw it twice, and nothing in the system could tell that the two rows
were one message.

A message now carries `client_token`: what the sending app called it before it
had an id. The same token twice returns the message that already exists.

- **Checked before anything is spent.** The lookup runs before `claimAsset`
  and before the quota is consumed, so a retry costs nothing from the day's
  allowance. Charging for it and refunding later would be the same number in
  the end and a worse story to read.
- **A partial unique index is what actually enforces it.** Two taps in flight
  at once both miss the lookup; the index refuses the second insert, and the
  `P2002` is turned back into the message that won. Partial because most rows
  have no token — every message sent before today, and any client that sends
  none — and a plain unique index would make all of those collide.
- **Scoped to the sender as well as the conversation**, so one person cannot
  swallow the other's message by choosing the same token.
- **A uuid**, refused otherwise. A counter that restarts with the app would
  eventually claim to be a message already sent, which is the same bug wearing
  a different hat.

Migration `20260923060000_message_client_token`, hand-written for the partial
index, which `schema.prisma` cannot express.

The app sends the token from the moment the message is queued and keeps it
through every retry — the whole point is that the second attempt is not a new
message.

### 2026-09-24 — Password reset email: it never arrived, and the API said it had

Every password reset code sent from staging was refused by SES, and the API
answered "a reset code is on its way" every time. Three faults, stacked, and the
third is what hid the first two.

**1. The IAM policy denied every send.** `kinvo-staging-ses` allowed
`ses:SendEmail` on `identity/cintrasoftwaresolutions@gmail.com` — the sender —
which is the obvious way to write it. While an account is in the SES SANDBOX,
though, SES authorises against the RECIPIENT identity as well, so every send to
anybody else came back `AccessDeniedException` naming the recipient. Nothing in
that error mentions the sandbox rule that causes it.

The policy now allows `identity/*` and pins the sender with a `ses:FromAddress`
condition instead. The role still cannot send AS anything but the Kinvo
address — the property worth keeping — and the grant survives production access
being granted, when the recipient check disappears.

**2. The account is in the sandbox.** 200 messages a day, one a second, and
delivery only to verified identities. Test addresses have to be verified one at
a time until production access is granted, and that request needs business
details AWS asks for: it is the product owner's to file, not something to
invent.

**3. The API reported success regardless — the real bug.** `send` returned a
boolean, so "the transport is down" and "that address bounces" were the same
`false`, and `forgotPassword` treated both as nothing worth mentioning. For
notifications that is right: the feed is the record and the email a courtesy.
Password reset has no feed entry behind it. The email IS the product, and
silence sends somebody to refresh an inbox nothing was ever sent to.

`EmailProvider.send` now answers with an outcome — `sent`, `rejected` (this
recipient) or `unavailable` (the transport). Password reset answers
`503 SERVICE_UNAVAILABLE` to the third and stays silent about the second,
because whether an address can receive mail is a fact about the address, and
this endpoint exists to refuse questions about addresses.

- **The refusal is decided BEFORE the address is looked up.** An outage
  reported only for addresses that have accounts is an enumeration oracle
  wearing a 503. Deciding it that early means knowing the transport is down
  without sending anything, which is what `TransportHealth` is for: the last
  outcome, remembered for a minute. The request that DISCOVERS an outage is
  refused too, and it is the only one whose answer depends on an account
  existing — by the time it answers, the failure is recorded and every request
  behind it is refused identically.
- **It forgets after a minute.** Nothing probes SES, so the next request
  through is the probe. A transport that has been fixed must not leave the
  endpoint refusing until somebody notices and restarts something.
- **The classification leans one way on purpose.** Anything unrecognised counts
  as the transport. Mistaking an outage for a bounce costs one silent email —
  today's bug. Mistaking one undeliverable address for an outage makes
  everybody else's reset answer 503, so `MessageRejected` and
  `BadRequestException` are named explicitly and nothing else joins them.
- **`reset_code` in the response body is now reachable only where there is no
  transport at all** — local and test. A deployment that HAS one and cannot use
  it refuses instead of handing the code to whoever asked; on an
  internet-facing staging box that was a password reset anybody could complete
  for anybody.
- Trusted-contact alerts still report both failures as one `failed`. That list
  goes back to the person who raised the alert, who is owed the truth about
  their own contacts either way.

**Found while checking the fix: the logs held the code.** Both providers handed
the raw error and the subject to the logger. The logger redacts KEYS, not text
inside a string, so every refused reset logged the recipient's address — SES
writes it into the error message, and the stack repeats it — and the subject,
which for a password reset is the code itself. Anybody able to read the logs
could have reset that account within the hour. A failed send now logs the
provider, the error's name, the HTTP status and the AWS request id: what a
failure is chased with, and nothing about whom it was for. The tests use the
error text SES actually returned, and one was checked by putting the old
logging back and watching it fail. The lines already written live only in the
api container's own log — nothing ships them anywhere — and the codes in them
had expired within the hour.

Tested where it broke: `classifySesFailure` and `TransportHealth` have unit
tests, because every branch needs SES in a state that is hard or expensive to
reach and the one that shipped broken was unreachable from the integration
suite entirely. The endpoint's own tests cover the refusal being identical for
a registered and an unregistered address, the request that discovers the
outage, a refused recipient reading exactly like success, and recovery once the
transport works again.

Still outstanding, and not code: production access. The bounce and complaint
topic `kinvo-staging-email-events` has no subscribers, which is deliberate and
already argued in `infra/email.tf` — SES suppresses bounced and complained
addresses at the ACCOUNT level, so nothing here needs to read those events, and
the two reputation alarms are what actually watch the rates.

### 2026-09-24 — Test purchases on staging, until RevenueCat

Asked for: tapping Upgrade should give the account that plan, straight away,
until RevenueCat is in — so Basic and Premium can be tested end to end, paywalls
and all, on staging. Approved together with the migration and the deploy, and
with the staging grants of 21 Sep kept rather than reset.

That is exactly what §5.10 forbids for real purchases: a request that turns
into a paid plan. So it is built as a stand-in that cannot survive contact with
production, fenced three ways, each enough on its own:

1. **The routes are absent unless switched on.** `POST` and
   `DELETE /subscriptions/test-purchase` hand over to the same handler an
   unknown path reaches, so where the switch is off they are indistinguishable
   from routes that were never written — including to a signed-out probe, since
   they sit behind `authenticate` like every other path under /subscriptions.
2. **Production refuses to boot with the switch on.** `TEST_PURCHASES_ENABLED`
   is honoured only where `REQUIRE_THIRD_PARTY_INTEGRATIONS` is off, which is
   staging's waiver. Removing the waiver without removing the switch stops the
   deploy rather than shipping free Premium. And it is off unless set to
   exactly `true` — `yes` is still off, because on this one switch a generous
   reading of the operator gives the product away.
3. **A test plan only counts while the switch is on.** Test purchases write
   `source = test`, a new value rather than a borrowed `apple`, and
   `resolveTier` ignores those rows otherwise. A staging database restored into
   production would unlock nothing. This is the lock that holds even if the
   other two are loosened.

How a test plan behaves, and why:

- **It replaces the test plan before it**, as switching plans in a store does.
  Stacking would make switching down impossible, because the tier is the
  highest live plan. Store subscriptions are never touched: a tap must not be
  able to end something somebody paid for.
- **Cancelling ends it at once**, unlike a store cancellation, which keeps
  access to the end of the paid period. Nothing was paid for, and the point of
  cancelling a test plan is to see the tier below.
- **Calendar months, clamped**, as the stores count them (`addMonths` in
  `src/utils/calendar.ts`): 31 January plus a month is the end of February.
  `auto_renew` is false — nothing will renew it, so it must not say it will.
- **One purchase at a time per user**, by locking the user row. Two taps
  racing would otherwise both end the old plan and both start a new one, and
  the higher tier would win whichever came last.
- **The tier is announced after the commit**, never inside it, so the app's
  live update never describes a row a rollback removed.
- **The catalogue says how buying works here**: `purchase_mode` is `test` or
  `none` beside the products, so the paywall asks what is on sale and whether
  it can be bought in one request.

The staging grants of 21 Sep were `source = apple` only because the enum knew
nothing else. They are relabelled `test` on staging after the migration —
which cannot do it itself, because a new enum value cannot be used by the
transaction that adds it — so "Cancel test plan" ends them like any other, and
everyone keeps the Premium they have until they choose not to.

**The paywall describes plans from the matrix, not from the app.** Each
product in `/subscriptions/products` now carries `features`: what that tier
adds over free, in words (`plan-features.ts`). The prototype's screen listed
"Priority support", which no plan has, and several matrix rows are still
provisional (decisions #2, #7, #10); a description typed into the app would be
wrong the day one of them is answered. Only what paying ADDS is listed, and the
table of sentences is a `Record` over the flag vocabulary, so a new flag with
no decision about its paywall line does not compile.

When RevenueCat arrives, `test-purchases.service.ts`, its two routes, the
switch and the relabelled rows are deleted, not adapted. Real purchases reach
the server verified by the store, never from a tap.

### 2026-09-24 — The three privacy switches, applied

`incognito`, `global_verified_only` and `pause_new_matches` have been stored
since 18 Sep and applied by nothing; the app did not offer them. They now do
what they say. The spec's line is only "control who can view profile" (§2.3),
so the two behaviours with more than one sensible reading were put to the
product owner, who chose:

- **Incognito: only people you have liked see you.** Not "hidden from everyone
  but existing matches", which the schema comment had said: under that
  reading an incognito account's likes are invisible, nobody can ever like it
  back, and incognito becomes a way to stop matching that calls itself
  something else. This is the meaning Tinder, Bumble and OkCupid give the
  word, and it lets an incognito account match — with the people it chose
  first.
- **Pause new matches: stay visible, no new match.** Not a second "take a
  break", which already hides someone from decks and keeps their chats.

How each holds:

- **Incognito** is `incognitoFilter` inside `deckCandidateFilter`, so it
  applies at every deck build AND every read — turning it on removes someone
  from decks already built today, at once. It is per mode, like everything in
  discovery: a like in dating reveals nobody to a study-buddy deck.
  `assertIncognitoAllows` guards the other two ways to reach a person: their
  profile (any match, even one that ended, or a like in any mode, lets it
  open) and a direct swipe (a like in that mode). Both refuse with the same
  404 a user who never existed gets. It reads the settings table with a join,
  which snooze deliberately never does — the shared clause runs everywhere,
  this runs only over a day's candidate pool or a page of cards, through
  unique indexes.
- **Pause** refuses the paused person's likes with a new code,
  `NEW_MATCHES_PAUSED` (409), before any quota is spent; passes still work.
  `createMatchIfMutual` — where every match is made — makes none while either
  side is paused, so a like that completes a pair is recorded and waits. A
  swipe is unique per pair and mode, so neither could ever swipe again:
  `matchLikesHeldByPause` makes those matches when the pause ends, and
  announces them to both. Never for a pair that has had a match, even one
  since ended — unmatching was a decision and unpausing is not a way around
  it — nor across a block, nor in a mode either side has turned off. A pair
  where both paused waits for the second to come back.
- **Verified people only everywhere** is OR'd with each mode's own
  `verified_only` when a deck is built, and changing it discards today's
  decks in every mode, as changing one mode's filters does for that mode.

The new error code is added, not renamed, per the table's own rule. The app
offers "Resume" on it rather than a generic failure.

## 3. Batch plan and dependencies

Status: ✅ done · ▶ current · ⬜ not started

| Batch | Name                        | Status | Needs installed / provisioned                               | Blocked by decisions           |
| ----- | --------------------------- | ------ | ----------------------------------------------------------- | ------------------------------ |
| 0     | Foundation                  | ✅     | Node 24, npm                                                | —                              |
| 1     | Database schema             | ✅     | **Docker** (Postgres + PostGIS, Redis)                      | — (#2/#3 seeded provisionally) |
| 2     | Auth                        | ✅     | Docker. Twilio Verify (mocked in tests)                     | —                              |
| 3     | Users, profiles, onboarding | ✅     | Docker                                                      | —                              |
| **—** | **Deployment interlude**    | ✅     | **AWS account + IAM user, AWS CLI, Terraform, domain name** | —                              |
| 4     | Media and verification      | ✅     | **AWS S3 buckets (real)**                                   | Photo URL strategy; R2 vs S3   |
| 5     | Modes and settings          | ✅     | Docker                                                      | **#9** answered                |
| 6     | Entitlements (stub)         | ✅     | Redis                                                       | —                              |
| 7     | Discovery and matching      | ✅     | Redis + BullMQ                                              | #6, #7, #10 — see **1.2e**     |
| 8     | Matches and chat REST       | ✅     | Docker                                                      | #7; block visibility           |
| 9     | Realtime                    | ✅     | Redis. **Host must support WebSockets**                     | —                              |
| 10    | Moderation                  | ✅     | Moderation provider account                                 | **#8**                         |
| 11    | Notifications               | ✅     | **Firebase project + service account, SMTP credentials**    | —                              |
| 12    | Safety, plans, venues       | ✅     | S3 (report evidence)                                        | Block visibility               |
| 13    | Subscriptions (read-only)   | ✅     | None — payments are outside this codebase                   | —                              |
| 14    | Video calling               | ✅     | Twilio SDK already installed; credentials come later        | —                              |
| 15    | Docs, hardening, load test  | ✅     | —                                                           | — (admin is a separate repo)   |

### 3.1 Tooling timeline

Install nothing before it is needed. Unused tools rot.

| Tool            | Needed at            | Status                    |
| --------------- | -------------------- | ------------------------- |
| Node.js 24, npm | Batch 0              | ✅ v24.18.0 / npm 11.16.0 |
| Git             | Batch 1              | ✅ installed              |
| Docker Desktop  | Batch 1              | ✅ v29.7.2, verified      |
| AWS CLI         | Deployment interlude | ✅ installed and in use   |
| Terraform       | Deployment interlude | ✅ installed, state in S3 |

### 3.2 External accounts the PO must provide

Each one gates the batch beside it.

| Account                             | Needed for   | Status                                                                                                                                                         |
| ----------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS IAM user (not root) + MFA       | Interlude    | ✅ `user/Insync`. Root credentials are never used.                                                                                                             |
| Domain name                         | Launch       | ⬜ Not a development blocker (§1.2l). Gates SES production access, DKIM/SPF, branded URLs.                                                                     |
| Twilio (Verify)                     | Batch 2 live | ⬜ Stubbed. OTP is accepted without a real SMS.                                                                                                                |
| Firebase (Cloud Messaging)          | Batch 11     | ✅ Real project, live service account. Push actually sends.                                                                                                    |
| Email sending                       | Batch 11     | ✅ **SES**, replacing the generic SMTP plan. In AWS sandbox — delivers only to verified addresses. Nothing user-facing sends email yet, so this gates nothing. |
| Stripe                              | Batch 13     | ⬜ Built and tested against mocks. Checkout answers `SERVICE_UNAVAILABLE` until keys are attached.                                                             |
| Apple Developer / App Store Connect | —            | **Out of scope** (§1.2j) — the mobile team owns it. Returns if RevenueCat is adopted.                                                                          |
| Google Play Console                 | —            | **Out of scope** (§1.2l). Same.                                                                                                                                |
| Twilio Video                        | Batch 14     | ⬜ The `twilio` SDK is already installed for Verify and issues Video tokens too, so the batch builds without credentials.                                      |

---

## 4. Deployment plan

Runs between Batch 3 and Batch 4. Target: the mobile team gets a working staging URL.

**PO does** — everything requiring a browser sign-in:

1. Enable MFA on the AWS root account. Create IAM user `kinvo-deploy` with scoped permissions. Stop using root.
2. Set a billing alert so a misconfiguration cannot become a silent five-figure bill.
3. Buy the domain.
4. Run `aws configure` locally. **The keys are never pasted into a chat.**

**Eng does:**

5. Install AWS CLI and Terraform.
6. Write the production `Dockerfile` (packages the API — distinct from `docker-compose.yml`, which is local-only and never runs on a server).
7. Write Terraform: VPC, security groups, EC2, RDS Postgres with PostGIS, ElastiCache Redis, S3 buckets, Route 53. **RDS and Redis on the private network only, never publicly reachable.**
8. Caddy config for automatic TLS. HTTPS is mandatory — iOS App Transport Security blocks plain HTTP, and the resulting failure looks like an API bug.
9. `terraform plan`, reviewed with PO, then `terraform apply` on PO's explicit go-ahead.
10. Run migrations against staging RDS. Smoke test.
11. Hand the mobile team a base URL, the docs URL, and seeded test accounts. They receive **staging, never production**.

**Two environments**, staging and production, from identical Terraform with different variables.

---

### 4.1 Deployment traps

- **`deploy.sh` must be passed the image tag docker-compose references**, which is the ECR URI `<account>.dkr.ecr.us-east-1.amazonaws.com/kinvo-staging-api:latest` — not a convenient local name like `kinvo-api:latest`. Passing the wrong tag builds a fresh image that nothing runs: the script reports success, the health check passes against the OLD container, and the deploy looks clean while changing nothing. Caught on the Batch 6 deploy when `/me/entitlements` still 404ed after a "successful" run.
- **The AWS CLI cannot print Docker build output on Windows.** BuildKit draws box characters (U+2502) and the CLI dies with a `charmap` codec error, hiding the entire result. Redirect the deploy to a file on the instance and read it back through `tr -cd "[:print:][:space:]"`.

## 5. Standing engineering decisions

Choices made while building that the specification did not dictate. Recorded so they are not silently reversed.

| Area              | Decision                                                                                                     | Why                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Health endpoint   | `/health` is pure liveness and checks no dependency. Mounted at both `/health` and `/api/v1/health`.         | A liveness probe that fails on a database blip makes the orchestrator kill healthy processes. Readiness gets its own endpoint in Batch 1. |
| Error codes       | Malformed JSON → `400 BAD_REQUEST`. Oversized body → `413 FILE_TOO_LARGE`.                                   | Spec §4.4 names no code for either. Reused existing codes rather than inventing new ones.                                                 |
| Lint              | ESLint 9 flat config (`eslint.config.mjs`), `typescript-eslint` recommended (not type-checked).              | ESLint 9 requires flat config. Type-checked linting is materially slower for marginal benefit here.                                       |
| Jest config       | `jest.config.js`, not `.ts`.                                                                                 | A TypeScript Jest config requires `ts-node` purely to load itself.                                                                        |
| Coverage          | Excludes `src/server.ts`, `src/config/**`, `src/types/**`.                                                   | Spec §0.4 excludes config. `server.ts` cannot run without binding a port; excluded rather than faked.                                     |
| Query validation  | `validate()` redefines `req.query` via `Object.defineProperty`.                                              | Express 4 exposes `query` as a getter-only accessor; plain assignment throws under strict mode.                                           |
| Logging           | Logs `req.path`, never `req.originalUrl`. Redacts authorization, cookie, password, token, email, phone.      | Query strings carry emails and password-reset tokens. Spec §15: no PII in logs.                                                           |
| Docker ports      | Postgres on host 5433, Redis on 6380.                                                                        | Cannot collide with a locally installed Postgres or Redis.                                                                                |
| PostGIS extension | Created by the first Prisma migration, not by the Docker init script.                                        | So it travels with the schema to CI and production instead of existing only on developer machines.                                        |
| Environment vars  | Only the 8 in use are validated. Later-batch credentials are documented but commented out in `.env.example`. | The server must not demand secrets for services it has no code to call.                                                                   |
