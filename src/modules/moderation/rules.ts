import { ModerationSeverity } from '@/db/prisma';
import {
  MODERATION_CATEGORIES,
  type ModerationCategory,
  type ModerationFinding,
} from '@/providers/moderation.provider';

/**
 * The rule set behind rules-based moderation v1 (decision #8, spec §5.4).
 *
 * Two design constraints shape every rule here:
 *
 *  1. **The result is ADVISORY.** A false positive costs the user one dialog
 *     they can dismiss; a false negative lets a scam through. That asymmetry
 *     justifies leaning slightly toward catching things — but only slightly,
 *     because a warning users learn to dismiss reflexively protects nobody.
 *
 *  2. **Scam and payment language is checked on EVERY mode** (spec §1). Trading
 *     is an interest category with no trading functionality, which makes it the
 *     most likely home for investment fraud. A check scoped to dating would
 *     miss exactly the conversations that need it.
 *
 * Patterns are deliberately phrase-based rather than keyword-based. "cash" is a
 * normal word; "cash app" and "send cash" are not. Matching bare keywords is
 * how a moderation system becomes noise.
 */

interface Rule {
  category: ModerationCategory;
  severity: ModerationSeverity;
  pattern: RegExp;
  message: string;
}

/**
 * Lowercases and repairs punctuation, then rejoins letters split by punctuation
 * only: "w-a-l-l-e-t" becomes "wallet".
 *
 * SPACES ARE LEFT ALONE HERE, deliberately. Collapsing them too would merge
 * "w-a-l-l-e-t a-d-d-r-e-s-s" into one word and stop it matching the phrase it
 * obviously is. Space-based evasion is handled by {@link compact} instead,
 * because once the spaces are gone there is no way to know where the word
 * breaks were.
 */
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

/**
 * Everything except letters and digits removed.
 *
 * This is what catches "s e e d p h r a s e" and "s.e.e.d p-h-r-a-s-e". Only
 * the COMPACT_RULES below run against it: a phrase pattern containing a space
 * can never match a string with no spaces, so running the full rule set here
 * would be wasted work that also invites false positives across word
 * boundaries — "the rapist" compacts to something no rule should match on.
 */
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

/**
 * Space- and punctuation-proof forms of the terms worth the most.
 *
 * Kept to a short list on purpose. Matching compacted text is powerful and
 * indiscriminate: every entry here has to be a string that essentially cannot
 * occur inside ordinary prose once the spaces are stripped.
 */
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

/**
 * Runs every rule and returns one finding per category.
 *
 * De-duplicated by category on purpose: three payment phrases in one message is
 * still one problem, and a dialog listing the same warning three times reads as
 * broken rather than thorough.
 */
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

/** Exposed for the rule-count assertion in tests. */
export const RULE_COUNT = RULES.length + COMPACT_RULES.length;
