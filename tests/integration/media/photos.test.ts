import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { MAX_PHOTOS } from '@modules/media/photos.service';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { MEDIA_BASE, addPhoto, uploadFile } from '../../helpers/media';

/** Profile photos (spec §7, Batch 4: CRUD, reorder, set primary, max 6). */

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('POST /media/photos', () => {
  it('attaches a completed upload and makes the first one primary', async () => {
    const { tokens } = await createAuthenticatedUser();

    const photo = await addPhoto(tokens);

    expect(photo).toMatchObject({
      id: expect.any(String),
      position: 0,
      is_primary: true,
      url: expect.stringContaining('http'),
    });
  });

  it('does not make later photos primary', async () => {
    const { tokens } = await createAuthenticatedUser();

    await addPhoto(tokens);
    const second = await addPhoto(tokens);

    expect(second.position).toBe(1);
    expect(second.is_primary).toBe(false);
  });

  it('refuses an upload that never completed', async () => {
    const { tokens } = await createAuthenticatedUser();

    const ticket = await api
      .post(`${MEDIA_BASE}/uploads`)
      .set(authHeader(tokens))
      .send({ purpose: 'profile_photo', mime_type: 'image/png', size_bytes: 100 });

    const response = await api
      .post(`${MEDIA_BASE}/photos`)
      .set(authHeader(tokens))
      .send({ upload_id: ticket.body.data.upload_id });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'BAD_REQUEST');
  });

  it('refuses a verification document dressed up as a profile photo', async () => {
    const { tokens } = await createAuthenticatedUser();

    const document = await uploadFile(tokens, { purpose: 'verification_document' });

    const response = await api
      .post(`${MEDIA_BASE}/photos`)
      .set(authHeader(tokens))
      .send({ upload_id: document.upload_id });

    // The kind is checked, so an ID document cannot be promoted into the
    // public photo table — and out of the stricter bucket's protection.
    expect(response.status).toBe(404);
  });

  it("refuses another user's upload", async () => {
    const owner = await createAuthenticatedUser();
    const stranger = await createAuthenticatedUser();

    const asset = await uploadFile(owner.tokens);

    const response = await api
      .post(`${MEDIA_BASE}/photos`)
      .set(authHeader(stranger.tokens))
      .send({ upload_id: asset.upload_id });

    expect(response.status).toBe(404);
  });

  it('refuses the same upload twice', async () => {
    const { tokens } = await createAuthenticatedUser();
    const asset = await uploadFile(tokens);

    await api
      .post(`${MEDIA_BASE}/photos`)
      .set(authHeader(tokens))
      .send({ upload_id: asset.upload_id });

    const second = await api
      .post(`${MEDIA_BASE}/photos`)
      .set(authHeader(tokens))
      .send({ upload_id: asset.upload_id });

    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, 'CONFLICT');
  });

  it(`enforces the ${MAX_PHOTOS}-photo maximum`, async () => {
    const { tokens } = await createAuthenticatedUser();

    for (let index = 0; index < MAX_PHOTOS; index += 1) {
      await addPhoto(tokens);
    }

    const asset = await uploadFile(tokens);
    const response = await api
      .post(`${MEDIA_BASE}/photos`)
      .set(authHeader(tokens))
      .send({ upload_id: asset.upload_id });

    expect(response.status).toBe(409);
    expect(response.body.error.details.max_photos).toBe(MAX_PHOTOS);
  });
});

describe('GET /media/photos', () => {
  it('returns an empty array, never null, when there are none', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(`${MEDIA_BASE}/photos`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.photos).toEqual([]);
    expect(response.body.data.max_photos).toBe(MAX_PHOTOS);
  });

  it('returns photos in position order with working URLs', async () => {
    const { tokens } = await createAuthenticatedUser();
    await addPhoto(tokens);
    await addPhoto(tokens);

    const response = await api.get(`${MEDIA_BASE}/photos`).set(authHeader(tokens));

    expect(response.body.data.photos.map((p: { position: number }) => p.position)).toEqual([0, 1]);

    const fetched = await fetch(response.body.data.photos[0].url as string);
    expect(fetched.status).toBe(200);
  });

  it("never returns another user's photos", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();
    await addPhoto(alice.tokens);

    const response = await api.get(`${MEDIA_BASE}/photos`).set(authHeader(bob.tokens));

    expect(response.body.data.photos).toEqual([]);
  });
});

describe('DELETE /media/photos/:id', () => {
  it('removes the photo and closes the gap in positions', async () => {
    const { tokens } = await createAuthenticatedUser();
    const first = await addPhoto(tokens);
    await addPhoto(tokens);
    await addPhoto(tokens);

    const response = await api
      .delete(`${MEDIA_BASE}/photos/${first.id as string}`)
      .set(authHeader(tokens));

    expect(response.status).toBe(200);

    const list = await api.get(`${MEDIA_BASE}/photos`).set(authHeader(tokens));
    expect(list.body.data.photos).toHaveLength(2);
    // No holes: positions stay 0..n-1.
    expect(list.body.data.photos.map((p: { position: number }) => p.position)).toEqual([0, 1]);
  });

  it('promotes the next photo when the primary is deleted', async () => {
    const { tokens } = await createAuthenticatedUser();
    const first = await addPhoto(tokens);
    await addPhoto(tokens);

    await api.delete(`${MEDIA_BASE}/photos/${first.id as string}`).set(authHeader(tokens));

    const list = await api.get(`${MEDIA_BASE}/photos`).set(authHeader(tokens));
    // A profile with photos but no primary renders a blank deck card.
    expect(list.body.data.photos[0].is_primary).toBe(true);
  });

  it('soft-deletes, keeping the row for moderation history', async () => {
    const { tokens } = await createAuthenticatedUser();
    const photo = await addPhoto(tokens);

    await api.delete(`${MEDIA_BASE}/photos/${photo.id as string}`).set(authHeader(tokens));

    const stored = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id as string } });
    expect(stored.deleted_at).toBeInstanceOf(Date);
  });

  it('frees the position for reuse', async () => {
    const { tokens } = await createAuthenticatedUser();
    const photo = await addPhoto(tokens);

    await api.delete(`${MEDIA_BASE}/photos/${photo.id as string}`).set(authHeader(tokens));

    // The partial unique index excludes soft-deleted rows, so position 0 is
    // available again rather than permanently occupied.
    const replacement = await addPhoto(tokens);
    expect(replacement.position).toBe(0);
    expect(replacement.is_primary).toBe(true);
  });

  it("returns 404 for another user's photo", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();
    const photo = await addPhoto(alice.tokens);

    const response = await api
      .delete(`${MEDIA_BASE}/photos/${photo.id as string}`)
      .set(authHeader(bob.tokens));

    expect(response.status).toBe(404);

    const stored = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id as string } });
    expect(stored.deleted_at).toBeNull();
  });
});

describe('PATCH /media/photos/reorder', () => {
  it('reorders to exactly the requested sequence', async () => {
    const { tokens } = await createAuthenticatedUser();
    const a = await addPhoto(tokens);
    const b = await addPhoto(tokens);
    const c = await addPhoto(tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/reorder`)
      .set(authHeader(tokens))
      .send({ photo_ids: [c.id, a.id, b.id] });

    expect(response.status).toBe(200);
    expect(response.body.data.photos.map((p: { id: string }) => p.id)).toEqual([c.id, a.id, b.id]);
  });

  it('makes the new first photo primary', async () => {
    const { tokens } = await createAuthenticatedUser();
    const a = await addPhoto(tokens);
    const b = await addPhoto(tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/reorder`)
      .set(authHeader(tokens))
      .send({ photo_ids: [b.id, a.id] });

    expect(response.body.data.photos[0].id).toBe(b.id);
    expect(response.body.data.photos[0].is_primary).toBe(true);
    expect(response.body.data.photos[1].is_primary).toBe(false);
  });

  it('rejects a partial list', async () => {
    const { tokens } = await createAuthenticatedUser();
    const a = await addPhoto(tokens);
    await addPhoto(tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/reorder`)
      .set(authHeader(tokens))
      .send({ photo_ids: [a.id] });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('photo_ids');
  });

  it('rejects duplicates in the list', async () => {
    const { tokens } = await createAuthenticatedUser();
    const a = await addPhoto(tokens);
    await addPhoto(tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/reorder`)
      .set(authHeader(tokens))
      .send({ photo_ids: [a.id, a.id] });

    expect(response.status).toBe(400);
  });

  it("rejects a list containing another user's photo", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();
    const alicePhoto = await addPhoto(alice.tokens);
    await addPhoto(bob.tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/reorder`)
      .set(authHeader(bob.tokens))
      .send({ photo_ids: [alicePhoto.id] });

    expect(response.status).toBe(400);
  });
});

describe('PATCH /media/photos/:id/primary', () => {
  it('promotes the chosen photo and demotes the rest', async () => {
    const { tokens } = await createAuthenticatedUser();
    await addPhoto(tokens);
    const second = await addPhoto(tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/${second.id as string}/primary`)
      .set(authHeader(tokens));

    expect(response.status).toBe(200);

    const primaries = response.body.data.photos.filter(
      (p: { is_primary: boolean }) => p.is_primary,
    );
    // Exactly one primary at all times — enforced by a partial unique index.
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(second.id);
  });

  it("returns 404 for another user's photo", async () => {
    const alice = await createAuthenticatedUser();
    const bob = await createAuthenticatedUser();
    const photo = await addPhoto(alice.tokens);

    const response = await api
      .patch(`${MEDIA_BASE}/photos/${photo.id as string}/primary`)
      .set(authHeader(bob.tokens));

    expect(response.status).toBe(404);
  });
});

describe('photos on the public profile (spec §4.7)', () => {
  it('surfaces the primary photo in user_compact', async () => {
    const alice = await createAuthenticatedUser();
    const viewer = await createAuthenticatedUser();
    await addPhoto(alice.tokens);

    const response = await api
      .get(`${API_PREFIX}/users/${alice.user_id}`)
      .set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.user.primary_photo_url).toEqual(expect.stringContaining('http'));
  });

  it('returns null rather than omitting the key when there is no photo', async () => {
    const alice = await createAuthenticatedUser();
    const viewer = await createAuthenticatedUser();

    // A profile row has to exist to be viewable; onboarding creates one, and
    // this stands in for that without adding a photo.
    await api
      .patch(`${API_PREFIX}/users/me`)
      .set(authHeader(alice.tokens))
      .send({ bio: 'No photos yet.' });

    const response = await api
      .get(`${API_PREFIX}/users/${alice.user_id}`)
      .set(authHeader(viewer.tokens));

    // spec §4.6: return null, never omit.
    expect(response.body.data.user).toHaveProperty('primary_photo_url', null);
  });

  it('hides a photo that moderation has not approved (spec §4.8)', async () => {
    const alice = await createAuthenticatedUser();
    const viewer = await createAuthenticatedUser();
    const photo = await addPhoto(alice.tokens);

    await prisma.photo.update({
      where: { id: photo.id as string },
      data: { moderation_status: 'pending' },
    });

    const response = await api
      .get(`${API_PREFIX}/users/${alice.user_id}`)
      .set(authHeader(viewer.tokens));

    // Pending media is visible to its owner and nobody else.
    expect(response.body.data.user.primary_photo_url).toBeNull();

    const own = await api.get(`${MEDIA_BASE}/photos`).set(authHeader(alice.tokens));
    expect(own.body.data.photos[0].url).toEqual(expect.stringContaining('http'));
  });
});
