import { ModerationSeverity } from '@/db/prisma';
import { evaluate } from '@modules/moderation/rules';
import {
  type ModerationProvider,
  type ModerationResult,
  highestSeverity,
} from './moderation.provider';

/**
 * Rules-based moderation, v1 (decision #8).
 *
 * Chosen over OpenAI, Perspective, or AWS Comprehend for three reasons:
 *
 *  - It needs no account and no key, so it cannot become the thing blocking a
 *    launch.
 *  - It costs nothing per call, so it can run on every message rather than
 *    being rationed.
 *  - It does not send users' private messages to a third party, which for a
 *    dating app is a meaningful privacy property and not just a cost saving.
 *
 * It is worse at nuance than a model, and it is meant to be replaced. That is
 * what the `ModerationProvider` interface is for.
 */
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

  /**
   * Text only. Rules read words and cannot look at pixels, so claiming to
   * support images would mark every photo clean — worse than admitting the gap,
   * because the queue would look healthy while nothing was being checked.
   */
  supports(subjectType: string): boolean {
    return ['message', 'bio', 'prompt_answer', 'display_name'].includes(subjectType);
  }
}

/** A provider that always times out — used to prove the fail-open path. */
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
