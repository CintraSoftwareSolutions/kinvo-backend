import type { DevicePlatform } from '@/db/prisma';
import { logger } from '@utils/logger';

/**
 * Push delivery boundary (spec §7, Batch 11).
 *
 * THE RULE THAT SHAPES THIS MODULE: a notification is persisted to the feed
 * AND pushed. Never pushed alone. The Notifications screen reads the feed, so a
 * push-only notification vanishes the moment the user swipes the banner away —
 * and a user who tapped away a match notification has no other way to find it.
 *
 * So push is delivery, exactly like the socket layer: best-effort, and never
 * the record. Every function here can fail without the notification being lost.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link payload the app routes on. FCM requires all values to be strings. */
  data: Record<string, string>;
  /** Drives the app icon badge; the count comes from the feed, not from pushes. */
  badge?: number;
  /**
   * True when the APP draws this one, not the system tray — an incoming call,
   * which has to ring and cover the lock screen with Answer and Decline.
   *
   * Android delivers a message carrying a `notification` block straight to the
   * tray while the app is in the background, and the app never sees it. A
   * data-only message at high priority is woken up and handed to the app
   * instead, which is the only way it can show a call screen. Apple keeps the
   * ordinary payload: a real incoming-call screen there needs CallKit and VoIP
   * push, which need a paid developer account and a final app id.
   */
  drawnByApp?: boolean;
}

/**
 * One phone to reach.
 *
 * The platform travels with the token because the two need different message
 * shapes for a call: Android must be woken up with a data-only message so the
 * app can ring, while Apple keeps the ordinary payload. Everything else is
 * identical on both.
 */
export interface PushTarget {
  token: string;
  platform: DevicePlatform;
}

export interface PushResult {
  sent: number;
  /**
   * Tokens the provider reported as permanently dead — app uninstalled, or the
   * token rotated. The caller clears these, otherwise every future send retries
   * addresses that can never receive anything.
   */
  invalidTokens: string[];
}

export interface PushProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  send(targets: PushTarget[], message: PushMessage): Promise<PushResult>;
}

/**
 * What runs until Firebase credentials exist, and in every test.
 *
 * Reports success without sending anything. That is safe ONLY because the
 * notification is already in the feed by the time this is called — the user
 * still sees it when they open the app, they just do not get a banner. If push
 * were the record, this class would be silent data loss.
 */
export class NoopPushProvider implements PushProvider {
  readonly name = 'noop';
  readonly isConfigured = false;

  send(targets: PushTarget[]): Promise<PushResult> {
    if (targets.length > 0) {
      logger.debug({ count: targets.length }, 'push skipped — no provider configured');
    }

    return Promise.resolve({ sent: 0, invalidTokens: [] });
  }
}
