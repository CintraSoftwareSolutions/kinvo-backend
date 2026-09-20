import { API_PREFIX } from '@config/constants';
import { VerificationMethod, VerificationStatus, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';

/**
 * Verification review — the admin surface (Batch 15).
 *
 * The admin PANEL is a separate codebase. What is tested here is the boundary
 * it calls across, and the reason that boundary exists: a panel writing
 * `status = approved` straight into the table would skip the second-review
 * check, the badge recomputation, the audit entry and the notification. Every
 * one of those is asserted below, because every one of them is a thing that
 * would otherwise be quietly missing.
 *
 * The badge is not cosmetic: `verified_only` is a hard discovery filter and
 * Cuddle mode requires verification, so an approval decides who can see whom.
 */

const VERIFICATION = `${API_PREFIX}/verification`;

/** A submitted verification, the way a user's wizard leaves one. */
async function submittedVerification(
  userId: string,
  method: VerificationMethod = VerificationMethod.photo,
) {
  return prisma.verification.create({
    data: {
      user_id: userId,
      method,
      status: VerificationStatus.pending,
      current_step: 3,
      submitted_at: new Date(),
    },
  });
}

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('the queue is behind a role gate', () => {
  it('refuses an ordinary account', async () => {
    const user = await createAuthenticatedUser();

    const response = await api.get(`${VERIFICATION}/review`).set(authHeader(user.tokens));

    // 403, not the block-style 404: a moderator surface is not something to
    // hide from the person holding the role, and the role check is the honest
    // refusal (same convention as /reports/review).
    expect(response.status).toBe(403);
  });

  it('refuses an ordinary account trying to decide', async () => {
    const subject = await createAuthenticatedUser();
    const other = await createAuthenticatedUser();
    const record = await submittedVerification(subject.user_id);

    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(other.tokens))
      .send({ approve: true });

    expect(response.status).toBe(403);

    // And nothing moved.
    const after = await prisma.verification.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.status).toBe(VerificationStatus.pending);
  });

  it('requires a token at all', async () => {
    const response = await api.get(`${VERIFICATION}/review`);

    expect(response.status).toBe(401);
  });
});

describe('GET /verification/review', () => {
  it('lists submitted verifications oldest first', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const first = await createAuthenticatedUser();
    const second = await createAuthenticatedUser();

    const older = await submittedVerification(first.user_id);
    await prisma.verification.update({
      where: { id: older.id },
      data: { submitted_at: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const newer = await submittedVerification(second.user_id);

    const response = await api.get(`${VERIFICATION}/review`).set(authHeader(moderator.tokens));

    expectSuccessEnvelope(response.body);
    expect(response.body.data).toHaveLength(2);

    // OLDEST first, unlike every other list in this API. A queue is work to get
    // through; newest-first strands whoever has waited longest.
    expect(response.body.data[0].id).toBe(older.id);
    expect(response.body.data[1].id).toBe(newer.id);
  });

  it('leaves half-finished wizards out of the queue', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser();

    // Started, never submitted — nobody is waiting on it.
    await prisma.verification.create({
      data: {
        user_id: user.user_id,
        method: VerificationMethod.photo,
        status: VerificationStatus.pending,
        current_step: 1,
      },
    });

    const response = await api.get(`${VERIFICATION}/review`).set(authHeader(moderator.tokens));

    expect(response.body.data).toHaveLength(0);
  });

  it('carries enough to decide without a second call', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser({ display_name: 'Rosa' });
    await submittedVerification(user.user_id, VerificationMethod.government_id);

    const response = await api.get(`${VERIFICATION}/review`).set(authHeader(moderator.tokens));

    const row = response.body.data[0];

    // spec §4.7: the row renders from one call.
    expect(row.user.display_name).toBe('Rosa');
    expect(row.method).toBe('government_id');
    expect(row.submitted_at).toMatch(/Z$/);
    // No document attached, so no URL — rather than a link to bytes that
    // never arrived.
    expect(row.document_url).toBeNull();
  });

  it('can show what was already decided', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(moderator.tokens))
      .send({ approve: true });

    const pending = await api.get(`${VERIFICATION}/review`).set(authHeader(moderator.tokens));
    const approved = await api
      .get(`${VERIFICATION}/review?status=approved`)
      .set(authHeader(moderator.tokens));

    expect(pending.body.data).toHaveLength(0);
    expect(approved.body.data).toHaveLength(1);
  });
});

describe('the decision', () => {
  it('approves, sets the badge, audits, and tells the user', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(moderator.tokens))
      .send({ approve: true });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('approved');
    expect(response.body.data.is_verified).toBe(true);

    // The badge is RECOMPUTED from the records, not set by the caller.
    const subject = await prisma.user.findUniqueOrThrow({ where: { id: user.user_id } });
    expect(subject.is_verified).toBe(true);

    // Audited: this decision gates a hard discovery filter, so who approved it
    // has to be answerable later.
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { target_id: record.id },
    });
    expect(audit.admin_id).toBe(moderator.user_id);
    expect(audit.action).toBe('verification.approve');
    expect(audit.target_type).toBe('verification');

    // And the person who was waiting is told, in the feed rather than only as
    // a banner (spec §7).
    const notification = await prisma.notification.findFirstOrThrow({
      where: { user_id: user.user_id, category: 'verification' },
    });
    expect(notification.title).toBe('You are verified');
  });

  it('declines with a reason the user can act on', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(moderator.tokens))
      .send({ approve: false, reason: 'The photo is too blurry to read.' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('rejected');
    expect(response.body.data.is_verified).toBe(false);
    expect(response.body.data.rejection_reason).toBe('The photo is too blurry to read.');

    const subject = await prisma.user.findUniqueOrThrow({ where: { id: user.user_id } });
    expect(subject.is_verified).toBe(false);

    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { target_id: record.id } });
    expect(audit.action).toBe('verification.reject');

    const notification = await prisma.notification.findFirstOrThrow({
      where: { user_id: user.user_id, category: 'verification' },
    });
    expect(notification.body).toBe('The photo is too blurry to read.');
  });

  it('refuses to decline without a reason', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(moderator.tokens))
      .send({ approve: false });

    // A rejection with nothing to act on leaves the user stuck.
    expect(response.status).toBe(400);

    const after = await prisma.verification.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.status).toBe(VerificationStatus.pending);
  });

  it('refuses a reason on an approval', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(moderator.tokens))
      .send({ approve: true, reason: 'looks fine' });

    // It would be stored against a record that was accepted, where nothing
    // would ever show it.
    expect(response.status).toBe(400);
  });

  it('409s on a second decision rather than overwriting the first', async () => {
    const first = await createAuthenticatedUser({ role: 'moderator' });
    const second = await createAuthenticatedUser({ role: 'admin' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(first.tokens))
      .send({ approve: true });

    // Two reviewers opening the same queue is the normal case, not an edge one.
    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(second.tokens))
      .send({ approve: false, reason: 'changed my mind' });

    expect(response.status).toBe(409);

    const after = await prisma.verification.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.status).toBe(VerificationStatus.approved);
    expect(after.reviewed_by_id).toBe(first.user_id);

    // And only the decision that landed was audited.
    expect(await prisma.adminAuditLog.count({ where: { target_id: record.id } })).toBe(1);
  });

  it('404s for a verification that does not exist', async () => {
    const moderator = await createAuthenticatedUser({ role: 'moderator' });

    const response = await api
      .post(`${VERIFICATION}/00000000-0000-4000-8000-000000000000/review`)
      .set(authHeader(moderator.tokens))
      .send({ approve: true });

    expect(response.status).toBe(404);
  });

  it('lets an admin decide as well as a moderator', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const user = await createAuthenticatedUser();
    const record = await submittedVerification(user.user_id);

    const response = await api
      .post(`${VERIFICATION}/${record.id}/review`)
      .set(authHeader(admin.tokens))
      .send({ approve: true });

    expect(response.status).toBe(200);
  });
});
