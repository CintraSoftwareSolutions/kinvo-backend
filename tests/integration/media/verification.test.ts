import { prisma } from '@/db/prisma';
import { BUCKETS } from '@/providers/s3.provider';
import { reviewVerification } from '@modules/media/verification.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { VERIFICATION_BASE, uploadFile } from '../../helpers/media';

/**
 * Identity verification (spec §7, Batch 4): three methods, a three-step wizard,
 * and the badge derived from the latest approved record.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function startVerification(tokens: Parameters<typeof authHeader>[0], method = 'photo') {
  return api.post(VERIFICATION_BASE).set(authHeader(tokens)).send({ method });
}

describe('GET /verification', () => {
  it('reports not-started for a fresh account', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(VERIFICATION_BASE).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: null,
      method: null,
      status: 'not_started',
      current_step: 0,
      total_steps: 3,
      is_verified: false,
    });
  });

  it('requires authentication', async () => {
    const response = await api.get(VERIFICATION_BASE);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('POST /verification', () => {
  it.each(['photo', 'government_id', 'social'])('starts a %s verification', async (method) => {
    const { tokens } = await createAuthenticatedUser();

    const response = await startVerification(tokens, method);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      method,
      status: 'pending',
      current_step: 1,
      total_steps: 3,
    });
  });

  it('rejects an unknown method', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await startVerification(tokens, 'passport_selfie');

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('method');
  });

  it('refuses a second attempt while one is pending', async () => {
    const { tokens } = await createAuthenticatedUser();
    await startVerification(tokens);

    const second = await startVerification(tokens);

    // Otherwise a user could flood the moderation queue by tapping repeatedly.
    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, 'CONFLICT');
  });

  it('refuses when the account is already verified', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    const started = await startVerification(tokens);
    const reviewer = await createAuthenticatedUser({ role: 'admin' });

    await reviewVerification({
      verificationId: started.body.data.id as string,
      reviewerId: reviewer.user_id,
      approve: true,
    });

    const again = await startVerification(tokens);
    expect(again.status).toBe(409);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.is_verified).toBe(true);
  });
});

describe('the three-step wizard', () => {
  it('advances to step 2 when a document is attached', async () => {
    const { tokens } = await createAuthenticatedUser();
    const started = await startVerification(tokens, 'government_id');
    const document = await uploadFile(tokens, { purpose: 'verification_document' });

    const response = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/document`)
      .set(authHeader(tokens))
      .send({ upload_id: document.upload_id });

    expect(response.status).toBe(200);
    expect(response.body.data.current_step).toBe(2);
  });

  it('stores the document in the stricter bucket, never with profile photos', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    const started = await startVerification(tokens, 'government_id');
    const document = await uploadFile(tokens, { purpose: 'verification_document' });

    await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/document`)
      .set(authHeader(tokens))
      .send({ upload_id: document.upload_id });

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { owner_id: userId, kind: 'verification_document' },
    });

    // Government ID images are the most sensitive data in the system.
    expect(asset.s3_bucket).toBe(BUCKETS.VERIFICATION);
  });

  it('refuses a profile photo as a verification document', async () => {
    const { tokens } = await createAuthenticatedUser();
    const started = await startVerification(tokens, 'government_id');
    const photo = await uploadFile(tokens, { purpose: 'profile_photo' });

    const response = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/document`)
      .set(authHeader(tokens))
      .send({ upload_id: photo.upload_id });

    expect(response.status).toBe(404);
  });

  it('reaches step 3 on submit', async () => {
    const { tokens } = await createAuthenticatedUser();
    const started = await startVerification(tokens, 'government_id');
    const document = await uploadFile(tokens, { purpose: 'verification_document' });

    await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/document`)
      .set(authHeader(tokens))
      .send({ upload_id: document.upload_id });

    const response = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/submit`)
      .set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.current_step).toBe(3);
    expect(response.body.data.submitted_at).toEqual(expect.any(String));
  });

  it('refuses to submit a document-based method with no document', async () => {
    const { tokens } = await createAuthenticatedUser();
    const started = await startVerification(tokens, 'government_id');

    const response = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/submit`)
      .set(authHeader(tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'BAD_REQUEST');
  });

  it('lets the social method submit without a document', async () => {
    const { tokens } = await createAuthenticatedUser();
    const started = await startVerification(tokens, 'social');

    const response = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/submit`)
      .set(authHeader(tokens));

    expect(response.status).toBe(200);
  });

  it("cannot touch another user's verification", async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();
    const started = await startVerification(owner.tokens, 'social');

    const submit = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/submit`)
      .set(authHeader(stranger.tokens));

    expect(submit.status).toBe(404);

    const document = await uploadFile(stranger.tokens, { purpose: 'verification_document' });
    const attach = await api
      .post(`${VERIFICATION_BASE}/${started.body.data.id as string}/document`)
      .set(authHeader(stranger.tokens))
      .send({ upload_id: document.upload_id });

    expect(attach.status).toBe(404);
  });
});

describe('the badge is derived, not asserted', () => {
  it('sets is_verified when a review approves', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    const reviewer = await createAuthenticatedUser({ role: 'admin' });
    const started = await startVerification(tokens, 'social');

    await reviewVerification({
      verificationId: started.body.data.id as string,
      reviewerId: reviewer.user_id,
      approve: true,
    });

    const status = await api.get(VERIFICATION_BASE).set(authHeader(tokens));
    expect(status.body.data.is_verified).toBe(true);
    expect(status.body.data.status).toBe('approved');

    // The denormalised flag the deck filters and ranks on stays in step.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.is_verified).toBe(true);
  });

  it('leaves is_verified false when a review rejects, and gives a reason', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    const reviewer = await createAuthenticatedUser({ role: 'admin' });
    const started = await startVerification(tokens, 'social');

    await reviewVerification({
      verificationId: started.body.data.id as string,
      reviewerId: reviewer.user_id,
      approve: false,
      rejectionReason: 'The photo was too blurry to read.',
    });

    const status = await api.get(VERIFICATION_BASE).set(authHeader(tokens));
    expect(status.body.data.status).toBe('rejected');
    expect(status.body.data.is_verified).toBe(false);
    expect(status.body.data.rejection_reason).toBe('The photo was too blurry to read.');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.is_verified).toBe(false);
  });

  it('lets a rejected user try again', async () => {
    const { tokens } = await createAuthenticatedUser();
    const reviewer = await createAuthenticatedUser({ role: 'admin' });
    const started = await startVerification(tokens, 'social');

    await reviewVerification({
      verificationId: started.body.data.id as string,
      reviewerId: reviewer.user_id,
      approve: false,
    });

    const retry = await startVerification(tokens, 'photo');
    expect(retry.status).toBe(201);
  });

  it('refuses to review the same record twice', async () => {
    const { tokens } = await createAuthenticatedUser();
    const reviewer = await createAuthenticatedUser({ role: 'admin' });
    const started = await startVerification(tokens, 'social');
    const verificationId = started.body.data.id as string;

    await reviewVerification({ verificationId, reviewerId: reviewer.user_id, approve: true });

    await expect(
      reviewVerification({ verificationId, reviewerId: reviewer.user_id, approve: false }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('never leaks a rejection reason to another user', async () => {
    const subject = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();
    const reviewer = await createAuthenticatedUser({ role: 'admin' });
    const started = await startVerification(subject.tokens, 'social');

    await reviewVerification({
      verificationId: started.body.data.id as string,
      reviewerId: reviewer.user_id,
      approve: false,
      rejectionReason: 'Document appeared altered.',
    });

    // A stranger sees only their own (empty) verification state.
    const asStranger = await api.get(VERIFICATION_BASE).set(authHeader(stranger.tokens));
    expect(JSON.stringify(asStranger.body)).not.toContain('altered');
  });
});
