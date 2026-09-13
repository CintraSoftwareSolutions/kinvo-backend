import { compact, evaluate, normalise } from '@modules/moderation/rules';
import { MODERATION_CATEGORIES, highestSeverity } from '@/providers/moderation.provider';

/**
 * The rule set (decision #8, spec §5.4).
 *
 * Two properties matter more than raw coverage:
 *
 *  - Scam and payment language is caught regardless of mode (spec §1). Trading
 *    is where investment fraud will live, and a dating-scoped check would miss
 *    exactly those conversations.
 *  - Ordinary sentences do NOT trip. A warning users learn to dismiss
 *    reflexively protects nobody, so the false-positive cases below carry as
 *    much weight as the true positives.
 */

function categories(content: string): string[] {
  return evaluate(content).map((finding) => finding.category);
}

describe('scam and payment language', () => {
  it('catches a request for crypto credentials at the highest severity', () => {
    const findings = evaluate('just send me your seed phrase and I will sort it out');

    expect(findings.map((f) => f.category)).toContain(MODERATION_CATEGORIES.SCAM_PAYMENT);
    expect(highestSeverity(findings)).toBe('critical');
  });

  it('catches an investment pitch', () => {
    expect(categories('I can get you guaranteed returns, my broker is great')).toContain(
      MODERATION_CATEGORIES.SCAM_PAYMENT,
    );
  });

  it('catches gift cards and wire transfers', () => {
    expect(categories('can you grab a steam card for me')).toContain(
      MODERATION_CATEGORIES.SCAM_PAYMENT,
    );
    expect(categories('just wire me the money tonight')).toContain(
      MODERATION_CATEGORIES.SCAM_PAYMENT,
    );
  });

  it('catches payment apps', () => {
    expect(categories('do you have cash app')).toContain(MODERATION_CATEGORIES.SCAM_PAYMENT);
  });

  it('runs on every mode, not just dating (spec §1)', () => {
    // The rules take no mode argument at all — the check cannot be scoped to a
    // mode even by accident, which is the point. Trading conversations are the
    // most likely home for this language.
    const tradingTalk = 'join my signal group, guaranteed profits on forex';

    expect(categories(tradingTalk)).toContain(MODERATION_CATEGORIES.SCAM_PAYMENT);
    expect(evaluate.length).toBe(1);
  });

  it('sees through spaced-out evasion', () => {
    expect(categories('send me your s e e d p h r a s e')).toContain(
      MODERATION_CATEGORIES.SCAM_PAYMENT,
    );
  });

  it('sees through punctuation evasion', () => {
    expect(categories('whats your w-a-l-l-e-t a-d-d-r-e-s-s')).toContain(
      MODERATION_CATEGORIES.SCAM_PAYMENT,
    );
  });
});

describe('moving off-platform', () => {
  it('catches a phone number', () => {
    expect(categories('call me on 555 123 4567')).toContain(MODERATION_CATEGORIES.CONTACT_INFO);
  });

  it('catches an email address', () => {
    expect(categories('reach me at someone@example.com')).toContain(
      MODERATION_CATEGORIES.CONTACT_INFO,
    );
  });

  it('catches other messaging apps', () => {
    expect(categories('lets move to whatsapp')).toContain(MODERATION_CATEGORIES.CONTACT_INFO);
    expect(categories('add me on telegram')).toContain(MODERATION_CATEGORIES.CONTACT_INFO);
  });
});

describe('safety categories', () => {
  it('treats an under-18 statement as critical', () => {
    const findings = evaluate('haha im 16 btw');

    expect(findings.map((f) => f.category)).toContain(MODERATION_CATEGORIES.MINOR_SAFETY);
    expect(highestSeverity(findings)).toBe('critical');
  });

  it('treats a threat as critical', () => {
    expect(highestSeverity(evaluate('i know where you live'))).toBe('critical');
  });

  it('catches self-harm language', () => {
    expect(categories('i want to die')).toContain(MODERATION_CATEGORIES.SELF_HARM);
  });

  it('catches unsolicited sexual requests', () => {
    expect(categories('send nudes')).toContain(MODERATION_CATEGORIES.SEXUAL_CONTENT);
  });
});

describe('ordinary messages do not trip the rules', () => {
  const innocent = [
    'Hey! How was your weekend?',
    'I went climbing on Saturday, my elbows are destroyed',
    'That ramen place is worth the queue, go before 6',
    'I work in finance actually, mostly compliance',
    'Do you want to grab a coffee on Thursday?',
    'My cat is sitting on the keyboard again',
    'I paid for the tickets already, you can get the next round',
    'The cash machine on the corner was out of order',
    'I studied economics but I never used it',
    'Cheers, see you at 7',
  ];

  it.each(innocent)('leaves %j alone', (content) => {
    expect(evaluate(content)).toEqual([]);
  });

  it('does not read a year or a price as a phone number', () => {
    expect(categories('I moved here in 2019 and rent was 1200 a month')).not.toContain(
      MODERATION_CATEGORIES.CONTACT_INFO,
    );
  });

  it('does not flag the word cash on its own', () => {
    expect(evaluate('I only had cash on me')).toEqual([]);
  });

  it('does not flag talking about a job in trading', () => {
    // Trading is an interest category. Saying you work in it is not a scam.
    expect(evaluate('I trade equities for a living, mostly boring stuff')).toEqual([]);
  });
});

describe('findings', () => {
  it('reports one finding per category, not one per matching phrase', () => {
    // Three payment phrases is still one problem. A dialog repeating the same
    // warning three times reads as broken rather than thorough.
    const findings = evaluate('venmo or cash app, or just wire me the money');
    const payment = findings.filter((f) => f.category === MODERATION_CATEGORIES.SCAM_PAYMENT);

    expect(payment).toHaveLength(1);
  });

  it('keeps the worst severity when a category matches twice', () => {
    const findings = evaluate('send me your private key or just use cash app');
    const payment = findings.find((f) => f.category === MODERATION_CATEGORIES.SCAM_PAYMENT);

    expect(payment?.severity).toBe('critical');
  });

  it('never echoes the user’s own text back at them', () => {
    // The advice may NAME a concept ('seed phrase') — that is the warning. What
    // it must never do is quote the message, which would put private content
    // into a dialog and, worse, into any screenshot of it.
    for (const finding of evaluate('send me your seed phrase, my number is 555 123 4567')) {
      expect(finding.message).not.toContain('555 123 4567');
      expect(finding.message).not.toContain('send me your');
    }
  });

  it('can find several distinct categories at once', () => {
    const found = categories('im 16, send me nudes on whatsapp');

    expect(found).toContain(MODERATION_CATEGORIES.MINOR_SAFETY);
    expect(found).toContain(MODERATION_CATEGORIES.SEXUAL_CONTENT);
    expect(found).toContain(MODERATION_CATEGORIES.CONTACT_INFO);
  });
});

describe('normalise and compact', () => {
  it('rejoins letters split by punctuation', () => {
    expect(normalise('c-r-y-p-t-o')).toContain('crypto');
  });

  it('deliberately leaves spaces alone', () => {
    // Collapsing spaces here would merge "w-a-l-l-e-t a-d-d-r-e-s-s" into one
    // word and stop it matching the phrase it plainly is. Space-based evasion
    // is compact()'s job, where the word breaks are gone anyway.
    expect(normalise('w-a-l-l-e-t a-d-d-r-e-s-s')).toBe('wallet address');
  });

  it('leaves ordinary text readable', () => {
    expect(normalise('Hello  There')).toBe('hello there');
  });

  it('compact strips everything that is not a letter or digit', () => {
    expect(compact('s e e d p h r a s e')).toBe('seedphrase');
    expect(compact('C.a.s.h A.p.p')).toBe('cashapp');
  });
});
