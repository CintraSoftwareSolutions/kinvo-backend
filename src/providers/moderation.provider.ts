import { ModerationSeverity } from '@/db/prisma';

export const MODERATION_CATEGORIES = {
  SCAM_PAYMENT: 'scam_payment',
  CONTACT_INFO: 'contact_info',
  SEXUAL_CONTENT: 'sexual_content',
  HATE_SPEECH: 'hate_speech',
  VIOLENCE_THREAT: 'violence_threat',
  SELF_HARM: 'self_harm',
  MINOR_SAFETY: 'minor_safety',
} as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[keyof typeof MODERATION_CATEGORIES];

export interface ModerationFinding {
  category: ModerationCategory;
  severity: ModerationSeverity;
  message: string;
}

export interface ModerationResult {
  severity: ModerationSeverity;
  findings: ModerationFinding[];
  provider: string;
  timed_out: boolean;
  raw?: unknown;
}

export interface ModerationProvider {
  readonly name: string;
  check(content: string): Promise<ModerationResult>;
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
