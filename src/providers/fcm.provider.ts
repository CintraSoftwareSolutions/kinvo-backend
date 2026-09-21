import { type App, cert, deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { logger } from '@utils/logger';
import type { PushMessage, PushProvider, PushResult, PushTarget } from './push.provider';

/**
 * Firebase Cloud Messaging (spec §3, Batch 11).
 *
 * Credentials come from a service-account JSON held in SSM Parameter Store and
 * injected as one environment variable. It is never written to disk on the
 * instance and never enters the repository.
 */

/** Tokens FCM says will never work again, as opposed to a transient failure. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** One send covers at most this many tokens; FCM rejects larger batches. */
const BATCH_SIZE = 500;

interface ServiceAccountShape {
  project_id: string;
  client_email: string;
  private_key: string;
}

function parseServiceAccount(raw: string): ServiceAccountShape | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccountShape>;

    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      logger.error('firebase service account is missing required fields');
      return null;
    }

    return {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      // Environment variables cannot hold real newlines, so the key arrives with
      // literal \n sequences. Without this the PEM fails to parse and every
      // push fails with an opaque crypto error.
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
    };
  } catch {
    logger.error('firebase service account is not valid JSON');
    return null;
  }
}

const APP_NAME = 'kinvo-fcm';

export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  readonly isConfigured: boolean;

  private app: App | null = null;

  constructor(serviceAccountJson: string | undefined) {
    const account = serviceAccountJson ? parseServiceAccount(serviceAccountJson) : null;

    this.isConfigured = account !== null;

    if (!account) {
      return;
    }

    // Named app: initializeApp() with no name registers a global default, and a
    // second call anywhere in the process would throw. tsx watch re-imports on
    // every save, so reusing the existing instance is what stops a reload from
    // crashing the dev server.
    const existing = getApps().find((app) => app.name === APP_NAME);

    this.app =
      existing ??
      initializeApp(
        {
          credential: cert({
            projectId: account.project_id,
            clientEmail: account.client_email,
            privateKey: account.private_key,
          }),
        },
        APP_NAME,
      );

    logger.info({ project_id: account.project_id }, 'fcm configured');
  }

  async send(targets: PushTarget[], message: PushMessage): Promise<PushResult> {
    if (!this.app || targets.length === 0) {
      return { sent: 0, invalidTokens: [] };
    }

    // A call is the one message the app draws itself, and the two platforms
    // need different shapes for it, so they are sent separately. Everything
    // else goes out in one group, exactly as before.
    if (!message.drawnByApp) {
      return this.deliver(
        targets.map((target) => target.token),
        message,
        { wakeTheApp: false },
      );
    }

    const android = targets.filter((target) => target.platform === 'android');
    const rest = targets.filter((target) => target.platform !== 'android');

    const [woken, ordinary] = await Promise.all([
      this.deliver(
        android.map((target) => target.token),
        message,
        { wakeTheApp: true },
      ),
      this.deliver(
        rest.map((target) => target.token),
        message,
        { wakeTheApp: false },
      ),
    ]);

    return {
      sent: woken.sent + ordinary.sent,
      invalidTokens: [...woken.invalidTokens, ...ordinary.invalidTokens],
    };
  }

  private async deliver(
    tokens: string[],
    message: PushMessage,
    { wakeTheApp }: { wakeTheApp: boolean },
  ): Promise<PushResult> {
    if (!this.app || tokens.length === 0) {
      return { sent: 0, invalidTokens: [] };
    }

    const messaging = getMessaging(this.app);
    const invalidTokens: string[] = [];
    let sent = 0;

    for (let index = 0; index < tokens.length; index += BATCH_SIZE) {
      const batch = tokens.slice(index, index + BATCH_SIZE);

      try {
        const response = await messaging.sendEachForMulticast({
          tokens: batch,
          // A message the app draws itself carries no notification block for
          // Android: with one, Android puts it in the tray and never wakes the
          // app, which cannot then ring or show a call screen. The title and
          // body still travel, as data, so the app can render them.
          ...(wakeTheApp
            ? {
                data: {
                  ...message.data,
                  title: message.title,
                  body: message.body,
                },
                android: { priority: 'high' as const },
              }
            : {
                notification: { title: message.title, body: message.body },
                data: message.data,
                android: {
                  priority: 'high' as const,
                  notification: { sound: 'default' },
                },
              }),
          apns: {
            payload: {
              aps: {
                badge: message.badge,
                sound: 'default',
              },
            },
          },
        });

        sent += response.successCount;

        response.responses.forEach((result, position) => {
          const token = batch[position];

          if (result.success || !token) {
            return;
          }

          // Only permanent failures are collected. Treating a transient network
          // error as a dead token would unsubscribe a working device.
          if (DEAD_TOKEN_CODES.has(result.error?.code ?? '')) {
            invalidTokens.push(token);
          }
        });
      } catch (error) {
        // Swallowed deliberately: the notification is already in the feed, so a
        // failed push costs a banner, not the notification.
        logger.error({ err: error, count: batch.length }, 'fcm batch send failed');
      }
    }

    return { sent, invalidTokens };
  }

  /** Tests and graceful shutdown — an un-deleted app keeps handles open. */
  async close(): Promise<void> {
    if (this.app) {
      await deleteApp(this.app);
      this.app = null;
    }
  }
}
