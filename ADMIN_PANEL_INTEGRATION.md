# Kinvo Admin Panel — API Integration Brief

**Paste this whole file as your first message in a Claude Code session opened in the admin panel repo.** It is written to be acted on without further instruction.

You are integrating an existing React + Vite + TypeScript admin panel — which currently renders mock data — against a live REST API. The API is finished, deployed on AWS, and documented. Your job is to replace every mock with a real call, add authentication, and deploy the panel to Vercel.

**The backend is a separate repository and is not yours to change.** If you believe an endpoint is wrong or missing, say so in your final summary; do not work around it by inventing client-side logic that the server should own.

---

## 1. Read this before you write code

Three things must be true before the panel can talk to the API. **Verify each one yourself — do not assume.** If any fails, stop and report it; they are all fixed in the backend repo, not here.

### 1.1 Is the API reachable?

```bash
curl -s https://dm9o5kgscmnxv.cloudfront.net/health
```

Expect `{"success":true,"data":{"status":"ok",...},"meta":null}`.

### 1.2 Are the admin endpoints actually deployed?

**As of 7 Oct 2026 they were NOT.** The deployed build served 115 paths; the backend repo's `main` has 133. The 18 missing ones are most of what this panel needs — users, moderation queue, escalations, venues, subscription products, analytics. Only `/admin/me`, roles, guardrails and audit-log were live.

Check before you start:

```bash
curl -s https://dm9o5kgscmnxv.cloudfront.net/api/v1/docs/openapi.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const p=JSON.parse(s).paths;
      for (const k of ['/api/v1/admin/users','/api/v1/admin/analytics','/api/v1/admin/venues',
                       '/api/v1/admin/moderation/queue','/api/v1/admin/moderation/escalations',
                       '/api/v1/admin/subscription-products'])
        console.log((p[k]?'YES ':'NO  ')+k);
    })"
```

**Do not test endpoints by their HTTP status.** Every path under `/api/v1/admin/` returns `401` when unauthenticated — including paths that do not exist — because the auth middleware runs before route matching. A `401` tells you nothing about whether an endpoint is deployed. Use the OpenAPI document above, which is generated from the running code.

If they are missing, the backend owner must run `infra/deploy.sh` from the backend repo. Until then, build against a local backend (§1.5) or stop.

### 1.3 Will CORS allow your origin?

The API sets `Access-Control-Allow-Origin` from a `CORS_ORIGINS` environment variable, and **production refuses a `*` wildcard** — it is validated at boot. Your Vercel domain is almost certainly not in that list yet, so every browser call will fail CORS even though `curl` works.

```bash
curl -s -I -X OPTIONS https://dm9o5kgscmnxv.cloudfront.net/api/v1/admin/me \
  -H "Origin: https://your-panel.vercel.app" \
  -H "Access-Control-Request-Method: GET" | grep -i "access-control-allow-origin"
```

No header back means you are blocked. The backend owner must add your exact origin — scheme included, no trailing slash — to `CORS_ORIGINS` on the server and restart. Vercel preview deployments get their own per-commit subdomains, so either add the production domain only and test against that, or ask for the preview pattern to be added too.

`credentials: false` is set server-side. Do not send cookies; this API uses bearer tokens only.

### 1.4 Can you log in?

There is no admin account unless somebody made one. `User.role` defaults to `user`, and a `user` is refused by every admin endpoint — its granular role memberships are ignored entirely, deliberately, so that adding somebody to a role cannot become a privilege-escalation path.

Bootstrapping is a backend-repo task, run by somebody with database access:

```bash
# 1. Register the account normally through the API (hashes the password the
#    same way as any other account):
curl -X POST https://dm9o5kgscmnxv.cloudfront.net/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<a real password>","display_name":"Admin","date_of_birth":"1990-01-01"}'

# 2. Promote it (from the backend repo, against the production database):
npx tsx scripts/make-admin.ts admin@example.com
```

That script also seeds the roles and permission matrix, which is idempotent. `admin` holds every permission without consulting the matrix, so it can never be locked out.

### 1.5 Running a local backend instead

If the deployed build is stale and you cannot wait, clone the backend repo and run it:

```bash
npm install
cp .env.example .env     # defaults are fine for local; CORS_ORIGINS defaults to *
npm run db:up            # docker compose: postgres on 5433, redis on 6380
npm run db:deploy
npm run db:seed
npm run dev              # http://localhost:3000
```

Then `VITE_API_BASE_URL=http://localhost:3000/api/v1`. Create a local admin with the same `make-admin.ts` script.

---

## 2. The API contract

**Base URL:** `https://dm9o5kgscmnxv.cloudfront.net/api/v1`
**Swagger UI:** `https://dm9o5kgscmnxv.cloudfront.net/api/v1/docs`
**OpenAPI JSON:** `https://dm9o5kgscmnxv.cloudfront.net/api/v1/docs/openapi.json`

The OpenAPI document is generated from the running server's own route table and Zod schemas, so it cannot drift from behaviour. **Treat it as the authority over anything in this file.** If they disagree, the document is right and this file is stale — say so in your summary.

Consider generating types from it rather than hand-writing them:

```bash
npx openapi-typescript https://dm9o5kgscmnxv.cloudfront.net/api/v1/docs/openapi.json -o src/api/schema.d.ts
```

### 2.1 Every response uses one envelope

Single object:

```jsonc
{ "success": true, "data": { "...": "..." }, "meta": null }
```

List (cursor-paginated):

```jsonc
{ "success": true, "data": [ /* ... */ ],
  "meta": { "pagination": { "next_cursor": "eyJ...", "has_more": true, "limit": 20 } } }
```

Error:

```jsonc
{ "success": false,
  "error": { "code": "FORBIDDEN", "message": "Human-readable, safe to display.",
             "details": { "required_permission": "users.suspend" } } }
```

Rules that matter for your client layer:

- `data` is always an object or an array, never a bare scalar. A count comes back as `{ "count": 4 }`.
- A key is present with `null` rather than omitted. Empty lists are `[]`.
- `error.message` is written to be shown to the user. Display it instead of inventing your own copy.
- `error.code` is a stable machine contract. Branch on the code, never on the message text.
- `error.details` is always present, sometimes `null`.

Write **one** fetch wrapper that unwraps `data`, throws a typed error carrying `code`/`message`/`details`, and is the only thing in the codebase that knows about this envelope. No component should ever see `success`.

### 2.2 Authentication

`POST /auth/login` with `{ "email", "password" }` (optional `device_id`). Response `data`:

```jsonc
{ "access_token": "...", "refresh_token": "...", "token_type": "Bearer", "expires_in": 1800 }
```

Send `Authorization: Bearer <access_token>` on every admin call.

- **Access token lives 30 minutes. Refresh token lives 60 days and is rotated on every use** — the old one stops working, so you must store the new one from each refresh response.
- **A replayed refresh token revokes the whole family.** Never fire two refreshes concurrently. Serialise them behind a single in-flight promise, or a race will sign the user out.
- `POST /auth/refresh` with `{ "refresh_token" }` returns the same shape.
- `POST /auth/logout` with `{ "refresh_token" }`.
- Login is rate-limited to **10 attempts per 15 minutes per email address**, answering `429 RATE_LIMITED`. Do not retry automatically; show the message.

Three auth error codes mean different things and must be handled differently:

| Code | Meaning | Do |
| --- | --- | --- |
| `AUTH_REQUIRED` | No token sent | Redirect to login |
| `AUTH_TOKEN_EXPIRED` | Valid token, past its 30 minutes | Refresh once, retry the request |
| `AUTH_TOKEN_INVALID` | Malformed, or revoked | Clear storage, redirect to login — **do not refresh** |

Collapsing these into "log out" throws the user out every 30 minutes.

The server reloads the account on **every** request, so a suspension or a role change takes effect on the next call rather than when the token expires.

### 2.3 Permissions

`GET /admin/me` first, before rendering anything:

```jsonc
{ "id": "uuid", "role": "admin",
  "is_super_admin": true,
  "permissions": ["users.read", "users.suspend", "..."],
  "roles": [ { "id": "uuid", "key": "moderator", "title": "Moderator" } ] }
```

Use `permissions` to hide screens and disable buttons. **That is presentation only** — every endpoint checks for itself, and a client deciding its own permissions is worthless as security. When a call is refused you get `403 FORBIDDEN` with `details.required_permission` naming the missing key; surface that, it is the most useful possible message.

Permission keys: `users.read`, `users.suspend`, `users.role`, `moderation.read`, `moderation.resolve`, `verification.read`, `verification.review`, `venues.read`, `venues.write`, `subscriptions.read`, `subscriptions.write`, `analytics.read`, `audit.read`, `roles.read`, `roles.write`.

A `403` on an admin route is **not** a sign-out. It means this operator lacks that one permission.

**Read-only mode.** There is a guardrail (`admin.read_only`) an administrator can switch on. While it is on, every mutating admin endpoint answers `403` and only reads work. Check `GET /admin/guardrails` and show a visible banner, otherwise operators will think the panel is broken.

### 2.4 Pagination

Opaque base64 cursors. Send `?cursor=<next_cursor>&limit=20`. **Never construct, parse or inspect a cursor** — it is deliberately opaque and its contents will change.

Stop when `meta.pagination.has_more` is `false`. Do not stop on an empty page or a null cursor alone.

Admin review queues are ordered **oldest first**, unlike every other list in this API — a queue is work to get through, and newest-first strands whoever has waited longest. The one exception is escalations, which sorts by severity first.

---

## 3. Endpoints, mapped to the panel's screens

33 endpoints. Full request and response schemas are in the OpenAPI document; this is the map.

### Auth / shell

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/me` | Call first. Drives nav visibility. |
| `GET` | `/admin/guardrails` | Read-only-mode banner. |
| `PATCH` | `/admin/guardrails/{key}` | `{ "enabled": bool }`. Needs `roles.write`. |
| `GET` | `/admin/audit-log` | Filters: `actor_id`, `target_type`, `target_id`, `action`. Cursor. Needs `audit.read`. |

### User management

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/users/snapshot` | Dashboard tiles. Counted live, not cached. |
| `GET` | `/admin/users` | Filters: `search`, `status`, `tier`, `mode`, `flagged`, `staff`. Cursor. |
| `GET` | `/admin/users/{id}` | **Counts, not content.** |
| `GET` | `/admin/users/{id}/membership` | Subscription history. Read-only. |
| `GET` | `/admin/users/{id}/activity` | `?limit=`. Recorded events only. |
| `POST` | `/admin/users/{id}/suspend` | `{ "reason": "≥3 chars" }` — **required**. |
| `POST` | `/admin/users/{id}/reinstate` | No body. |
| `PATCH` | `/admin/users/{id}/role` | `{ "role": "user" \| "moderator" \| "admin" }`. Needs `users.role`. |

Each user row carries the panel's single `status` label **and** the honest fields it was derived from: `account_status`, `tier`, `is_flagged`, `is_verified`, `risk`. **Filter and act on the honest fields, not the label.** `tier` is resolved from subscription rows, never from a column anyone can edit.

`PATCH .../role` answers `409 CONFLICT` for three deliberate guards: you cannot change your own role, the last remaining administrator cannot be demoted, and demotion clears granular memberships. Show the `message`.

### Content moderation

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/moderation/queue` | Reports + flags merged; each row has `source: "report" \| "flag"`. Filters: `status`, `severity`, `assigned_to_id`, `unassigned`. Cursor. |
| `GET` | `/admin/moderation/escalations` | `?limit=`. High/Medium only, **severity-ordered**. Carries `description`. No cursor. |
| `GET` | `/admin/moderation/insights` | Queue health, 12-week load, categories, owners. |
| `PATCH` | `/admin/moderation/flags/{id}/assignee` | `{ "assignee_id": "uuid" \| null }`. `null` releases. |

**The queue list does not include a report's `description`; escalations does.** That is intentional, not an omission: a thirty-row list does not need thirty paragraphs, and the detail belongs on the case view.

**No endpoint returns a message anybody sent.** If a screen needs to show the reported conversation, that endpoint does not exist and will not be added casually — it needs a justification field and its own audit trail. Report the need; do not fake it.

Severity is three values (`High`/`Medium`/`Low`) collapsed from the server's five. `critical` folds **upward** into `High`.

**Resolving** a report or flag is **not** on these endpoints. Use the pre-existing `/reports/review`, `/moderation/flags` and `/verification/review` (also `Admin`-tagged in the OpenAPI document). They run the second-review check, badge recomputation, audit entry and notification. A second review answers `409` rather than overwriting — two moderators opening the same queue is normal, so handle it as a refresh-and-inform, not an error toast.

### Date suggestions (venues)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/venues` | Filters: `search`, `category`, `featured`, `reviewed`, `active`. Cursor. |
| `POST` | `/admin/venues` | **`longitude` and `latitude` are required**, as is a non-empty `modes` array. |
| `PATCH` | `/admin/venues/{id}` | Editorial fields + `is_featured`, `is_reviewed`, `is_active`. |

Rows carry a two-value `status` plus the three real booleans. Featuring an unreviewed venue answers `409` — review first.

Coordinates are `(longitude, latitude)`, both required, because every venue lookup is a radius query and one without a location can never be shown.

**Location is not editable** via `PATCH`, and there is **no delete** — use `is_active: false`. A hard delete would blank out meetup plans that reference the venue.

Categories: `cafe`, `restaurant`, `park`, `gym`, `study_spot`, `pet_friendly`, `romantic`, `health_conscious`. Modes: `dating`, `study_buddy`, `networking`, `trading`, `foodie`, `cuddle`, `pet_dates`, `fitness`.

### Subscription management

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/subscription-products` | Products with open price, subscriber count, MRR. |
| `PATCH` | `/admin/subscription-products/{id}` | `name`, `rollout_state`, `rollout_note`, `is_active`, `sort_order`. |
| `GET` | `/admin/subscription-products/{id}/prices` | Full version history, newest first. |
| `POST` | `/admin/subscription-products/{id}/prices` | `{ "amount_minor": int, "currency": "GBP", "note"? }`. **201.** |

**This is a catalogue editor, not a billing system.** Nothing here charges anybody or grants anybody access — payment handling is not in this codebase at all. Do not build UI implying otherwise: no refunds, no manual grants, no "give this user premium".

- **Money is integer minor units plus a currency code.** `1999` + `"GBP"` is £19.99. Never send a float — the server rejects it. Format for display only, at the edge.
- A price change **creates a new version** (hence `POST`/201), it never edits one. Re-sending the identical amount answers `409`. Surface the history; it is what grandfathering and disputed charges are answered from.
- `tier` and `billing_cycle` are **not editable** by design. Don't put them in the form.
- `rollout_state` (`live`/`promo`/`draft`/`grandfathered`) is editorial and **separate from `is_active`**, which controls whether the mobile app sees the product.

### Analytics

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/analytics` | All four tabs in one response. |

Shape: `{ generated_at, engagement, weeklyResolution, subscriptionMix, revenuePulse, churnByBilling, modePerformance, acquisitionChannels }`, each series being `{ basis: string, points: [...] }`.

**Render every `basis` string in the UI, next to its chart.** It is not debug text — it states what the numbers actually count, and two of them do not mean what their labels suggest:

- `engagement` counts the **account base at each month end**, not monthly active users. Real MAU is not recoverable: `last_active_at` is overwritten on every visit and keeps no history. Do not label this "active users" without the caveat visible.
- `acquisitionChannels` reports **sign-in method** (Google/Apple/Phone/Email), **not marketing attribution**. No referral or campaign source is recorded anywhere in the system. Do not label it "channels" or "referrals" — somebody will spend money against it.

Also: `revenuePulse` money entries carry authoritative `amount_minor` + `currency` alongside a display `value` string — read the integer. MRR normalises yearly prices to a month and is **not** what was billed. Churn is a lifetime rate, not monthly.

Nothing is cached, so this endpoint is slower than the rest. Show a skeleton; do not poll it.

---

## 4. What to build

Work in this order. Commit after each step with a message describing the behaviour, not the files.

1. **API client layer.** One module: base URL from `import.meta.env.VITE_API_BASE_URL`, envelope unwrapping, a typed `ApiError` carrying `code`/`message`/`details`, bearer header injection, and single-flight token refresh on `AUTH_TOKEN_EXPIRED`. Nothing else in the app touches `fetch`.
2. **Auth.** Login screen against `POST /auth/login`, token storage, `GET /admin/me` on boot, a route guard, and sign-out. Handle the three auth codes distinctly per §2.2.
3. **Replace the mocks, one feature at a time.** The repo has mock data modules per feature (look for `*.mock.ts` and the hooks that consume them). Keep each feature's existing hook signature where you can and swap its body for a real call, so components need minimal change. Use TanStack Query if it is already a dependency; if not, ask before adding it.
4. **Permission gating.** Hide nav items and disable actions from `/admin/me`. Render `details.required_permission` when a `403` arrives anyway.
5. **Read-only banner** from `/admin/guardrails`.
6. **Deploy to Vercel** (§5).

**Keep the existing design.** The panel's look, layout and component structure are done; you are wiring data into it, not redesigning it. Where a real field has no mock equivalent — `basis` strings, `required_permission`, the honest `account_status`/`tier`/`is_flagged` alongside the collapsed label — add it in keeping with what is there.

**Where the API genuinely cannot fill a mock, delete the mock rather than faking it.** Mock data had numbers that no endpoint can produce (an acquisition-channel breakdown, an "upsell conversion" rate). A plausible invented figure on a dashboard is worse than a blank one, because somebody will act on it.

---

## 5. Vercel deployment

Vite + React, so it is a static build. Nothing server-side is needed and no secret belongs here — **the admin API is protected by the operator's own login, not by a key in this bundle.** Anything in `VITE_*` ships to the browser in plain text.

1. Push the repo to GitHub.
2. Import it on Vercel. Framework preset: **Vite**. Build `npm run build`, output `dist`.
3. Environment variable, for Production, Preview and Development:
   `VITE_API_BASE_URL = https://dm9o5kgscmnxv.cloudfront.net/api/v1`
4. Add an SPA rewrite so deep links do not 404 on refresh — `vercel.json` at the repo root:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

5. Deploy, then **give the backend owner your exact production origin** so it can be added to `CORS_ORIGINS` (§1.3). Until that happens the deployed panel cannot call the API, even though local development against a local backend works.
6. Verify in a real browser: log in, load each screen, confirm no CORS errors in the console. `curl` passing does not mean the browser will.

This panel can read every user's details and change who has access. Put Vercel password protection or an access policy on it, and do not leave a preview deployment publicly reachable.

---

## 6. Gotchas that will cost you hours

- **`401` on an admin path proves nothing.** Auth middleware runs before route matching, so even nonexistent `/admin/*` paths return `401`. Use the OpenAPI document to check existence.
- **Concurrent refreshes sign the user out.** Refresh tokens rotate; a replayed one revokes the whole family by design. Single-flight it.
- **`403` ≠ logged out.** It means one missing permission.
- **Distances are metres.** Format at the edge.
- **Timestamps are UTC ISO-8601 with `Z`**, and every such field ends in `_at`. Convert for display only.
- **Enums are lowercase snake_case strings**, never integers.
- **Money is integer minor units + currency.** Never a float.
- **Don't parse cursors.**
- **A missing key is a bug; `null` is an answer.** Every key is present.
- **Quota vs rate limit.** `429 RATE_LIMITED` is infrastructure — back off. `422 QUOTA_EXCEEDED` is a business limit with paywall context. Different handling. (Mostly a mobile concern, but the codes are shared.)
- **Admin lists may use offset pagination** where cursors are not needed; check each endpoint's parameters in the document rather than assuming.

---

## 7. Done means

- `npm run build` and `npm run lint` clean, and the TypeScript build has no errors.
- No `*.mock.ts` import remains in any component or hook.
- Login, refresh and sign-out work against the deployed API.
- Every screen loads real data, with loading and error states that show `error.message`.
- Nav and actions reflect `/admin/me`; a `403` shows which permission was missing.
- Read-only mode shows a banner and mutating controls are disabled.
- Deployed to Vercel, opening in a browser with no CORS errors, with access protection on.
- Your final summary states: which screens are fully live, anything the API could not supply and what you did instead, and any endpoint you believe is wrong or missing.

Report honestly. If something is half-wired, say which half — an overstated summary is worse than an incomplete one, because the next person will trust it.
