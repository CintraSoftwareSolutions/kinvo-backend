import { ModerationSeverity } from '@/db/prisma';
import {
  HIGH_AT,
  MEDIUM_AT,
  NO_RISK_SIGNALS,
  RISK_BLOCK_CAP,
  RISK_WEIGHTS,
  type RiskSignals,
  activityState,
  riskLevel,
  scoreRisk,
} from '@modules/admin/risk';

/**
 * Account risk scoring (Batch 15 — admin panel).
 *
 * Pure, so it is tested without a database. Worth testing carefully for one
 * reason: the first version of this scorer named only three of the five
 * severity levels, so `critical` scored ZERO and the most dangerous accounts in
 * the product read as "Low risk" on every admin screen. A wrong risk score is
 * not a cosmetic bug — it decides which account a moderator looks at next.
 */

function signals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return { ...NO_RISK_SIGNALS, ...overrides };
}

describe('scoreRisk', () => {
  it('scores a clean account at zero', () => {
    expect(scoreRisk(signals())).toBe(0);
    expect(riskLevel(0)).toBe('Low risk');
    expect(activityState(0)).toBe('Healthy');
  });

  it('gives every severity level a non-zero weight', () => {
    // THE REGRESSION TEST. A level worth nothing is a level that hides rows,
    // and the omission is invisible — the score simply comes back lower.
    for (const severity of Object.values(ModerationSeverity)) {
      if (severity === ModerationSeverity.none) {
        // `none` means the scan found nothing. Not a risk signal by design.
        continue;
      }

      const key = `${severity}Flags` as keyof RiskSignals;
      const score = scoreRisk(signals({ [key]: 1 }));

      expect(score).toBeGreaterThan(0);
    }
  });

  it('ranks critical above high above medium above low', () => {
    const critical = scoreRisk(signals({ criticalFlags: 1 }));
    const high = scoreRisk(signals({ highFlags: 1 }));
    const medium = scoreRisk(signals({ mediumFlags: 1 }));
    const low = scoreRisk(signals({ lowFlags: 1 }));

    // Strictly ordered, so a worse flag can never sort below a milder one.
    expect(critical).toBeGreaterThan(high);
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
  });

  it('puts a single critical flag straight into High risk', () => {
    const score = scoreRisk(signals({ criticalFlags: 1 }));

    // One critical finding must not need a second signal to be noticed.
    expect(score).toBeGreaterThanOrEqual(HIGH_AT);
    expect(riskLevel(score)).toBe('High risk');
    expect(activityState(score)).toBe('Escalated');
  });

  it('treats one open report as enough to stop being Low risk', () => {
    const score = scoreRisk(signals({ openReports: 1 }));

    expect(score).toBeGreaterThanOrEqual(MEDIUM_AT);
    expect(riskLevel(score)).toBe('Medium risk');
    expect(activityState(score)).toBe('Watch');
  });

  it('caps blocks so popularity cannot read as misconduct', () => {
    const atCap = scoreRisk(signals({ blocksReceived: RISK_BLOCK_CAP }));
    const wayOver = scoreRisk(signals({ blocksReceived: RISK_BLOCK_CAP + 500 }));

    expect(wayOver).toBe(atCap);

    // And the cap has to sit below the High threshold, or a busy account with
    // no reports and no flags against it would still be escalated.
    expect(riskLevel(wayOver)).not.toBe('High risk');
  });

  it('weights an open report above an automated high-severity flag', () => {
    // A person took the trouble to file it and nobody has judged it yet; the
    // rules are advisory by design (spec §5.4) and false positives expected.
    expect(RISK_WEIGHTS.OPEN_REPORT).toBeGreaterThanOrEqual(RISK_WEIGHTS.FLAG_HIGH);
    expect(RISK_WEIGHTS.BLOCK_RECEIVED).toBeLessThan(RISK_WEIGHTS.FLAG_LOW + 1);
  });

  it('adds signals rather than taking the worst one', () => {
    const combined = scoreRisk(signals({ openReports: 2, mediumFlags: 1, blocksReceived: 2 }));

    expect(combined).toBe(
      2 * RISK_WEIGHTS.OPEN_REPORT + RISK_WEIGHTS.FLAG_MEDIUM + 2 * RISK_WEIGHTS.BLOCK_RECEIVED,
    );
  });

  it('keeps the thresholds in order', () => {
    // A HIGH_AT below MEDIUM_AT would make `riskLevel` unreachable for Medium,
    // and the bug would only show up as a chart that never renders one colour.
    expect(HIGH_AT).toBeGreaterThan(MEDIUM_AT);
    expect(MEDIUM_AT).toBeGreaterThan(0);
  });
});

describe('NO_RISK_SIGNALS', () => {
  it('covers every signal the scorer reads', () => {
    // The constant exists because an inline copy drifts silently when a signal
    // is added. If this ever fails, a caller is scoring a partial object.
    const keys = Object.keys(NO_RISK_SIGNALS) as (keyof RiskSignals)[];

    for (const key of keys) {
      expect(NO_RISK_SIGNALS[key]).toBe(0);
    }

    expect(keys).toEqual(
      expect.arrayContaining([
        'openReports',
        'criticalFlags',
        'highFlags',
        'mediumFlags',
        'lowFlags',
        'blocksReceived',
      ]),
    );
  });
});
