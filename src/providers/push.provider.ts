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
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
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

  send(tokens: string[]): Promise<PushResult> {
    if (tokens.length > 0) {
      logger.debug({ count: tokens.length }, 'push skipped — no provider configured');
    }

    return Promise.resolve({ sent: 0, invalidTokens: [] });
  }
}
