import { ModerationSeverity } from '@/db/prisma';
import {
  MODERATION_CATEGORIES,
  type ModerationCategory,
  type ModerationFinding,
} from '@/providers/moderation.provider';

interface Rule {
  category: ModerationCategory;
  severity: ModerationSeverity;
  pattern: RegExp;
  message: string;
}

export function normalise(content: string): string {
  return (
    content
      .toLowerCase()
      // Unicode lookalikes used to slip past matching.
      .replace(/[‐-―]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/(\b\w)(?:[.\-_*]+(\w)\b)+/g, (match) => match.replace(/[.\-_*]+/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function compact(content: string): string {
  return content.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RULES: Rule[] = [
  // --- scam and payment, GLOBAL (spec §1) ---------------------------------
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.critical,
    pattern:
      /\b(seed phrase|recovery phrase|private key|wallet address|send (?:me )?(?:your )?(?:btc|eth|bitcoin|ethereum|crypto))\b/,
    message:
      'This looks like a request for crypto credentials. Nobody legitimate will ever ask for a seed phrase or private key.',
  },
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.high,
    pattern:
      /\b(guaranteed (?:returns?|profits?)|double your (?:money|investment)|risk[- ]free (?:profit|investment|returns?)|insider tip|pump and dump|signal group)\b/,
    message: 'This reads like an investment pitch. Guaranteed returns do not exist.',
  },
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.high,
    pattern:
      /\b(gift ?card|steam card|itunes card|western union|money ?gram|wire (?:me|the money|transfer))\b/,
    message: 'Gift cards and wire transfers are the most common way people are defrauded.',
  },
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.medium,
    pattern:
      /\b(cash ?app|venmo|zelle|paypal ?me|revolut|send (?:me )?(?:some )?(?:cash|money)|lend me (?:some )?money|need (?:some )?money urgently)\b/,
    message: 'Be careful sending money to someone you have not met.',
  },
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.medium,
    pattern:
      /\b(trading (?:platform|account|bot)|forex|binary options?|mining (?:pool|rig)|my (?:broker|financial advisor)|investment (?:opportunity|platform))\b/,
    message:
      'Investment offers from someone you met on a dating or social app are almost always fraudulent.',
  },

  // --- moving off-platform -------------------------------------------------
  {
    category: MODERATION_CATEGORIES.CONTACT_INFO,
    severity: ModerationSeverity.low,
    // Loose enough for international formats, tight enough not to match a year
    // or a street number.
    pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?){2}\d{3,4}\b/,
    message:
      'Sharing a phone number moves the conversation somewhere we cannot help if something goes wrong.',
  },
  {
    category: MODERATION_CATEGORIES.CONTACT_INFO,
    severity: ModerationSeverity.low,
    pattern: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/,
    message: 'Sharing an email address moves the conversation off Kinvo.',
  },
  {
    category: MODERATION_CATEGORIES.CONTACT_INFO,
    severity: ModerationSeverity.low,
    pattern: /\b(whats ?app|telegram|snapchat|kik|signal app|wechat|my insta(?:gram)?|dm me on)\b/,
    message: 'Moving to another app early is a common tactic. There is no rush.',
  },

  // --- safety --------------------------------------------------------------
  {
    category: MODERATION_CATEGORIES.MINOR_SAFETY,
    severity: ModerationSeverity.critical,
    pattern:
      /\b(i(?:'| a)?m \d{1,2}(?: years? old)?|i am \d{1,2} years? old|(?:in|im in) (?:middle school|high school|year (?:7|8|9|10|11)))\b/,
    message: 'Kinvo is 18+. Age statements are reviewed.',
  },
  {
    category: MODERATION_CATEGORIES.VIOLENCE_THREAT,
    severity: ModerationSeverity.critical,
    pattern:
      /\b(i(?:'| wi)?ll (?:kill|hurt|find) you|going to (?:kill|hurt) you|watch your back|i know where you live)\b/,
    message: 'Threats are not allowed and are reviewed by our safety team.',
  },
  {
    category: MODERATION_CATEGORIES.SELF_HARM,
    severity: ModerationSeverity.high,
    pattern: /\b(kill myself|end my life|want to die|suicidal|self ?harm)\b/,
    message: 'If you are struggling, support is available. This message will be reviewed.',
  },
  {
    category: MODERATION_CATEGORIES.HATE_SPEECH,
    severity: ModerationSeverity.high,
    pattern:
      /\b(go back to your country|subhuman|your (?:kind|people) (?:should|deserve)|racial slur placeholder)\b/,
    message: 'This may violate our rules on hateful content.',
  },
  {
    category: MODERATION_CATEGORIES.SEXUAL_CONTENT,
    severity: ModerationSeverity.medium,
    pattern: /\b(send (?:me )?nudes?|nude pics?|dick pic|sext(?:ing)?|only ?fans)\b/,
    message: 'Unsolicited sexual content is a common report. Consider whether this is welcome.',
  },
];

const COMPACT_RULES: Rule[] = [
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.critical,
    pattern: /(seedphrase|recoveryphrase|privatekey|walletaddress)/,
    message:
      'This looks like a request for crypto credentials. Nobody legitimate will ever ask for a seed phrase or private key.',
  },
  {
    category: MODERATION_CATEGORIES.SCAM_PAYMENT,
    severity: ModerationSeverity.medium,
    pattern: /(cashapp|paypalme|moneygram|westernunion)/,
    message: 'Be careful sending money to someone you have not met.',
  },
];

export function evaluate(content: string): ModerationFinding[] {
  const normalised = normalise(content);
  const compacted = compact(content);
  const worstByCategory = new Map<ModerationCategory, ModerationFinding>();

  const consider = (rule: Rule, subject: string): void => {
    if (!rule.pattern.test(subject)) {
      return;
    }

    const existing = worstByCategory.get(rule.category);

    if (!existing || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[existing.severity]) {
      worstByCategory.set(rule.category, {
        category: rule.category,
        severity: rule.severity,
        message: rule.message,
      });
    }
  };

  for (const rule of RULES) {
    consider(rule, normalised);
  }

  for (const rule of COMPACT_RULES) {
    consider(rule, compacted);
  }

  return [...worstByCategory.values()];
}

const SEVERITY_RANK: Record<ModerationSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const RULE_COUNT = RULES.length + COMPACT_RULES.length;
