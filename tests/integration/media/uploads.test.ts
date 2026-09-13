import { prisma } from '@/db/prisma';
import { BUCKETS } from '@/providers/s3.provider';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { MEDIA_BASE, TINY_PNG, uploadFile } from '../../helpers/media';

/**
 * The upload handshake (spec §4.8).
 *
 * Runs against the MinIO container, so the presigning, the direct PUT, and the
 * private-bucket policy are all real.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('POST /media/uploads', () => {
  it('issues a presigned URL the client can PUT to directly', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: TINY_PNG.byteLength });

    expect(response.status).toBe(201);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toEqual({
      upload_id: expect.any(String),
      purpose: 'profile_photo',
      url: expect.stringContaining('http'),
      headers: expect.objectContaining({ 'Content-Type': 'image/png' }),
      expires_at: expect.any(String),
    });
  });

  it('records the intent as not-yet-uploaded', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 100 });

    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });

    // Until storage confirms the bytes, this is an intent and nothing may use it.
    expect(asset.uploaded_at).toBeNull();
  });

  it('sends verification documents to the separate private bucket (spec §7 Batch 4)', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'verification_document', mime_type: 'image/png', size_bytes: 100 });

    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });

    // Government ID images must never share a bucket policy with selfies.
    expect(asset.s3_bucket).toBe(BUCKETS.VERIFICATION);
    expect(asset.s3_bucket).not.toBe(BUCKETS.MEDIA);
  });

  it('sends profile photos to the media bucket', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 100 });

    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });
    expect(asset.s3_bucket).toBe(BUCKETS.MEDIA);
  });

  it('namespaces the object key by purpose and owner, ending in randomness', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 100 });

    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });

    // A guessable key plus any future bucket misconfiguration is enumerable
    // private media.
    expect(asset.s3_key).toMatch(new RegExp(`^profile_photo/${userId}/[0-9a-f-]{36}\\.png$`));
  });

  describe('policy enforcement', () => {
    it('refuses an unsupported type with 415, not a generic failure', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .post(`${MEDIA_BASE}/uploads`)
        .set(authHeader(tokens))
        .send({ purpose: 'profile_photo', mime_type: 'application/zip', size_bytes: 100 });

      expect(response.status).toBe(415);
      expectErrorEnvelope(response.body, 'UNSUPPORTED_MEDIA_TYPE');
      expect(response.body.error.details.allowed_mime_types).toContain('image/jpeg');
    });

    it('refuses an oversized file with 413 and states the limit', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .post(`${MEDIA_BASE}/uploads`)
        .set(authHeader(tokens))
        .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 50 * 1024 * 1024 });

      expect(response.status).toBe(413);
      expectErrorEnvelope(response.body, 'FILE_TOO_LARGE');
      expect(response.body.error.details.max_bytes).toBe(10 * 1024 * 1024);
    });

    it('will not let a video masquerade as a profile photo', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .post(`${MEDIA_BASE}/uploads`)
        .set(authHeader(tokens))
        .send({ purpose: 'profile_photo', mime_type: 'video/mp4', size_bytes: 100 });

      expect(response.status).toBe(415);
    });

    it('requires a duration for a voice note (spec §5.4)', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .post(`${MEDIA_BASE}/uploads`)
        .set(authHeader(tokens))
        .send({ purpose: 'voice_note', mime_type: 'audio/mpeg', size_bytes: 1000 });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('duration_ms');
    });

    it('accepts a voice note with a duration', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api.post(`${MEDIA_BASE}/uploads`).set(authHeader(tokens)).send({
        purpose: 'voice_note',
        mime_type: 'audio/mpeg',
        size_bytes: 1000,
        duration_ms: 30_000,
      });

      expect(response.status).toBe(201);
    });

    it('refuses a voice note longer than the limit', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .post(`${MEDIA_BASE}/uploads`)
        .set(authHeader(tokens))
        .send({
          purpose: 'voice_note',
          mime_type: 'audio/mpeg',
          size_bytes: 1000,
          duration_ms: 10 * 60 * 1000,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('duration_ms');
    });

    it('rejects an unknown purpose at validation', async () => {
      const { tokens } = await createAuthenticatedUser();

      const response = await api
        .post(`${MEDIA_BASE}/uploads`)
        .set(authHeader(tokens))
        .send({ purpose: 'something_else', mime_type: 'image/png', size_bytes: 100 });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('purpose');
    });
  });

  it('requires authentication', async () => {
    const response = await api
      .post(`${MEDIA_BASE}/uploads`)
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 100 });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });
});

describe('POST /media/uploads/:id/complete', () => {
  it('confirms the upload once the bytes are really there', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    const asset = await uploadFile(tokens);

    const stored = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });
    expect(stored.uploaded_at).toBeInstanceOf(Date);
    expect(stored.id).toBe(asset.upload_id);
  });

  it('refuses to complete an upload whose bytes never arrived', async () => {
    const { tokens } = await createAuthenticatedUser();

    const ticket = await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 100 });

    // The client claims it finished without ever PUTting anything. That claim
    // is not evidence — the server asks storage.
    const response = await api
      .post(`${MEDIA_BASE}/uploads/${ticket.body.data.upload_id}/complete`)
      .set(authHeader(tokens));

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'BAD_REQUEST');
  });

  it('records the size storage actually saw, not the one that was declared', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await uploadFile(tokens);

    const stored = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });
    expect(stored.size_bytes).toBe(TINY_PNG.byteLength);
  });

  it('is idempotent', async () => {
    const { tokens } = await createAuthenticatedUser();
    const asset = await uploadFile(tokens);

    const second = await api
      .post(`${MEDIA_BASE}/uploads/${asset.upload_id}/complete`)
      .set(authHeader(tokens));

    expect(second.status).toBe(200);
    expect(second.body.data.is_uploaded).toBe(true);
  });

  it("returns 404 for another user's upload, never 403", async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();

    const asset = await uploadFile(owner.tokens);

    const response = await api
      .post(`${MEDIA_BASE}/uploads/${asset.upload_id}/complete`)
      .set(authHeader(stranger.tokens));

    // A 403 would confirm the upload exists.
    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });
});

describe('GET /media/uploads/:id/url', () => {
  it('mints a working time-limited URL for the owner', async () => {
    const { tokens } = await createAuthenticatedUser();
    const asset = await uploadFile(tokens);

    const response = await api
      .get(`${MEDIA_BASE}/uploads/${asset.upload_id}/url`)
      .set(authHeader(tokens));

    expect(response.status).toBe(200);

    const fetched = await fetch(response.body.data.url as string);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(TINY_PNG);
  });

  it("refuses another user's asset with 404", async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();
    const asset = await uploadFile(owner.tokens);

    const response = await api
      .get(`${MEDIA_BASE}/uploads/${asset.upload_id}/url`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
  });
});

describe('object privacy', () => {
  it('denies an unsigned read of an uploaded object', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    await uploadFile(tokens);

    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { owner_id: userId } });

    // The bucket is private. Without a signature there is no access, which is
    // what makes presigned URLs the only route to any media.
    const direct = await fetch(`http://localhost:9100/${asset.s3_bucket}/${asset.s3_key}`);
    expect(direct.status).toBe(403);
  });
});

describe('DELETE /media/uploads/:id', () => {
  it('soft-deletes the record and removes the bytes', async () => {
    const { tokens } = await createAuthenticatedUser();
    const asset = await uploadFile(tokens);

    const response = await api
      .delete(`${MEDIA_BASE}/uploads/${asset.upload_id}`)
      .set(authHeader(tokens));

    expect(response.status).toBe(200);

    const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.upload_id } });
    // Row retained for audit; bytes gone.
    expect(stored.deleted_at).toBeInstanceOf(Date);

    const urlResponse = await api
      .get(`${MEDIA_BASE}/uploads/${asset.upload_id}/url`)
      .set(authHeader(tokens));
    expect(urlResponse.status).toBe(404);
  });

  it("cannot delete another user's asset", async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();
    const asset = await uploadFile(owner.tokens);

    const response = await api
      .delete(`${MEDIA_BASE}/uploads/${asset.upload_id}`)
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);

    const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.upload_id } });
    expect(stored.deleted_at).toBeNull();
  });
});
