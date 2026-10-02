import type { DevicePlatform } from '@/db/prisma';
import { logger } from '@utils/logger';

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
  badge?: number;
  drawnByApp?: boolean;
}

export interface PushTarget {
  token: string;
  platform: DevicePlatform;
}

export interface PushResult {
  sent: number;
  invalidTokens: string[];
}

export interface PushProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  send(targets: PushTarget[], message: PushMessage): Promise<PushResult>;
}

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
