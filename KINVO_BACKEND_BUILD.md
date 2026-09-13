# Kinvo Backend — Master Build Specification

**This file is your single source of truth.** Read it fully before writing any code. Re-read the relevant batch section at the start of every session.

You are building a REST API backend for **Kinvo**, a multi-mode social connection mobile app. The only client is a **Flutter mobile app**, plus a future admin web client. You are building **APIs only** — no web frontend, no server-rendered views, no Flutter code.

---

## 0. How you must work

These rules override your defaults. Violating them is worse than working slowly.

### 0.1 Batch discipline

Work is divided into **15 batches** (Section 7). You must:

1. Work on **exactly one batch at a time**, in order.
2. At the start of a batch, restate the batch goal and list the files you intend to create or modify. Wait for my confirmation before writing code.
3. Complete the entire batch — code, tests, docs.
4. Run the full test suite. **All tests must pass.**
5. Print a completion report (format in 0.6).
6. **Stop. Do not start the next batch.** Wait for me to say "proceed."

Never skip ahead. Never combine batches. If a batch feels small, finish it and stop anyway — the review checkpoints are the point.

### 0.2 When you are blocked or unsure

**Ask. Do not guess.** Section 6 lists known open decisions. If you hit a new one:

- Stop.
- State the question, the options, and your recommendation with reasoning.
- Wait.

Do not invent a business rule and bury it in code. Do not silently pick a library not listed in Section 2. A wrong assumption compounds across every later batch.

### 0.3 Scope control

Build **only** what the current batch specifies. No speculative abstractions, no "while I'm here" refactors of code from earlier batches, no extra endpoints that seem useful. If you notice something wrong in an earlier batch, report it in the completion report and let me decide.

### 0.4 Test requirements — non-negotiable

Every batch ships with tests. A batch is not complete if tests fail or are missing.

- **Integration tests** for every endpoint: happy path, validation failure, auth failure, and the permission boundary (can user A touch user B's resource?).
- **Unit tests** for pure business logic: matching rules, entitlement resolution, quota math, distance calculation.
- Tests run against a **real Postgres test database**, not mocks. Mock only external HTTP services (Stripe, Twilio, Firebase, S3).
- Minimum **80% line coverage** on `src/` excluding config and migrations.
- Tests must be independent and runnable in any order. Each test seeds and cleans its own data. No test depends on another having run first.
- `npm test` must pass from a clean checkout with only `docker compose up` for dependencies.

### 0.5 Code quality standards

- Every endpoint validates input with **Zod** before touching business logic.
- No business logic in route handlers. Routes call controllers, controllers call services, services own the logic and touch the database.
- No raw SQL except in migrations and geospatial queries that Prisma cannot express.
- No secrets in code. Everything from environment variables, validated at boot.
- Every `async` operation has error handling. No unhandled promise rejections.
- No `console.log` in committed code — use the logger.
- Comment the *why*, not the *what*. Business rules that came from this spec get a comment citing the section number.

### 0.6 Completion report format

At the end of every batch, print exactly this:

```
BATCH N COMPLETE: <name>

FILES CREATED
- path — one-line purpose

FILES MODIFIED
- path — what changed and why

ENDPOINTS ADDED
- METHOD /path — description — auth requirement

DATABASE CHANGES
- table/column changes, migration filename

TESTS
- X passing, Y total, Z% coverage
- What is covered, and what is deliberately not

DECISIONS I MADE
- Anything I chose that this spec did not dictate, and why

CONCERNS
- Anything that looks wrong, risky, or contradictory

NEXT BATCH: N+1 — <name> (awaiting your go-ahead)
```

If "DECISIONS I MADE" is long, that is a signal the spec was unclear — say so.

---

## 1. What Kinvo is

A multi-mode connection app. The same matching engine serves eight different **connection modes**, and a user can operate in several at once. Dating is one mode among many, not the whole product.

**The eight modes** (final, from the Mode Selector screen):

| Enum value | Display | Deck primary action |
|---|---|---|
| `dating` | Dating | Like |
| `study_buddy` | Study Buddy | Study (Invite) |
| `networking` | Networking | Connect (Intro) |
| `trading` | Trading | Trade (Signal) |

| `foodie` | Foodie | Taste (Table) |
| `cuddle` | Cuddle | Cozy (Warmth) |
| `pet_dates` | Pet Dates | Paw (Playdate) |
| `fitness` | Fitness | Fitness |

**Trading mode is an interest category, nothing more.** Users with a shared interest in trading match and talk about it in chat or meet up. The platform does **not** facilitate trades, transfers, brokerage, portfolio tracking, or asset custody of any kind. Build no endpoint that moves money or assets between users, records a trade, or displays market data. Trading behaves exactly like every other mode — the only difference is the interest tags and the button label.

One consequence worth building in: because this mode attracts finance conversations, it is the most likely place for investment scams. The chat moderation flags in 5.4 already catch payment and money-transfer language; make sure that check runs on Trading conversations rather than being scoped to Dating.

**The mode system is the core architectural decision.** Mode is not a filter applied at the end — it is part of the identity of a swipe, a match, and a conversation. Get this wrong and every module inherits the mistake.

Concretely:
- Swipes are unique on `(actor, target, mode)`. The same pair can like each other in Study Buddy and pass in Dating.
- A match belongs to exactly one mode. Two users can hold multiple simultaneous matches in different modes.
- Discovery preferences are stored **per mode**, not once per user.
- The three deck actions are always `pass` / `like` / `super_like` in the API. The mode only changes the *label* the app renders. Do not create per-mode action enums.

**Bottom navigation:** Discover, Matches, Plans, Profile, More.

---

## 2. Technology stack — locked

Do not substitute. If something here genuinely cannot work, stop and tell me.

| Concern | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| Language | TypeScript, strict mode |
| Framework | Express 4 |
| Database | **PostgreSQL 16 + PostGIS** |
| ORM | Prisma |
| Validation | Zod |
| Auth | JWT access + refresh, `jsonwebtoken` + `argon2` |
| Realtime | Socket.IO |
| Media storage | AWS S3, presigned URLs |
| Push | Firebase Cloud Messaging (`firebase-admin`) |
| SMS / OTP | Twilio Verify |
| Video calling | Twilio Video (token issuance only) |
| Payments | **Apple StoreKit 2 + Google Play Billing** (primary), Stripe (US web link-out) |
| Email | Nodemailer, SMTP from env |
| Jobs / scheduling | BullMQ + Redis |
| Cache | Redis |
| Logging | Pino |
| Testing | Jest + Supertest |
| Docs | OpenAPI 3.1, generated |
| Lint / format | ESLint + Prettier |

**Note on the database — confirmed.** PostgreSQL is the database; PostGIS handles the "3 miles away" radius queries the Discover screens require on every card. S3 stores **media files only**: profile photos, chat images and video, voice notes, verification documents, and report evidence. Never store application records in S3.

**Note on Twilio Video.** Twilio announced an end-of-life for Programmable Video and later reversed it; the product remains supported. Because of that history, put video behind a `VideoProvider` interface so swapping to LiveKit or Agora later is a one-file change.

**Note on payments — read carefully, this shapes Batch 13.**

Kinvo sells digital subscriptions inside a mobile app, which puts it under Apple and Google store billing rules. The position as of August 2026:

- **Apple in-app purchase is required** for consumer digital subscriptions on iOS in essentially every storefront. A US court ruling forced Apple to permit external payment links on the **US storefront only**, currently at 0% commission — but most non-reader apps are still expected to offer IAP alongside any link-out, and outside the US a link-out needs the StoreKit External Purchase Link Entitlement with its own disclosure and reporting conditions. That US carve-out is also under Supreme Court review, so a commission could return.
- **Google Play Billing is required** on Android on the same basis.

Therefore: **StoreKit 2 and Google Play Billing are the primary payment paths.** Stripe stays in the stack as an optional **US-only web link-out** and as the future path for a web app, but it is not the main flow and it is not what the app ships with on day one.

What this means for the backend — and it is a bigger change than it sounds:

1. **The server validates receipts; it does not process payments.** No card data, no checkout session. The app completes the purchase with the store, sends the transaction to the backend, and the backend verifies it with Apple or Google before granting entitlement.
2. **Store server notifications are the source of truth**, not the app. Apple sends App Store Server Notifications V2 (webhook); Google sends Real-time Developer Notifications over Pub/Sub. Renewals, cancellations, refunds, billing retries, and grace periods all arrive this way, and most of them arrive when the app is not running. If you only trust the client, subscriptions will silently drift out of sync.
3. **Admin-controlled pricing largely dies.** The source spec (7.5, 7.8) assumes the backend sets prices and schedules yearly increases. With IAP, prices are configured in App Store Connect and Play Console. The backend can *record* price history and grandfathering for reporting, but it cannot change what a user is charged. This is a real conflict between the spec and the platform — flagged as decision #3.
4. **Everything sits behind one `PaymentProvider` interface** with three implementations: `AppleIAPProvider`, `GooglePlayProvider`, `StripeProvider`. One `Subscription` table with a `source` enum (`apple`, `google`, `stripe`). Entitlement resolution must not care where the money came from.
5. **Cross-platform accounts are the classic trap.** A user who subscribes on iOS and then signs in on Android must keep their subscription. Entitlement lives on the *user*, never on the device or the store transaction.

Consider RevenueCat as an abstraction over Apple and Google receipt validation. It removes a large amount of fiddly, high-consequence code. Raise it as a recommendation in Batch 13 rather than adopting it unilaterally.

---

## 3. Repository structure

```
/
├── src/
│   ├── config/           # env loading + validation, constants
│   ├── db/               # prisma client, seeds
│   ├── middleware/       # auth, error handler, rate limit, validation
│   ├── modules/          # one folder per domain module
│   │   └── <module>/
│   │       ├── <module>.routes.ts
│   │       ├── <module>.controller.ts
│   │       ├── <module>.service.ts
│   │       ├── <module>.schema.ts      # Zod
│   │       └── <module>.types.ts
│   ├── realtime/         # Socket.IO server, namespaces, handlers
│   ├── jobs/             # BullMQ queues, workers, schedulers
│   ├── providers/        # external service adapters (s3, stripe, twilio, fcm)
│   ├── utils/            # shared helpers
│   ├── app.ts            # express app assembly
│   └── server.ts         # entry point
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── tests/
│   ├── integration/      # mirrors modules/
│   ├── unit/
│   ├── helpers/          # factories, auth helpers, db reset
│   └── setup.ts
├── docs/
│   ├── openapi.yaml      # generated, committed
│   └── screens/          # UI reference images
├── docker-compose.yml    # postgres + redis for local dev and tests
├── .env.example
├── CLAUDE.md
└── package.json
```

**Module list** (folder names): `auth`, `users`, `profiles`, `media`, `modes`, `settings`, `discovery`, `matches`, `chat`, `moderation`, `notifications`, `safety`, `plans`, `venues`, `subscriptions`, `calls`, `admin`.

---

## 4. API conventions — every endpoint follows these

The Flutter app writes its networking layer **once**. Any endpoint that deviates costs the mobile team a special case. Deviating is a bug.

### 4.1 Base URL and versioning

```
/api/v1
```

Ship `v1` from day one. Mobile users do not update on demand — you will serve old clients for months. Additive changes stay in `v1`; breaking changes would become `v2`.

### 4.2 Response envelope

Success:
```json
{ "success": true, "data": {}, "meta": null }
```

List:
```json
{
  "success": true,
  "data": [],
  "meta": { "pagination": { "next_cursor": "eyJ...", "has_more": true, "limit": 20 } }
}
```

Error:
```json
{
  "success": false,
  "error": { "code": "AUTH_TOKEN_EXPIRED", "message": "Your session has expired.", "details": null }
}
```

Validation error — `details` keyed by field:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some fields need attention.",
    "details": { "email": ["Enter a valid email address."] }
  }
}
```

`data` is always an object or array, never a bare scalar. Wrap scalars: `{"count": 4}`.

`message` is user-displayable. `code` is stable and machine-readable — the app branches on it, so renaming a shipped code is a breaking change.

### 4.3 Authentication

**Bearer tokens in the `Authorization` header, tokens returned in the response body.** Not httpOnly cookies — Flutter has no cookie jar and Dio interceptors expect bearer tokens.

| Token | Lifetime |
|---|---|
| Access | 30 minutes |
| Refresh | 60 days |

Auth responses return:
```json
{ "access_token": "...", "refresh_token": "...", "token_type": "Bearer", "expires_in": 1800 }
```

Rotate the refresh token on every use and invalidate the old one. If a rotated token is replayed, treat it as theft: revoke the entire token family for that user.

**These three codes must be distinct** — the app does different things for each:

| Code | Meaning | App behaviour |
|---|---|---|
| `AUTH_TOKEN_EXPIRED` | Access token expired | Refresh silently, retry |
| `AUTH_TOKEN_INVALID` | Malformed, revoked, or refresh failed | Log out |
| `AUTH_REQUIRED` | No token sent | Go to sign-in |

Returning a generic 401 for all three forces the client to guess, and the usual guess — log the user out — is wrong for the first case.

### 4.4 Standard error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Field validation failed |
| 400 | `BAD_REQUEST` | Malformed, not field-specific |
| 401 | `AUTH_REQUIRED` | No credentials |
| 401 | `AUTH_TOKEN_EXPIRED` | Access token expired |
| 401 | `AUTH_TOKEN_INVALID` | Bad/revoked/reused token |
| 401 | `AUTH_INVALID_CREDENTIALS` | Wrong email or password |
| 403 | `FORBIDDEN` | Authenticated, not allowed |
| 403 | `ONBOARDING_INCOMPLETE` | Profile setup unfinished |
| 403 | `ACCOUNT_SUSPENDED` | Moderation action |
| 403 | `PREMIUM_REQUIRED` | Feature behind paywall |
| 403 | `USER_BLOCKED` | Target is blocked or blocking |
| 404 | `NOT_FOUND` | Missing or not visible to caller |
| 409 | `CONFLICT` | Duplicate — email taken, already swiped |
| 413 | `FILE_TOO_LARGE` | Upload over limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Bad file type |
| 422 | `QUOTA_EXCEEDED` | Daily swipe/message limit hit |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unhandled |
| 503 | `SERVICE_UNAVAILABLE` | Dependency down |

`PREMIUM_REQUIRED` and `QUOTA_EXCEEDED` carry paywall context:
```json
{
  "code": "QUOTA_EXCEEDED",
  "message": "You've used all your likes for today.",
  "details": {
    "quota_type": "daily_swipes",
    "limit": 50,
    "used": 50,
    "resets_at": "2026-08-14T00:00:00Z",
    "upgrade_available": true
  }
}
```

**Return 404, not 403, when a block is the reason.** A 403 confirms the resource exists, which leaks who blocked whom.

### 4.5 Pagination

**Cursor-based** for decks, matches, messages, notifications. Offset pagination breaks on live lists — a new match arriving mid-scroll shifts every page and the user sees duplicates.

```
GET /matches?limit=20&cursor=eyJpZCI6MTIzfQ
```

Cursors are opaque base64; the client only echoes them back. Default limit 20, max 100. **Messages paginate backwards** — newest first, cursor walks into history.

Offset pagination (`?page=2&per_page=20`) is acceptable for admin lists only.

### 4.6 Data formats

- **Timestamps:** UTC ISO-8601 with `Z`. Field names end in `_at`. Never local time, never epoch.
- **Dates:** `YYYY-MM-DD`. Date of birth only.
- **IDs:** UUID v4 strings. Sequential integers leak user counts and allow enumeration.
- **Field naming:** `snake_case` everywhere in JSON.
- **Booleans:** affirmative names — `is_verified`, not `not_hidden`.
- **Enums:** lowercase snake_case strings, never integers.
- **Money:** integer minor units plus currency — `{"amount": 1900, "currency": "USD"}`. Never floats.
- **Distance:** **metres** in the API. The client formats to miles. Never return `"3 miles away"` — it cannot be localised or sorted.
- **Null vs absent:** return `null`, do not omit the key.
- **Empty lists:** `[]`, never `null`.

### 4.7 Compact objects

Return enough to render a screen in one request. A match list item that returns only `user_id` forces N+1 calls and a janky list.

Define these shared shapes once and reuse them everywhere:

```json
"user_compact": {
  "id": "uuid",
  "display_name": "Sarah",
  "age": 27,
  "primary_photo_url": "https://...",
  "is_verified": true,
  "is_premium": false,
  "is_online": true,
  "last_active_at": "2026-08-13T09:41:00Z"
}
```

They become single Dart models. Full detail comes from the dedicated resource endpoint.

### 4.8 Uploads

`multipart/form-data`. Responses return URL plus metadata plus `moderation_status`. Limits enforced server-side. Media with `moderation_status: "pending"` is visible to its owner and nobody else.

### 4.9 Rate limiting vs quotas

Rate limits protect infrastructure: `429`, `RATE_LIMITED`, `Retry-After` header, plus `X-RateLimit-*` headers on every response.

Business quotas sell subscriptions: `422`, `QUOTA_EXCEEDED`, with upgrade context.

**Never conflate them.** If daily swipes return 429, the paywall never appears and the product does not make money.

### 4.10 Idempotency

Accept an `Idempotency-Key` header on subscription purchase, report submission, and plan creation. Store the key with its response for 24h and replay on repeat. Mobile networks retry; without this you get double charges and duplicate reports.

### 4.11 Headers the app always sends

```
Authorization: Bearer <token>
Accept-Language: en
X-App-Version: 1.2.0
X-Platform: ios | android
X-Device-Id: <stable uuid>
```

### 4.12 Meta endpoints

```
GET /health     # liveness, no auth
GET /config     # feature flags, min app version, enum catalogues
```

`/config` serves mode lists, report reasons, interest tags, and prompt questions so adding a mode does not require an app release.

---

## 5. Business rules

Enforce these in the service layer. Never trust the client.

### 5.1 Identity and age

- Store **date of birth**, never an age integer. Age is computed. The source spec said "Age" — that is a spec bug; do not reproduce it.
- **Reject under-18 at registration.** Legal requirement.
- One user, many `AuthIdentity` rows (email, phone, google, apple). Signing up with email then later using Google on the same address links to the existing user — it does not create a second account.
- Onboarding is a state machine: `pending → active`. A `pending` user is blocked from discovery, matching, and chat with `ONBOARDING_INCOMPLETE`.

### 5.2 Modes

- `UserMode` join table: `user_id × mode`, with `enabled` and per-mode preferences.
- Common preferences are columns: age range, distance radius, verified-only.
- Mode-specific extras are validated JSON: `study_buddy` has subject and academic level; `dating` has relationship goal; `pet_dates` has pet type; `trading` has instrument interests.
- Signup picks one **primary mode**. Onboarding can enable more.
- Whether free users may run multiple modes simultaneously is **an open question** — see Section 6.

### 5.3 Discovery and matching

- Swipe uniqueness: `(actor, target, mode)`.
- Mutual `like` in the **same mode** creates a match in that mode.
- `super_like` counts as a like for matching and is surfaced to the recipient.
- Decks are **precomputed per user per mode per day** so pagination is stable and the algorithm does not re-run on every scroll.
- Deck exclusions: self, already-swiped in this mode, blocked either direction, snoozed users, suspended users, users outside the radius, users outside the age range, and — if `verified_only` is on — unverified users.
- **Verified users rank higher.** A ranking input in the deck builder, not a hard filter. Distinct from the user's `verified_only` toggle, which *is* a hard filter.
- **Rewind / Undo last swipe** appears on every deck screen. Decide whether it is free or premium (Section 6) but implement it as reversing the last swipe in the current mode, restoring the profile to the deck.
- Free users have a **daily swipe cap**. Counter resets at **UTC midnight** — document this; otherwise timezone users report non-bugs.

### 5.4 Matches and chat

- A match carries `expires_at`. "Extend matches" is a premium feature, so matches expire by default. Store the timestamp explicitly rather than computing it.
- Conversation belongs to a match and inherits its mode. The chat header displays the mode.
- Message types: `text`, `image`, `video`, `voice_note`, `venue_card`. Voice notes carry duration.
- **"Review before you send" is advisory, not blocking.** The moderation check returns flags; the UI shows "Edit message" or "Send anyway". When the user overrides, store `moderation_overridden: true` on the message. A user pushing past a scam warning is exactly what the moderation team needs to see later.
- Moderation runs as a **separate pre-send endpoint** so the client can show the warning dialog before committing. If the moderation provider times out, fail open (allow the send) and flag the message for async review — never block a user's message on a third-party outage.
- Free users have a **daily message cap**.
- Connections screen has three tabs: **Matches**, **Requests**, **Archived**. See Section 6 — "Requests" needs definition before Batch 8.

### 5.5 Blocks

**Blocks beat everything.** A blocked pair must never appear in each other's decks, must not be able to match, and existing conversations become read-only. Enforce with a **single shared exclusion clause** used by every query, not re-implemented per endpoint. This is the single most commonly leaked rule in dating apps.

### 5.6 Snooze

Hides the profile from all decks. Does not delete. Account stays active; existing matches and conversations survive.

### 5.7 Safety

- Reports are **anonymous**. The reported user must never learn the reporter's identity through any endpoint, notification, or error message.
- Report reasons: `harassment`, `fake_profile`, `spam_scam`, `safety_concern`. Optional evidence attachments. Optional `also_block` flag that atomically blocks on submit.
- Trusted contacts receive plan and safety updates.
- **Live location is high-risk data.** Explicit start/stop, hard TTL, auto-expire when the plan ends. Retain no historical trail beyond immediate safety need.
- Video calls expose in-call safety actions: flag, end-and-report, send live update.
- **Cuddle mode carries elevated risk.** It invites physical-contact meetups and will attract misuse. Recommend requiring verification to enable it — flagged in Section 6.

### 5.8 Plans

- Statuses: `draft` → `proposed` → `confirmed` | `declined` | `cancelled` → `completed`.
- The Plans screen groups by **Upcoming** (confirmed, future), **Pending** (proposed, awaiting the other person), **History** (completed, cancelled, declined).
- "Save draft" persists a plan visible only to its creator; the other party sees nothing until it is proposed.
- Plans reference a `Venue` or a free-text custom location.
- Only participants in an active, non-blocked match may create a plan together.

### 5.9 Venues

- Admin-curated. Categories: `cafe`, `restaurant`, `park`, `gym`, `study_spot`, `pet_friendly`, `romantic`, `health_conscious`.
- Searchable, sorted by distance, filterable by category. Carry rating and price level.
- "Save for later" is a per-user saved-venues list.
- Venue suggestions are tuned to the match's shared mode.

### 5.10 Money

- `SubscriptionProduct` — deliberately named to avoid collision with date-Plans. Tier, billing cycle, and the store product identifiers: Apple product ID, Google product ID, Stripe price ID. One logical product, three store SKUs.
- `Subscription` — user, product, status, current period, auto-renew, **`source`** (`apple` | `google` | `stripe`), and the store transaction reference. Status values must cover the full store lifecycle: `active`, `in_grace_period`, `on_billing_retry`, `expired`, `cancelled`, `refunded`, `revoked`.
- `PriceVersion` — effective-dated price records for reporting and grandfathering history. Informational only for store purchases; the store owns the actual charge.
- `Entitlement` — resolved feature flags, cached, returned to the app. **The client reads flags; it never infers access from a tier name or a store receipt.**
- **Store server notifications are the source of truth**, not the client. Apple App Store Server Notifications V2 and Google Play Real-time Developer Notifications drive every state change. Verify Apple's JWS signature and Google's Pub/Sub message authenticity. Handle every notification idempotently — both stores retry, and duplicates are normal.
- **Never grant entitlement from a client claim alone.** The app sends a transaction; the server verifies it with the store before anything changes. A client-trusting implementation is trivially exploitable and will be exploited.
- **Entitlement belongs to the user, not the device or the store account.** Subscribing on iOS then signing in on Android must carry over.
- Handle refunds and revocations by removing entitlement promptly — Apple and Google both notify on refund, and a refunded user keeping premium is a straightforward revenue leak.
- Ads (AdMob) are client-side; the backend only exposes `show_ads` in entitlements.

### 5.11 Entitlement matrix

| Capability | Free | Basic Premium | Advanced Premium |
|---|---|---|---|
| Profile, standard discovery | Yes | Yes | Yes |
| Daily swipes | Capped | Unlimited | Unlimited |
| Messaging | Capped | Unlimited | Unlimited |
| Basic filters (age, distance) | Yes | Yes | Yes |
| Advanced filters (interests, goals, category) | No | Yes | Yes |
| See who liked you | No | **?** | Yes |
| Extend matches | No | **?** | Yes |
| Boost / Spotlight | No | **?** | Yes |
| Rewind / undo swipe | **?** | **?** | Yes |
| Multiple simultaneous modes | **?** | **?** | Yes |
| Ads shown | Yes | No | No |

The `?` cells are undecided — Section 6. Build the entitlement system so the matrix is **data, not code**: a seeded table mapping tier to flags. Filling in a `?` later must be a seed change, never a code change.

---

## 6. Open decisions — resolve before the batch that needs them

Do not guess these. Ask me when the batch arrives.

**Resolved — do not re-ask:**

- ~~#1 Database~~ → PostgreSQL + PostGIS. S3 for media only.
- ~~#4 Trading mode~~ → Interest category only. No trading functionality. See Section 1.
- ~~#13 Payment rails~~ → Apple IAP + Google Play Billing primary, Stripe as US-only link-out. See Section 2.

**Still open:**

| # | Question | Blocks |
|---|---|---|
| 2 | Basic vs Advanced Premium — which features in which tier? | Batch 13 |
| 3 | Pricing shape. The source doc says Basic/Advanced × monthly/quarterly/yearly (six SKUs); the Premium screen shows one tier at $19/mo, $99/yr (two SKUs). Which ships? Note that every SKU must be created in App Store Connect and Play Console, so six tiers is real configuration work, and store-set prices mean the doc's yearly-increase automation cannot work as written. | Batch 13 |
| 5 | "Requests" tab on Connections — likes-you inbox, or message requests from unmatched users? Different features, different endpoints. | Batch 8 |
| 6 | Match expiry TTL — how many days? | Batch 7 |
| 7 | Free-tier daily swipe cap and message cap — numbers? | Batch 7, 8 |
| 8 | Moderation provider for "Review before you send" — OpenAI moderation, AWS Comprehend, Perspective API, or rules-based v1? | Batch 9 |
| 9 | Should enabling Cuddle mode require verification? | Batch 5 |
| 10 | Is Rewind free or premium? | Batch 7 |
| 11 | Study Buddy "group study" — one-to-one matching only, or real multi-party groups? Multi-party changes the conversation model fundamentally. | Batch 8 |
| 12 | Admin analytics — which metrics exactly? | Batch 15 |
| 14 | Ship the US Stripe link-out in v1, or IAP only? IAP-only is simpler and always compliant; the link-out saves commission but is US-only, needs region gating, and is under Supreme Court review. Recommend IAP-only for v1. | Batch 13 |

---

## 7. The batches

### Batch 0 — Foundation

**Goal:** A running Express server with tooling, config, and a passing test suite. No business logic.

- TypeScript strict, ESLint, Prettier, path aliases.
- `docker-compose.yml`: Postgres 16 with PostGIS, Redis.
- Env loading with Zod validation at boot — **crash on missing required vars**, never start half-configured.
- Express app: helmet, cors, compression, JSON body limits.
- Pino logger with request IDs.
- Global error handler producing the Section 4.2 envelope.
- `GET /health`.
- Jest + Supertest wired, test DB setup/teardown helpers, coverage reporting.
- `.env.example` with every variable documented.
- `CLAUDE.md` at repo root: stack, structure, conventions, commands.

**Done when:** `npm run dev` starts, `GET /api/v1/health` returns the envelope, `npm test` passes.

---

### Batch 1 — Database schema

**Goal:** Complete Prisma schema and migrations for the entire product. One pass, so later batches never fight the schema.

- All entities from Sections 1 and 5.
- PostGIS geography column on profiles, with a GIST index.
- Indexes on every foreign key and every query path described in this document — especially `(actor_id, target_id, mode)` on swipes and `(conversation_id, created_at)` on messages.
- Enums as Postgres enums.
- Soft deletes where audit matters (users, messages, reports).
- Seed script: modes, interest tags, prompt questions, report reasons, subscription products, entitlement matrix, venue categories, plus ~30 realistic dev users spread across modes and locations.

**Database is confirmed — proceed.**

**Done when:** migrations run clean on an empty DB, seed populates, a test asserts a PostGIS radius query returns the expected users.

---

### Batch 2 — Auth

**Endpoints:** register (email), login, refresh, logout, forgot-password, reset-password, change-password, send-OTP, verify-OTP, Google sign-in, Apple sign-in, `GET /auth/me`.

- Argon2 hashing.
- Refresh token rotation with family-based theft detection.
- Twilio Verify for OTP (mockable in tests).
- Social login creates or **links** an `AuthIdentity` — never a duplicate user.
- Under-18 rejection at registration.
- Password reset tokens: single-use, 1-hour expiry.
- Rate limits: login, OTP send, password reset.
- `authenticate` and `optionalAuth` middleware, plus `requireOnboarded` and `requireRole`.

**Tests must cover:** wrong password, expired token, reused refresh token revokes the family, under-18 rejected, OTP expiry, social login linking to an existing email.

---

### Batch 3 — Users, profiles, onboarding

Profile CRUD, onboarding completion, interests, prompts, lifestyle preferences, job title and organisation, public profile view, profile completion percentage, the "how others see you" preview payload, account deletion.

Onboarding transitions `pending → active` only when required fields are present.

---

### Batch 4 — Media and verification

- S3 presigned upload flow, photo CRUD, reorder, set primary, max 6.
- Voice note upload with duration.
- Verification: three methods (`photo`/selfie, `government_id`, `social`), three-step wizard state, `pending → approved | rejected`, badge derived from the latest approved record.
- Verification documents go to a **separate private bucket or prefix** with stricter lifecycle rules than profile photos. Government ID images are the most sensitive data in this system.

---

### Batch 5 — Modes and settings

Mode enable/disable, per-mode preferences with per-mode JSON schema validation, primary mode, all settings from the Settings and Mode & Privacy screens, theme and accessibility (server-persisted so it syncs across devices), snooze, connected devices list and revoke.

**Confirm decision #9 first.**

---

### Batch 6 — Entitlements (stub)

Build the resolver and middleware early so discovery and chat call it from day one rather than retrofitting gating later.

- `EntitlementService.resolve(userId)` returning a flag map from the seeded matrix.
- `requireEntitlement(flag)` middleware returning `PREMIUM_REQUIRED` with paywall context.
- Quota counters in Redis with UTC-midnight reset, `checkQuota` / `consumeQuota`.
- `GET /me/entitlements`.
- Real subscription lookup arrives in Batch 13; until then resolve from a `subscription_tier` column defaulting to free.

---

### Batch 7 — Discovery and matching

Deck generation per mode, swipe, mutual-like detection, rewind, "who liked you", boost, deck stats (liked/passed/boosts on the empty state), discovery filters, mode-scoped everything.

Deck builder must apply the **shared exclusion clause** (5.5). Precompute daily decks via a BullMQ job.

**Confirm decisions #6, #7, #10 first.**

**Tests must cover:** mutual like creates exactly one match, the same pair can match in two modes independently, blocked users never appear, radius filtering is correct, swipe cap returns `QUOTA_EXCEEDED` with paywall context, rewind restores the profile.

---

### Batch 8 — Matches and chat REST

Match list with tabs, match detail, unmatch, extend match, conversation list, message history (backwards cursor), send message, mark read, unread counts, archive, media messages, venue cards.

**Confirm decisions #5 and #11 first.**

---

### Batch 9 — Realtime

Socket.IO with JWT handshake auth, per-user rooms, message delivery, typing indicators, read receipts, presence and last-active, plan updates.

Socket events must have documented payload shapes — the Flutter team needs them as much as the REST contract.

Persist first, then emit. Never rely on the socket for durability.

---

### Batch 10 — Moderation

Pre-send check endpoint returning flags and severity, override tracking, post-hoc scanning queue, flag storage for the moderation team.

**Confirm decision #8 first.** Fail open on provider timeout (5.4).

---

### Batch 11 — Notifications

FCM device token registration, in-app notification feed, mark read, mark all read, per-channel and per-category preferences, badge counts for all five tabs, email notifications, scheduled plan reminders via BullMQ.

Every notification is persisted to the feed **and** pushed. The Notifications screen reads the feed, so a push-only notification silently disappears.

---

### Batch 12 — Safety, plans, venues

- Trusted contacts CRUD, share-current-location, live-share sessions with TTL, emergency help.
- Reports with evidence upload and atomic `also_block`.
- Block and unblock, block list.
- Plans full lifecycle including drafts, plan sharing with trusted contacts.
- Venues: search, filter, distance sort, save for later, suggest-to-match.
- Availability windows.

**Test the block rule hard here** — decks, matching, chat, plans, and profile views must all respect it.

---

### Batch 13 — Subscriptions

- `PaymentProvider` interface with `AppleIAPProvider`, `GooglePlayProvider`, and `StripeProvider` implementations.
- Product listing endpoint returning per-platform store product IDs so the app knows what to request from StoreKit or Play Billing.
- Receipt verification endpoint: app submits a transaction, server verifies with Apple or Google, grants entitlement.
- **App Store Server Notifications V2** webhook with JWS signature verification.
- **Google Play Real-time Developer Notifications** via Pub/Sub.
- Full lifecycle handling: initial buy, renewal, grace period, billing retry, cancellation, expiry, refund, revocation, upgrade, downgrade.
- Idempotent notification processing — both stores retry and duplicates are routine.
- Subscription status endpoint, restore-purchases endpoint.
- Entitlement resolution switched from the Batch 6 stub to real subscription data.
- Stripe path only if decision #14 says ship it.

**Confirm decisions #2, #3, #14 first. Raise RevenueCat as an option before writing raw receipt-validation code.**

**Tests must cover:** unverified receipt is rejected, forged client claim grants nothing, duplicate store notification is a no-op, refund revokes entitlement, an iOS subscription resolves for the same user signing in on Android, cancellation keeps access until period end, grace period keeps entitlement while billing retries.

---

### Batch 14 — Video calling

Twilio Video token issuance behind the `VideoProvider` interface, call session lifecycle, in-call safety actions, call history, permission check (active match, not blocked, both verified if policy requires).

Tokens must be **short-lived and scoped to a specific room**. Never issue a token that grants access to arbitrary rooms.

---

### Batch 15 — Admin, docs, hardening

- Admin: user management, moderation queue, verification review, venue CRUD, subscription and pricing management, analytics.
- RBAC enforced on every admin route.
- Audit log for every admin action — who did what to whom, when.
- Generated `openapi.yaml` covering every endpoint.
- Socket event reference document.
- Security pass: rate limits everywhere, input sanitisation, no PII in logs, S3 bucket policies, CORS.
- Load-test the deck endpoint.
- Deployment README.

**Confirm decision #12 first.**

---

## 8. Recurring traps

Check these at the end of every batch:

1. **Mode scoping.** Does every new query filter by mode where it should?
2. **Block enforcement.** Does the new endpoint use the shared exclusion clause?
3. **Timestamps.** UTC, ISO-8601, `Z`, `_at` suffix?
4. **Distance.** Metres in the API?
5. **Enums.** Strings, not integers?
6. **N+1.** Does the list endpoint return compact objects, or force follow-up calls?
7. **Quota vs rate limit.** 422 with paywall context, not 429?
8. **Privacy leaks.** 404 instead of 403 where a block is the reason?
9. **Reporter anonymity.** Can the reported user learn who reported them through any path?
10. **Envelope.** Even errors and empty lists?

---

## 9. First action

Do not write code yet.

Read this document fully, then reply with:

1. Your understanding of the mode system in your own words — this is the concept most likely to be misunderstood, and I want to check it before anything is built.
2. Anything in this spec that is contradictory, ambiguous, or that you would push back on.
3. Your answer to open decision #1 (the database question).
4. Your file plan for Batch 0.

Then stop and wait.
