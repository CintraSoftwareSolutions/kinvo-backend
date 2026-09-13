import { ModerationSeverity } from '@/db/prisma';

/**
 * The moderation provider boundary (spec §5.4, decision #8, Batch 10).
 *
 * v1 is RULES-BASED: no external account, no per-call cost, no third party
 * holding users' private messages. The interface exists so that swapping in
 * OpenAI moderation, Perspective, or AWS Comprehend later is a provider change
 * and not a rewrite of every call site.
 *
 * A provider NEVER decides whether a message may be sent. It returns findings;
 * the service decides what to do with them, and the spec is explicit that the
 * answer is "warn, do not block".
 */

export const MODERATION_CATEGORIES = {
  /**
   * spec §1: scam and payment language is checked GLOBALLY, never scoped to
   * dating. Trading mode attracts investment fraud, and a check that only ran
   * on dating conversations would miss precisely the conversations most likely
   * to contain it.
   */
  SCAM_PAYMENT: 'scam_payment',
  /** Moving a conversation off-platform is the first step in most scams. */
  CONTACT_INFO: 'contact_info',
  SEXUAL_CONTENT: 'sexual_content',
  HATE_SPEECH: 'hate_speech',
  VIOLENCE_THREAT: 'violence_threat',
  SELF_HARM: 'self_harm',
  /** Language suggesting the sender or subject is under 18. */
  MINOR_SAFETY: 'minor_safety',
} as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[keyof typeof MODERATION_CATEGORIES];

export interface ModerationFinding {
  category: ModerationCategory;
  severity: ModerationSeverity;
  /** Shown to the user in the warning dialog. Never quotes their own text back. */
  message: string;
}

export interface ModerationResult {
  severity: ModerationSeverity;
  findings: ModerationFinding[];
  provider: string;
  /** True when the provider could not answer and the service failed open. */
  timed_out: boolean;
  raw?: unknown;
}

export interface ModerationProvider {
  readonly name: string;
  /**
   * Assesses text. Must not throw for ordinary content — a provider that throws
   * is treated as a timeout and fails open.
   */
  check(content: string): Promise<ModerationResult>;
  /**
   * True when this provider can assess this kind of subject. Rules-based v1
   * reads text and cannot look at pixels, so images are queued for a human
   * instead of being silently passed as clean.
   */
  supports(subjectType: string): boolean;
}

const SEVERITY_ORDER: Record<ModerationSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function highestSeverity(findings: ModerationFinding[]): ModerationSeverity {
  return findings.reduce<ModerationSeverity>(
    (worst, finding) =>
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worst] ? finding.severity : worst,
    ModerationSeverity.none,
  );
}

export function severityAtLeast(value: ModerationSeverity, threshold: ModerationSeverity): boolean {
  return SEVERITY_ORDER[value] >= SEVERITY_ORDER[threshold];
}
