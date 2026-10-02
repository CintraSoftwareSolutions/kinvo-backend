import { ModerationSeverity } from '@/db/prisma';
import { evaluate } from '@modules/moderation/rules';
import {
  type ModerationProvider,
  type ModerationResult,
  highestSeverity,
} from './moderation.provider';

export class RulesModerationProvider implements ModerationProvider {
  readonly name = 'rules-v1';

  check(content: string): Promise<ModerationResult> {
    const findings = evaluate(content);

    return Promise.resolve({
      severity: highestSeverity(findings),
      findings,
      provider: this.name,
      timed_out: false,
    });
  }
  supports(subjectType: string): boolean {
    return ['message', 'bio', 'prompt_answer', 'display_name'].includes(subjectType);
  }
}

export class UnavailableModerationProvider implements ModerationProvider {
  readonly name = 'unavailable';

  check(): Promise<ModerationResult> {
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('moderation provider unavailable')), 50);
    });
  }

  supports(): boolean {
    return true;
  }
}

export const NONE: ModerationSeverity = ModerationSeverity.none;
