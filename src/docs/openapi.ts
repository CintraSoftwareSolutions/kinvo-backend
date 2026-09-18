import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { API_PREFIX } from '@config/constants';
import { ERROR_CODES, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@utils/error-codes';
import * as authSchema from '@modules/auth/auth.schema';
import * as mediaSchema from '@modules/media/media.schema';
import * as modesSchema from '@modules/modes/modes.schema';
import { swipeBodySchema } from '@modules/discovery/discovery.schema';
import { sendMessageSchema, updateConversationSchema } from '@modules/chat/chat.schema';
import { checkContentSchema, resolveFlagSchema } from '@modules/moderation/moderation.schema';
import {
  registerPushTokenSchema,
  updatePreferenceSchema,
} from '@modules/notifications/notifications.schema';
import {
  blockSchema,
  createContactSchema,
  createReportSchema,
  emergencySchema,
  pingSchema,
  resolveReportSchema,
  startSharingSchema,
} from '@modules/safety/safety.schema';
import {
  cancelSchema,
  createPlanSchema,
  respondSchema,
  sharePlanSchema,
  updatePlanSchema,
} from '@modules/plans/plans.schema';
import { safetyActionSchema, startCallSchema } from '@modules/calls/calls.schema';
import * as settingsSchema from '@modules/settings/settings.schema';
import * as usersSchema from '@modules/users/users.schema';

/**
 * The OpenAPI 3.1 description of this API (spec §7, Batch 15 — brought forward
 * because the mobile team needs the contract now).
 *
 * Request bodies are generated from the SAME Zod schemas the endpoints validate
 * with, so documentation cannot drift from behaviour. If a field is renamed in
 * a schema, it is renamed here automatically. Hand-written request examples
 * would be wrong within a week.
 *
 * What is hand-written is the prose: summaries, auth requirements, and which
 * error codes an endpoint can return. Those live in ROUTES below, and
 * tests/integration/docs.test.ts fails if a route exists without an entry.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteDoc {
  method: Method;
  /** Path after /api/v1, with :params in Express form. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** Zod schema for the request body, if any. */
  body?: ZodTypeAny;
  /** True when the endpoint needs an access token. */
  auth: boolean;
  /** Error codes this endpoint can realistically return, beyond the universal ones. */
  errors: ErrorCode[];
}

const E = ERROR_CODES;

export const ROUTES: RouteDoc[] = [
  // --- meta ---------------------------------------------------------------
  {
    method: 'get',
    path: '/health',
    tag: 'Meta',
    summary: 'Liveness probe',
    description:
      'Checks no dependency on purpose. A liveness probe that fails when the database blips makes the orchestrator kill healthy processes.',
    auth: false,
    errors: [],
  },
  {
    method: 'get',
    path: '/health/ready',
    tag: 'Meta',
    summary: 'Readiness probe',
    description: 'Reports whether Postgres and Redis are reachable.',
    auth: false,
    errors: [E.SERVICE_UNAVAILABLE],
  },
  {
    method: 'get',
    path: '/config',
    tag: 'Meta',
    summary: 'Enum catalogues and feature flags',
    description:
      'Mode list with the label each mode renders for its deck action, interest tags, prompt questions, and report reasons. Fetch on launch and cache. Adding a mode or an interest ships through here, never through an app release.',
    auth: false,
    errors: [],
  },

  // --- auth ---------------------------------------------------------------
  {
    method: 'post',
    path: '/auth/register',
    tag: 'Auth',
    summary: 'Create an account with email and password',
    description:
      'Rejects under-18 from the date of birth. Returns 409 if the address already exists — including when it was created by Google or Apple sign-in, in which case use forgot-password to set a password rather than registering.',
    body: authSchema.registerSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.CONFLICT, E.RATE_LIMITED],
  },
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Auth',
    summary: 'Sign in',
    description:
      'An unknown email and a wrong password return an identical response, deliberately — anything else lets an attacker enumerate registered addresses.',
    body: authSchema.loginSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.AUTH_INVALID_CREDENTIALS, E.ACCOUNT_SUSPENDED, E.RATE_LIMITED],
  },
  {
    method: 'post',
    path: '/auth/refresh',
    tag: 'Auth',
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Refresh tokens ROTATE. Store the new one every time. Presenting a token that has already been rotated is treated as theft and revokes every token in that family, signing that device out.',
    body: authSchema.refreshSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.AUTH_TOKEN_EXPIRED, E.AUTH_TOKEN_INVALID, E.RATE_LIMITED],
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'Auth',
    summary: 'Sign out this device',
    description:
      'Revokes the presented token family only, so other devices stay signed in. Always succeeds, even for an unknown token.',
    body: authSchema.logoutSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/auth/forgot-password',
    tag: 'Auth',
    summary: 'Request a password reset code',
    description:
      'Emails a six-digit code, single use, valid for an hour. Requesting a new code retires the previous one. The response is identical whether or not the address is registered, so it cannot be used to find out which addresses have accounts. An environment with no mail transport — local, test, and staging under the integration waiver — returns the code as reset_code instead, so the flow stays testable there; production refuses to boot without a transport, so it never does.',
    body: authSchema.forgotPasswordSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.RATE_LIMITED],
  },
  {
    method: 'post',
    path: '/auth/reset-password',
    tag: 'Auth',
    summary: 'Redeem a reset code',
    description:
      'Takes the address the code was sent to along with the code itself. Single use, one-hour expiry, and the code is destroyed after a handful of wrong guesses. Every way of failing — wrong, expired, already used, out of attempts, unknown address — answers AUTH_TOKEN_INVALID with one message. Revokes every existing session on success, so the app signs in again with the new password.',
    body: authSchema.resetPasswordSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.AUTH_TOKEN_INVALID, E.RATE_LIMITED],
  },
  {
    method: 'post',
    path: '/auth/change-password',
    tag: 'Auth',
    summary: 'Change password while signed in',
    description: 'Requires the current password. Revokes every session on success.',
    body: authSchema.changePasswordSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.AUTH_INVALID_CREDENTIALS, E.BAD_REQUEST],
  },
  {
    method: 'post',
    path: '/auth/otp/send',
    tag: 'Auth',
    summary: 'Send a one-time code by SMS',
    description:
      'NOT YET AVAILABLE on staging — returns SERVICE_UNAVAILABLE until Twilio is configured. The response never reveals whether a number is registered.',
    body: authSchema.sendOtpSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.RATE_LIMITED, E.SERVICE_UNAVAILABLE],
  },
  {
    method: 'post',
    path: '/auth/otp/verify',
    tag: 'Auth',
    summary: 'Verify a one-time code and sign in',
    description:
      'NOT YET AVAILABLE on staging. A number with no account creates a pending one, which cannot use discovery or chat until onboarding supplies a date of birth.',
    body: authSchema.verifyOtpSchema,
    auth: false,
    errors: [
      E.VALIDATION_FAILED,
      E.AUTH_INVALID_CREDENTIALS,
      E.RATE_LIMITED,
      E.SERVICE_UNAVAILABLE,
    ],
  },
  {
    method: 'post',
    path: '/auth/google',
    tag: 'Auth',
    summary: 'Sign in with Google',
    description:
      'NOT YET AVAILABLE on staging. Send the ID token from the Google SDK. A verified email matching an existing account links to it rather than creating a duplicate.',
    body: authSchema.googleSignInSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.AUTH_TOKEN_INVALID, E.RATE_LIMITED, E.SERVICE_UNAVAILABLE],
  },
  {
    method: 'post',
    path: '/auth/apple',
    tag: 'Auth',
    summary: 'Sign in with Apple',
    description:
      'NOT YET AVAILABLE on staging. Apple sends the display name only on the FIRST authorisation and never again — capture it then and pass it as display_name, or the account has no name.',
    body: authSchema.appleSignInSchema,
    auth: false,
    errors: [E.VALIDATION_FAILED, E.AUTH_TOKEN_INVALID, E.RATE_LIMITED, E.SERVICE_UNAVAILABLE],
  },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'Auth',
    summary: 'The signed-in account',
    description: 'Account state and linked identities. Profile content is on /users/me.',
    auth: true,
    errors: [E.ACCOUNT_SUSPENDED],
  },

  // --- onboarding ---------------------------------------------------------
  {
    method: 'get',
    path: '/onboarding',
    tag: 'Onboarding',
    summary: 'Progress and what is still missing',
    description:
      'Returns each step with is_complete, plus a `missing` array. Drive the onboarding screens from this rather than tracking state client-side.',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/onboarding/complete',
    tag: 'Onboarding',
    summary: 'Finish onboarding',
    description:
      'Moves the account from pending to active. Fails with ONBOARDING_INCOMPLETE and a `missing` list until every requirement is met. Idempotent.',
    auth: true,
    errors: [E.ONBOARDING_INCOMPLETE, E.VALIDATION_FAILED, E.ACCOUNT_SUSPENDED],
  },
  {
    method: 'post',
    path: '/onboarding/date-of-birth',
    tag: 'Onboarding',
    summary: 'Set date of birth',
    description:
      'For accounts created by Google, Apple or phone, which arrive without one. Applies the under-18 check. Refuses to change a date that is already set.',
    body: usersSchema.setDateOfBirthSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.CONFLICT],
  },

  // --- profile ------------------------------------------------------------
  {
    method: 'get',
    path: '/users/me',
    tag: 'Profile',
    summary: 'Own full profile',
    auth: true,
    errors: [],
  },
  {
    method: 'patch',
    path: '/users/me',
    tag: 'Profile',
    summary: 'Update profile fields',
    description:
      'Omit a field to leave it unchanged; send null to clear it. Those are different, so do not send nulls for untouched fields.',
    body: usersSchema.updateProfileSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/users/me/location',
    tag: 'Profile',
    summary: 'Set location',
    description: 'Longitude and latitude, in that order. Stored as a PostGIS point.',
    body: usersSchema.updateLocationSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'put',
    path: '/users/me/interests',
    tag: 'Profile',
    summary: 'Replace the interest set',
    description: 'Send the complete list. Slugs come from /config.',
    body: usersSchema.setInterestsSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'put',
    path: '/users/me/prompts',
    tag: 'Profile',
    summary: 'Replace prompt answers',
    description: 'Send the complete list. Slugs come from /config.',
    body: usersSchema.setPromptsSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/users/me/preview',
    tag: 'Profile',
    summary: 'How others see you',
    description:
      'The caller rendered through the exact public projection, so the preview cannot drift from what a stranger actually receives.',
    auth: true,
    errors: [],
  },
  {
    method: 'delete',
    path: '/users/me',
    tag: 'Profile',
    summary: 'Delete the account',
    description: 'Soft delete. Revokes every session and removes the user from every listing.',
    auth: true,
    errors: [],
  },
  {
    method: 'get',
    path: '/users/{id}',
    tag: 'Profile',
    summary: "Another user's public profile",
    description:
      'Returns 404 — never 403 — when the viewer is blocked, the account is suspended or deleted, or the id never existed. All four are deliberately indistinguishable.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },

  // --- media --------------------------------------------------------------
  {
    method: 'post',
    path: '/media/uploads',
    tag: 'Media',
    summary: 'Request an upload URL',
    description:
      'Step 1 of 2. Returns a presigned URL plus the headers you MUST send. PUT the bytes straight to that URL — they never pass through this API — then call the complete endpoint.',
    body: mediaSchema.createUploadSchema,
    auth: true,
    errors: [
      E.VALIDATION_FAILED,
      E.UNSUPPORTED_MEDIA_TYPE,
      E.FILE_TOO_LARGE,
      E.SERVICE_UNAVAILABLE,
    ],
  },
  {
    method: 'post',
    path: '/media/uploads/{id}/complete',
    tag: 'Media',
    summary: 'Confirm an upload',
    description:
      'Step 2 of 2. The server asks storage what actually arrived and records that, not what was declared. An upload that is never completed can never be attached to anything.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.BAD_REQUEST, E.NOT_FOUND],
  },
  {
    method: 'get',
    path: '/media/uploads/{id}/url',
    tag: 'Media',
    summary: 'Get a viewable URL for your own upload',
    description: 'Time-limited. Both buckets are private, so URLs are minted per request.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  {
    method: 'delete',
    path: '/media/uploads/{id}',
    tag: 'Media',
    summary: 'Delete an upload',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  {
    method: 'get',
    path: '/media/photos',
    tag: 'Media',
    summary: 'List profile photos',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/media/photos',
    tag: 'Media',
    summary: 'Attach a completed upload as a photo',
    description: 'Maximum six. The first becomes primary automatically.',
    body: mediaSchema.addPhotoSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.CONFLICT, E.NOT_FOUND, E.BAD_REQUEST],
  },
  {
    method: 'patch',
    path: '/media/photos/reorder',
    tag: 'Media',
    summary: 'Reorder photos',
    description: 'Send every photo id exactly once, in the order you want. First becomes primary.',
    body: mediaSchema.reorderPhotosSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/media/photos/{id}/primary',
    tag: 'Media',
    summary: 'Set the primary photo',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  {
    method: 'delete',
    path: '/media/photos/{id}',
    tag: 'Media',
    summary: 'Delete a photo',
    description: 'Remaining photos close the gap in the ordering.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },

  // --- verification -------------------------------------------------------
  {
    method: 'get',
    path: '/verification',
    tag: 'Verification',
    summary: 'Verification status',
    description: 'Wizard position and whether the badge is earned.',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/verification',
    tag: 'Verification',
    summary: 'Start verification',
    description: 'Step 1 of 3. One attempt at a time.',
    body: mediaSchema.startVerificationSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.CONFLICT],
  },
  {
    method: 'post',
    path: '/verification/{id}/document',
    tag: 'Verification',
    summary: 'Attach the document',
    description:
      'Step 2 of 3. The upload must have purpose verification_document — those go to a separate, stricter bucket and a profile photo cannot be submitted as an ID.',
    body: mediaSchema.attachDocumentSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.CONFLICT, E.NOT_FOUND, E.BAD_REQUEST],
  },
  {
    method: 'post',
    path: '/verification/{id}/submit',
    tag: 'Verification',
    summary: 'Submit for review',
    description: 'Step 3 of 3.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.CONFLICT, E.NOT_FOUND, E.BAD_REQUEST],
  },
  // --- discovery ----------------------------------------------------------
  {
    method: 'get',
    path: '/discovery/{mode}/deck',
    tag: 'Discovery',
    summary: 'Today’s deck for one mode',
    description:
      'Cursor-paginated cards, precomputed once per user per mode per UTC day so the order is stable while scrolling. `distance_metres` is metres — format to miles on the client. Cards already swiped never reappear. Returns 400 if the mode is switched off or the account has no location.',
    auth: true,
    errors: [E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/discovery/{mode}/swipe',
    tag: 'Discovery',
    summary: 'Pass, like, or super like',
    description:
      'The three actions are identical in every mode — only the label the app renders changes, and that comes from GET /config. Responds with `is_match` and the match when the target had already liked you IN THIS MODE. Likes and super likes spend daily quota; a pass is free. A second swipe on the same person in the same mode is 409.',
    body: swipeBodySchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND, E.CONFLICT, E.QUOTA_EXCEEDED],
  },
  {
    method: 'post',
    path: '/discovery/{mode}/rewind',
    tag: 'Discovery',
    summary: 'Undo the last swipe in this mode',
    description:
      'Restores the profile to the deck and refunds the quota it spent. If that swipe had created a match, the match is removed too. Premium.',
    auth: true,
    errors: [E.PREMIUM_REQUIRED, E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/discovery/{mode}/likes-you',
    tag: 'Discovery',
    summary: 'Who liked you, in this mode',
    description:
      'The Requests tab: profiles, not messages. People you have already answered — matched or passed — are excluded. Premium.',
    auth: true,
    errors: [E.PREMIUM_REQUIRED, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/discovery/{mode}/boost',
    tag: 'Discovery',
    summary: 'Raise your ranking for a window',
    description:
      'Ranking only. A boost moves you up decks you already qualified for and can never place you into one a filter excluded you from. 409 while a boost is already running. Premium.',
    auth: true,
    errors: [E.PREMIUM_REQUIRED, E.CONFLICT, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/discovery/{mode}/stats',
    tag: 'Discovery',
    summary: 'Counters for the empty state',
    description:
      'Everything the end-of-deck screen needs in one call: swipe counts, active matches, how many people are waiting in likes-you, cards left today, any running boost, and what is left of the daily allowance. `likes_received` is a count only — the profiles stay behind the paywall.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  // --- matches ------------------------------------------------------------
  {
    method: 'get',
    path: '/matches',
    tag: 'Matches',
    summary: 'The Matches tab',
    description:
      'Cursor-paginated, newest first, with the conversation id, unread count, and last message preview on each row so the list renders in one request. `?archived=true` is the Archived tab. **The Requests tab is a different endpoint** — `GET /discovery/{mode}/likes-you` — because Requests holds profiles who liked you, not conversations. `is_writable` is false when the pair is blocked, the match expired, or it was unmatched: hide the composer on it rather than discovering the state from a rejected send.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/matches/{id}',
    tag: 'Matches',
    summary: 'One match',
    description:
      'Answers 404 for a match that is not yours, was unmatched, or never existed — all three identically.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'delete',
    path: '/matches/{id}',
    tag: 'Matches',
    summary: 'Unmatch',
    description:
      'Final and symmetric: the match disappears for both people at once. The swipes stay, so neither is offered the other again in this mode. Who unmatched is recorded for later report investigations and is never exposed to the other person.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/matches/{id}/extend',
    tag: 'Matches',
    summary: 'Push back the expiry',
    description:
      'Extends from the current expiry rather than from now, so extending a match with days left adds the window instead of shortening it. An already-expired match becomes live again. Premium.',
    auth: true,
    errors: [E.PREMIUM_REQUIRED, E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  // --- chat ---------------------------------------------------------------
  {
    method: 'get',
    path: '/conversations',
    tag: 'Chat',
    summary: 'Conversation list',
    description:
      'Ordered by activity, not creation. Carries the other participant, unread count, and last message preview so the list needs no follow-up calls. There is no endpoint that creates a conversation: one is created with its match, and users cannot message before matching.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/conversations/unread-count',
    tag: 'Chat',
    summary: 'Total unread, for the app badge',
    auth: true,
    errors: [],
  },
  {
    method: 'get',
    path: '/conversations/{id}',
    tag: 'Chat',
    summary: 'One conversation',
    description:
      'The chat header. `mode` is inherited from the match and never changes. `is_writable` false means the composer should be hidden.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/conversations/{id}',
    tag: 'Chat',
    summary: 'Archive or mute',
    description:
      'Per user, not shared — archiving does not archive it for the other person. A new message pulls the thread back out of the archive.',
    body: updateConversationSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/conversations/{id}/messages',
    tag: 'Chat',
    summary: 'Message history, newest first',
    description:
      '**This list paginates BACKWARDS**, unlike every other list in this API: the first page is the most recent messages and the cursor walks into the past, because a chat opens at the bottom. A blocked pair keeps its history readable; only sending is refused.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/conversations/{id}/messages',
    tag: 'Chat',
    summary: 'Send a message',
    description:
      'Types: text, image, video, voice_note, venue_card. Media types need a `media_asset_id` from a completed upload that you own and that was uploaded as the matching kind. Voice notes carry `duration_ms`. Spends daily message quota, refunded if the write fails. Answers 403 with an identical message for every closed-conversation reason — blocked, expired, unmatched — so a block cannot be confirmed by elimination.',
    body: sendMessageSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.FORBIDDEN, E.NOT_FOUND, E.QUOTA_EXCEEDED],
  },
  {
    method: 'post',
    path: '/conversations/{id}/read',
    tag: 'Chat',
    summary: 'Mark read',
    description:
      'Clears your unread badge and stamps `read_at` on the other person’s messages so their ticks update. Never stamps your own.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  // --- moderation ---------------------------------------------------------
  {
    method: 'post',
    path: '/moderation/check',
    tag: 'Moderation',
    summary: 'Check content before sending',
    description:
      '**Advisory, never blocking.** `can_send` is always true, at every severity — show "Edit message" / "Send anyway" from `should_warn` and let the user decide. Send `overridden: true` when they push past a warning; that record is what the moderation team needs later. Content is hashed, never stored. If the provider is unreachable the call still succeeds with `timed_out: true` and severity `none`: a third-party outage must never cost a user their message. Scam and payment checks run on every mode, not just dating.',
    body: checkContentSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/moderation/flags',
    tag: 'Moderation',
    summary: 'The moderation queue',
    description:
      'System-raised flags, distinct from user reports. Moderator or admin only — answers 403, not 404, because an admin surface is documented and there is nothing to conceal about its existence.',
    auth: true,
    errors: [E.FORBIDDEN, E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/moderation/flags/{id}',
    tag: 'Moderation',
    summary: 'Resolve a flag',
    description:
      'Moves a flag to under_review, actioned, or dismissed, and records the moderator. Moderator or admin only.',
    body: resolveFlagSchema,
    auth: true,
    errors: [E.FORBIDDEN, E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  // --- notifications ------------------------------------------------------
  {
    method: 'get',
    path: '/notifications',
    tag: 'Notifications',
    summary: 'The notification feed',
    description:
      'Every notification is persisted here AND pushed — never pushed alone. A push banner is gone once dismissed, so this feed is the only place a notification can still be found afterwards. Cursor-paginated, newest first. `?unread_only=true` filters.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/notifications/unread-count',
    tag: 'Notifications',
    summary: 'Unread notification count',
    auth: true,
    errors: [],
  },
  {
    method: 'get',
    path: '/notifications/badges',
    tag: 'Notifications',
    summary: 'Badge counts for all five tabs',
    description:
      'Discover, Requests, Matches, Plans, Notifications, plus a total. Poll this on app resume rather than calling five endpoints. `total` deliberately EXCLUDES `discover` — cards waiting is not something the user is behind on, and counting it would make the app badge permanently non-zero.',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/notifications/read-all',
    tag: 'Notifications',
    summary: 'Mark everything read',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/notifications/{id}/read',
    tag: 'Notifications',
    summary: 'Mark one read',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/notifications/preferences',
    tag: 'Notifications',
    summary: 'Per-category delivery preferences',
    description:
      'All eight categories, with defaults filled in for any the user has never changed — so the settings screen renders from one call and never has to know what the defaults are.',
    auth: true,
    errors: [],
  },
  {
    method: 'patch',
    path: '/notifications/preferences/{category}',
    tag: 'Notifications',
    summary: 'Change a category',
    description:
      '**Safety notifications cannot be muted** for push or in-app: they carry emergency and moderation outcomes, and someone missing the result of a report they filed is the failure this product cannot have. Their email channel can still be switched off.',
    body: updatePreferenceSchema,
    auth: true,
    errors: [E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/notifications/tokens',
    tag: 'Notifications',
    summary: 'Register an FCM token',
    description:
      'The token belongs to a DEVICE, not a user — one person may have several, each with its own token. The device must already be signed in. Re-registering a token that was on another device moves it, because FCM issues one token per install.',
    body: registerPushTokenSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'delete',
    path: '/notifications/tokens/{device_id}',
    tag: 'Notifications',
    summary: 'Stop pushing to a device',
    description:
      'Clears the token WITHOUT ending the session. Revoking a device is the security action and lives at DELETE /devices/{id}.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  // --- safety -------------------------------------------------------------
  {
    method: 'post',
    path: '/reports',
    tag: 'Safety',
    summary: 'Report a user',
    description:
      '**Reports are anonymous.** The reported user never learns who filed one, through any endpoint, notification, or error message. `also_block: true` blocks in the SAME transaction — a report filed without its block would leave someone still exposed to the person they just reported. Evidence must be completed uploads of kind `report_evidence`; a verification document cannot be attached.',
    body: createReportSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  {
    method: 'get',
    path: '/reports',
    tag: 'Safety',
    summary: 'Reports you filed',
    description:
      'Only reports YOU submitted. There is deliberately no endpoint for reports about you — even a count would tell someone they are under review.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/reports/review',
    tag: 'Safety',
    summary: 'The moderation queue',
    description:
      'The ONLY place a reporter identity is returned — moderators need it to spot coordinated reporting and retaliation. Moderator or admin only.',
    auth: true,
    errors: [E.FORBIDDEN, E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/reports/{id}',
    tag: 'Safety',
    summary: 'Resolve a report',
    body: resolveReportSchema,
    auth: true,
    errors: [E.FORBIDDEN, E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/blocks',
    tag: 'Safety',
    summary: 'People you blocked',
    description:
      'Only blocks YOU created. Listing who blocked you would tell you exactly that, which is what the 404-not-403 rule exists to prevent.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/blocks',
    tag: 'Safety',
    summary: 'Block someone',
    description:
      'Idempotent. Also unmatches an active match: a block alone would leave it visible and frozen, which is right for a lapsed match and wrong for one deliberately cut.',
    body: blockSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  {
    method: 'delete',
    path: '/blocks/{user_id}',
    tag: 'Safety',
    summary: 'Unblock',
    description:
      'Does NOT restore the match it severed. Unblocking means "I will see them again", not "undo everything" — the pair can simply match again.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/safety/contacts',
    tag: 'Safety',
    summary: 'Trusted contacts',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/safety/contacts',
    tag: 'Safety',
    summary: 'Add a trusted contact',
    description:
      'Needs a phone or an email — a contact with no way to reach them is decoration, and the moment it matters is the moment nobody checks. Maximum five.',
    body: createContactSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.BAD_REQUEST],
  },
  {
    method: 'patch',
    path: '/safety/contacts/{id}',
    tag: 'Safety',
    summary: 'Edit a trusted contact',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'delete',
    path: '/safety/contacts/{id}',
    tag: 'Safety',
    summary: 'Remove a trusted contact',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/safety/location',
    tag: 'Safety',
    summary: 'Start sharing live location',
    description:
      '**High-risk data.** Sharing never starts implicitly, every session carries a hard expiry set at creation, and starting again ends the previous one. Ending a session DESTROYS the position trail — the session row survives as the record that sharing happened, the movements do not. Maximum 8 hours.',
    body: startSharingSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  {
    method: 'get',
    path: '/safety/location/active',
    tag: 'Safety',
    summary: 'Your active sharing session',
    auth: true,
    errors: [],
  },
  {
    method: 'delete',
    path: '/safety/location/{id}',
    tag: 'Safety',
    summary: 'Stop sharing',
    description: 'Deletes the position trail. Stopping that leaves a history is not stopping.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/safety/location/{id}/ping',
    tag: 'Safety',
    summary: 'Record a position',
    description:
      'Refused on an expired session rather than extending it — the TTL is the consent boundary, and a client that keeps sending must not push it outward.',
    body: pingSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/safety/location/{id}/trail',
    tag: 'Safety',
    summary: 'Your own trail',
    description:
      'Readable only by the person sharing. Trusted contacts are told sharing started; they get no endpoint returning coordinates, because a shareable link to a live position is exactly what this design avoids.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/safety/emergency',
    tag: 'Safety',
    summary: 'Raise an emergency',
    description:
      'Records the event, attaches a position if given, and alerts trusted contacts. Succeeds even with no contacts configured and says so — someone pressing this is having the worst moment this app will be part of, and an error is not an acceptable outcome.',
    body: emergencySchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/safety/emergency',
    tag: 'Safety',
    summary: 'Your emergency history',
    auth: true,
    errors: [],
  },
  // --- plans --------------------------------------------------------------
  {
    method: 'get',
    path: '/plans',
    tag: 'Plans',
    summary: 'Your plans',
    description:
      'Three tabs via `?tab=upcoming|pending|history`, plus `?drafts=true`. Drafts are separate from pending on purpose: pending waits on the other person, a draft waits on you. A proposal whose time passed unanswered is history: it can no longer be accepted. Each plan carries `user`, the other person. Plans with an account that was deleted or suspended are not listed.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/plans',
    tag: 'Plans',
    summary: 'Create a plan',
    description:
      'Without `propose: true` this is a DRAFT, visible only to you and generating no notification. Requires a venue or a location, and a future time before it can be proposed.',
    body: createPlanSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND, E.FORBIDDEN],
  },
  {
    method: 'get',
    path: '/plans/{id}',
    tag: 'Plans',
    summary: 'One plan',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/plans/{id}',
    tag: 'Plans',
    summary: 'Edit a plan',
    description:
      'Creator only, and only while it is a draft or a proposal. Editing after acceptance would let one side change the time the other agreed to. Editing a proposal notifies the other person. Set `venue_id` or `custom_location` to `null` to switch between a venue and a typed location; one of them must remain.',
    body: updatePlanSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/plans/{id}/propose',
    tag: 'Plans',
    summary: 'Send a draft',
    description: 'The only way the other person learns the plan exists.',
    auth: true,
    errors: [E.NOT_FOUND, E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/plans/{id}/respond',
    tag: 'Plans',
    summary: 'Accept or decline',
    description:
      'Only the person who did NOT propose it may respond — otherwise someone could produce a confirmed meeting the other never agreed to. A proposal whose time has passed can be declined but not accepted.',
    body: respondSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/plans/{id}/cancel',
    tag: 'Plans',
    summary: 'Cancel a plan',
    description:
      'Either participant, any time before it is finished, and only for a plan that was sent. A draft is deleted instead (`DELETE /plans/{id}`). Unmatching or blocking cancels the pair’s open plans without a notification.',
    body: cancelSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'delete',
    path: '/plans/{id}',
    tag: 'Plans',
    summary: 'Delete a draft',
    description:
      'Drafts only, and only by their creator. A draft is deleted rather than cancelled because a cancelled plan is visible to both people, and the other person never saw the draft. Nobody is notified.',
    auth: true,
    errors: [E.NOT_FOUND, E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/plans/{id}/share',
    tag: 'Plans',
    summary: 'Share with trusted contacts',
    description:
      'Confirmed plans only. Telling someone\u2019s family about a plan that was never accepted is noise, and it leaks the other person\u2019s availability before they agreed to anything.',
    body: sharePlanSchema,
    auth: true,
    errors: [E.NOT_FOUND, E.BAD_REQUEST, E.VALIDATION_FAILED],
  },
  // --- venues -------------------------------------------------------------
  {
    method: 'get',
    path: '/venues',
    tag: 'Venues',
    summary: 'Search venues',
    description:
      'Distance-sorted, nearest first, in METRES. Filter by `category` and `mode` — a venue tagged for study_buddy will not surface in cuddle. Pass `latitude`/`longitude` to browse another area without moving your profile location.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.BAD_REQUEST],
  },
  {
    method: 'get',
    path: '/venues/saved',
    tag: 'Venues',
    summary: 'Your saved venues',
    auth: true,
    errors: [],
  },
  {
    method: 'get',
    path: '/venues/suggest/{match_id}',
    tag: 'Venues',
    summary: 'Suggestions for a match',
    description:
      'Tuned to the mode the match shares. Centred on YOUR location, not a midpoint — computing a midpoint needs the other person\u2019s coordinates, and exposing where someone lives, even indirectly, is not worth the convenience.',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'get',
    path: '/venues/{id}',
    tag: 'Venues',
    summary: 'One venue',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/venues/{id}/save',
    tag: 'Venues',
    summary: 'Save for later',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  {
    method: 'delete',
    path: '/venues/{id}/save',
    tag: 'Venues',
    summary: 'Remove from saved',
    auth: true,
    errors: [E.NOT_FOUND, E.VALIDATION_FAILED],
  },
  // --- subscriptions ------------------------------------------------------
  {
    method: 'get',
    path: '/subscriptions/products',
    tag: 'Subscriptions',
    summary: 'What is on sale',
    description:
      'The catalogue the paywall renders: Basic and Premium, monthly and yearly. Prices are integer MINOR UNITS plus a currency — never floats — and are INFORMATIONAL, because whoever takes the payment decides what is actually charged. Readable without a token, since the paywall is shown before some sign-in flows.',
    auth: false,
    errors: [],
  },
  {
    method: 'get',
    path: '/subscriptions/me',
    tag: 'Subscriptions',
    summary: 'Your subscription',
    description:
      'Read `is_active` rather than inferring from `status`: a cancelled subscription is still active until its period ends, and one in billing retry still entitles. Purchasing happens outside this API, so there is no endpoint here that starts one — this reports what the backend has been told.',
    auth: true,
    errors: [],
  },
  // --- calls --------------------------------------------------------------
  {
    method: 'post',
    path: '/calls',
    tag: 'Calls',
    summary: 'Start a video call',
    description:
      'Creates the call and returns a room token for YOU. The body names a **match**, never a user and never a room — a client-named room is how someone gets a token for a call they were not invited to. The other person receives a `call:incoming` socket event and a push carrying the same `call_id`; treat both as one call. Calling an already-live call on the same match returns that call rather than starting a second one, because two rooms for one conversation means two people in different rooms.',
    body: startCallSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND, E.FORBIDDEN],
  },
  {
    method: 'get',
    path: '/calls',
    tag: 'Calls',
    summary: 'Call history',
    description:
      'Newest first, cursor-paginated. Carries no token — a finished call has nothing to join. A call that rang out reads as `missed` even before the sweep rewrites the column, so history never shows something as still ringing. `duration_seconds` is null for a call that was never answered; zero would read as a call that connected silently.',
    auth: true,
    errors: [],
  },
  {
    method: 'post',
    path: '/calls/{id}/answer',
    tag: 'Calls',
    summary: 'Answer',
    description:
      'Only the person who did NOT start the call may answer. Returns your room token. Answering a call that was declined, ended, or rang out is a 409 rather than a silent no-op — the app needs to know why nothing happened.',
    auth: true,
    errors: [E.NOT_FOUND, E.FORBIDDEN, E.CONFLICT],
  },
  {
    method: 'post',
    path: '/calls/{id}/decline',
    tag: 'Calls',
    summary: 'Decline',
    description:
      'Only the callee. Emits `call:declined`, which is deliberately distinct from `call:ended` so the caller can say "declined" rather than "call ended".',
    auth: true,
    errors: [E.NOT_FOUND, E.FORBIDDEN, E.CONFLICT],
  },
  {
    method: 'post',
    path: '/calls/{id}/end',
    tag: 'Calls',
    summary: 'Hang up',
    description:
      'Either participant, at any live stage. **Idempotent** — both apps commonly send this on hang-up and the second must not surface an error. Duration is measured from when the call was ANSWERED, not from when it started ringing: a call that rang for forty seconds and was picked up for ten lasted ten.',
    auth: true,
    errors: [E.NOT_FOUND],
  },
  {
    method: 'get',
    path: '/calls/{id}/token',
    tag: 'Calls',
    summary: 'Re-issue a room token',
    description:
      'For a reconnect, or a call outstaying its token. Tokens are short-lived and scoped to exactly ONE room; this endpoint is what makes that workable rather than merely strict. The permission check runs again on every issue, so blocking someone mid-call stops their next reconnect instead of taking effect after they hang up. Refused once the call is over — a token for a finished room is a credential with no purpose.',
    auth: true,
    errors: [E.NOT_FOUND, E.CONFLICT],
  },
  {
    method: 'post',
    path: '/calls/{id}/safety',
    tag: 'Calls',
    summary: 'In-call safety action',
    description:
      '`flag`, `end_and_report`, or `send_live_update` (spec §5.7). The action is recorded before anything else happens, because the record is the point — a pattern of flags against one account is what moderation acts on. `end_and_report` ends the call FIRST and then files the report: someone reaching for this wants the call to stop. `note` is optional on purpose; a person reaching for a safety control mid-call is not in a position to write an explanation. The reported user is never told who reported them.',
    body: safetyActionSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
  // --- entitlements -------------------------------------------------------
  {
    method: 'get',
    path: '/me/entitlements',
    tag: 'Entitlements',
    summary: 'What this user’s plan includes',
    description:
      'The whole plan in one call: every feature flag, every daily quota with what is left of it, and the tier. Render paywalls and remaining-swipe counters from this rather than inferring them from 403s and 422s. Numeric values of -1 mean unlimited. Quotas reset at UTC midnight, given exactly by `resets_at`.',
    auth: true,
    errors: [],
  },
  // --- modes --------------------------------------------------------------
  {
    method: 'get',
    path: '/modes',
    tag: 'Modes',
    summary: 'All eight modes with their state',
    description:
      'Every mode, whether it is enabled, its per-mode preferences, and the label to render for its deck action. `can_enable` is false when a mode needs verification the user does not have — grey the toggle out rather than letting them tap it into a 403.',
    auth: true,
    errors: [],
  },
  {
    method: 'get',
    path: '/modes/{mode}',
    tag: 'Modes',
    summary: 'One mode',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'patch',
    path: '/modes/{mode}',
    tag: 'Modes',
    summary: 'Enable, disable, or configure a mode',
    description:
      'Preferences are PER MODE — a 5km radius in Cuddle and 50km in Networking is normal. `preferences` holds mode-specific extras validated against that mode: relationship_goal for dating, subject and academic_level for study_buddy, pet_type for pet_dates, instruments for trading. An unknown key is rejected, not ignored. Enabling beyond your plan returns PREMIUM_REQUIRED with upgrade context; Cuddle returns FORBIDDEN without verification.',
    body: modesSchema.updateModeSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED, E.PREMIUM_REQUIRED, E.FORBIDDEN],
  },
  {
    method: 'post',
    path: '/modes/{mode}/primary',
    tag: 'Modes',
    summary: 'Set the primary mode',
    description: 'Exactly one at a time. The mode must already be enabled.',
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },

  // --- settings -----------------------------------------------------------
  {
    method: 'get',
    path: '/settings',
    tag: 'Settings',
    summary: 'All settings',
    description:
      'Appearance, privacy, discovery, language, and snooze state. Stored server-side so they follow the user to a new device instead of resetting on reinstall.',
    auth: true,
    errors: [],
  },
  {
    method: 'patch',
    path: '/settings',
    tag: 'Settings',
    summary: 'Update settings',
    description:
      'Send only what changed. distance_unit is display only — the API always returns metres.',
    body: settingsSchema.updateSettingsSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'post',
    path: '/settings/snooze',
    tag: 'Settings',
    summary: 'Hide from all decks',
    description:
      'The account stays active and existing matches and conversations survive. Omit ends_at to snooze until manually resumed.',
    body: settingsSchema.snoozeSchema,
    auth: true,
    errors: [E.VALIDATION_FAILED],
  },
  {
    method: 'delete',
    path: '/settings/snooze',
    tag: 'Settings',
    summary: 'Resume',
    auth: true,
    errors: [],
  },

  // --- devices ------------------------------------------------------------
  {
    method: 'get',
    path: '/devices',
    tag: 'Settings',
    summary: 'Connected devices',
    description:
      'Send X-Device-Id and the current device is flagged with is_current, so the app can label it and stop the user signing themselves out by accident.',
    auth: true,
    errors: [],
  },
  {
    method: 'delete',
    path: '/devices/others',
    tag: 'Settings',
    summary: 'Sign out everywhere else',
    description: 'Keeps the device making the request. Ends every other session for real.',
    auth: true,
    errors: [],
  },
  {
    method: 'delete',
    path: '/devices/{id}',
    tag: 'Settings',
    summary: 'Revoke one device',
    description:
      'Ends that session rather than only removing it from a list — the refresh token family bound to the device is revoked too.',
    auth: true,
    errors: [E.VALIDATION_FAILED, E.NOT_FOUND],
  },
];

/** Express :param -> OpenAPI {param}. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParameters(path: string) {
  const names = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);

  return names.map((name) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }));
}

/**
 * The return type is widened deliberately. Inferring it makes the compiler walk
 * the whole Zod type graph for schemas like updateProfileSchema — a dozen
 * optional-and-nullable enums — and it gives up with "type instantiation is
 * excessively deep". The value is JSON either way.
 */
function bodySchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema as never, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

/** The spec §4.2 envelope, described once and referenced everywhere. */
const COMPONENTS = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'The access_token from /auth/login. Lives 30 minutes; refresh with /auth/refresh.',
    },
  },
  schemas: {
    SuccessEnvelope: {
      type: 'object',
      required: ['success', 'data', 'meta'],
      properties: {
        success: { type: 'boolean', enum: [true] },
        data: { description: 'Always an object or array, never a bare scalar.' },
        meta: {
          nullable: true,
          type: 'object',
          properties: {
            pagination: {
              type: 'object',
              properties: {
                next_cursor: { type: 'string', nullable: true },
                has_more: { type: 'boolean' },
                limit: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    ErrorEnvelope: {
      type: 'object',
      required: ['success', 'error'],
      properties: {
        success: { type: 'boolean', enum: [false] },
        error: {
          type: 'object',
          required: ['code', 'message', 'details'],
          properties: {
            code: {
              type: 'string',
              enum: Object.values(ERROR_CODES),
              description: 'Branch on this. Stable contract — never branch on `message`.',
            },
            message: { type: 'string', description: 'Displayable to the user. May change.' },
            details: {
              nullable: true,
              type: 'object',
              description:
                'For VALIDATION_FAILED, keyed by field name with a list of messages. For QUOTA_EXCEEDED, paywall context.',
            },
          },
        },
      },
    },
    AuthTokens: {
      type: 'object',
      required: ['access_token', 'refresh_token', 'token_type', 'expires_in'],
      properties: {
        access_token: { type: 'string' },
        refresh_token: {
          type: 'string',
          description: 'Rotates on every use. Always store the newest one.',
        },
        token_type: { type: 'string', enum: ['Bearer'] },
        expires_in: { type: 'integer', description: 'Seconds until the access token expires.' },
      },
    },
  },
} as const;

function errorResponse(code: ErrorCode) {
  return {
    description: `${code} — ${ERROR_MESSAGES[code]}`,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        example: {
          success: false,
          error: { code, message: ERROR_MESSAGES[code], details: null },
        },
      },
    },
  };
}

export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const openApiPath = API_PREFIX + toOpenApiPath(route.path);
    paths[openApiPath] ??= {};

    // Universal failures, plus whatever the route declares.
    const codes = new Set<ErrorCode>(route.errors);
    if (route.auth) {
      codes.add(E.AUTH_REQUIRED);
      codes.add(E.AUTH_TOKEN_EXPIRED);
      codes.add(E.AUTH_TOKEN_INVALID);
    }
    codes.add(E.RATE_LIMITED);
    codes.add(E.INTERNAL_ERROR);

    const responses: Record<string, unknown> = {
      [route.method === 'post' && !route.path.includes('{') ? '200' : '200']: {
        description: 'Success',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } },
        },
      },
    };

    for (const code of codes) {
      responses[String(ERROR_STATUS[code])] = errorResponse(code);
    }

    const parameters = pathParameters(openApiPath);

    paths[openApiPath][route.method] = {
      tags: [route.tag],
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.auth ? { security: [{ bearerAuth: [] }] } : { security: [] }),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: bodySchema(route.body) } },
            },
          }
        : {}),
      responses,
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Kinvo API',
      version: '1.0.0',
      description: [
        'REST API for Kinvo, a multi-mode social connection app.',
        '',
        '## Every response has the same shape',
        '',
        '```jsonc',
        '{ "success": true,  "data": {}, "meta": null }',
        '{ "success": false, "error": { "code": "AUTH_TOKEN_EXPIRED", "message": "...", "details": null } }',
        '```',
        '',
        'Branch on `error.code`, never on `message`. Codes are a stable contract; messages are user-facing text.',
        '',
        '## Authentication',
        '',
        'Sign in, then send `Authorization: Bearer <access_token>` on every request.',
        '',
        '| Code | Meaning | What the app should do |',
        '| --- | --- | --- |',
        '| `AUTH_REQUIRED` | No token sent | Go to sign-in |',
        '| `AUTH_TOKEN_EXPIRED` | Access token aged out | Refresh silently, retry the request |',
        '| `AUTH_TOKEN_INVALID` | Bad, revoked, or reused | Log the user out |',
        '',
        'Refresh tokens **rotate**: every call to `/auth/refresh` returns a new one and invalidates the old. Store the newest. Reusing an old one is treated as theft and signs that device out.',
        '',
        '## Test accounts',
        '',
        '`sarah.dev@kinvo.test` / `kinvo-dev-password` — and 29 more `*.dev@kinvo.test` users, same password.',
        '',
        '## Not yet available on staging',
        '',
        'Google, Apple and phone OTP return `SERVICE_UNAVAILABLE` — those provider accounts are not configured yet. Build the screens; the contract will not change.',
        '',
        '## Units and formats',
        '',
        '- Timestamps: UTC ISO-8601 with `Z`, field names end in `_at`',
        '- Dates: `YYYY-MM-DD`',
        '- **Distances: metres.** Format to miles in the app',
        '- Money: integer minor units plus a currency code',
        '- A missing value is `null`, never an omitted key. Empty lists are `[]`',
      ].join('\n'),
    },
    servers: [{ url: serverUrl, description: 'Staging' }],
    tags: [
      { name: 'Meta', description: 'Health and configuration' },
      { name: 'Auth', description: 'Registration, sign-in, tokens' },
      { name: 'Onboarding', description: 'Getting an account from pending to active' },
      { name: 'Profile', description: 'Profile content and public views' },
      { name: 'Media', description: 'Uploads, photos' },
      { name: 'Verification', description: 'Identity verification' },
      { name: 'Discovery', description: 'Decks, swipes, matches forming, boosts' },
      { name: 'Matches', description: 'The Matches and Archived tabs, unmatch, extend' },
      { name: 'Chat', description: 'Conversations, messages, read state' },
      {
        name: 'Moderation',
        description: 'Pre-send checks and the moderation queue',
      },
      {
        name: 'Notifications',
        description: 'Feed, push tokens, preferences, badge counts',
      },
      {
        name: 'Safety',
        description: 'Reports, blocks, trusted contacts, live location, emergency',
      },
      { name: 'Plans', description: 'Date planning and trusted-contact sharing' },
      { name: 'Venues', description: 'Curated places, search, save, suggest' },
      { name: 'Subscriptions', description: 'Product catalogue and your current subscription' },
      { name: 'Calls', description: 'Video call lifecycle, room tokens, in-call safety' },
      {
        name: 'Entitlements',
        description: 'Plan features and daily quotas',
      },
      { name: 'Modes', description: 'The eight connection modes and their per-mode preferences' },
      { name: 'Settings', description: 'Appearance, privacy, snooze, connected devices' },
    ],
    paths,
    components: COMPONENTS,
  };
}
