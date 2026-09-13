import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { getProfileCoordinates } from '@/db/geo';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';
import { LONDON } from '../../helpers/factories';
import { addPhoto } from '../../helpers/media';

const USERS = `${API_PREFIX}/users`;

beforeEach(async () => {
  await resetDatabase();
  await seedCatalogue();
});
afterAll(closeDatabase);

/** A minimal interest and prompt catalogue; the dev seed does not run in tests. */
async function seedCatalogue() {
  await prisma.interest.createMany({
    data: [
      { slug: 'music', label: 'Music', category: 'general', modes: ['dating'] },
      { slug: 'running', label: 'Running', category: 'fitness', modes: ['fitness'] },
      { slug: 'coffee', label: 'Coffee', category: 'food', modes: ['foodie'] },
      { slug: 'inactive', label: 'Retired', category: 'general', modes: [], is_active: false },
    ],
  });

  await prisma.promptQuestion.createMany({
    data: [
      { slug: 'weekend', question: 'A perfect weekend looks like…', modes: ['dating'] },
      { slug: 'talk_hours', question: 'I could talk for hours about…', modes: ['dating'] },
    ],
  });
}

describe('GET /users/me', () => {
  it('returns the caller profile, creating one if the signup never made it', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser({ display_name: 'Sarah' });

    const response = await api.get(`${USERS}/me`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data).toMatchObject({
      user_id: userId,
      display_name: 'Sarah',
      bio: null,
      completion_percentage: expect.any(Number),
      interests: [],
      prompts: [],
    });
  });

  it('returns null for unset fields rather than omitting the keys (spec §4.6)', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.get(`${USERS}/me`).set(authHeader(tokens));

    for (const key of ['bio', 'job_title', 'organisation', 'education', 'height_cm', 'location']) {
      expect(response.body.data).toHaveProperty(key, null);
    }
  });

  it('requires authentication', async () => {
    const response = await api.get(`${USERS}/me`);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_REQUIRED');
  });

  it('works for a pending user, who must be able to finish onboarding', async () => {
    const { tokens } = await createAuthenticatedUser({ status: 'pending', onboarded: false });

    const response = await api.get(`${USERS}/me`).set(authHeader(tokens));

    expect(response.status).toBe(200);
  });
});

describe('PATCH /users/me', () => {
  it('updates the fields it is given and leaves the rest alone', async () => {
    const { tokens } = await createAuthenticatedUser({ display_name: 'Sarah' });

    await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ bio: 'Product designer. Will argue about typography.', job_title: 'Designer' });

    const response = await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ organisation: 'Foundry' });

    expect(response.body.data.bio).toBe('Product designer. Will argue about typography.');
    expect(response.body.data.job_title).toBe('Designer');
    expect(response.body.data.organisation).toBe('Foundry');
    expect(response.body.data.display_name).toBe('Sarah');
  });

  it('clears a field when sent null, which is different from omitting it', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api.patch(`${USERS}/me`).set(authHeader(tokens)).send({ job_title: 'Designer' });
    const cleared = await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ job_title: null });

    expect(cleared.body.data.job_title).toBeNull();
  });

  it('validates lifestyle enums against the allowed set', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ diet: 'carnivore-only' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('diet');
  });

  it('rejects an over-long bio', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ bio: 'x'.repeat(501) });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('bio');
  });

  it('rejects an empty body', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.patch(`${USERS}/me`).set(authHeader(tokens)).send({});

    expect(response.status).toBe(400);
  });

  it("cannot touch another user's profile — there is no id to tamper with", async () => {
    const alice = await createAuthenticatedUser({ display_name: 'Alice' });
    const bob = await createAuthenticatedUser({ display_name: 'Bob' });

    await api.patch(`${USERS}/me`).set(authHeader(alice.tokens)).send({ bio: 'Alice was here' });

    const bobProfile = await api.get(`${USERS}/me`).set(authHeader(bob.tokens));
    expect(bobProfile.body.data.bio).toBeNull();
  });
});

describe('PATCH /users/me/location', () => {
  it('writes a PostGIS point and reports it back', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api.patch(`${USERS}/me/location`).set(authHeader(tokens)).send({
      longitude: LONDON.longitude,
      latitude: LONDON.latitude,
      city: 'London',
      country: 'gb',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.location.longitude).toBeCloseTo(LONDON.longitude, 5);
    expect(response.body.data.location.latitude).toBeCloseTo(LONDON.latitude, 5);
    expect(response.body.data.city).toBe('London');
    expect(response.body.data.country).toBe('GB');
    expect(response.body.data.location_updated_at).toEqual(expect.any(String));
  });

  it('actually persists to the geography column', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await api
      .patch(`${USERS}/me/location`)
      .set(authHeader(tokens))
      .send({ longitude: LONDON.longitude, latitude: LONDON.latitude });

    const profile = await prisma.profile.findUniqueOrThrow({ where: { user_id: userId } });
    const stored = await getProfileCoordinates(profile.id);

    expect(stored?.latitude).toBeCloseTo(LONDON.latitude, 5);
  });

  it('rejects coordinates outside the valid range', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .patch(`${USERS}/me/location`)
      .set(authHeader(tokens))
      .send({ longitude: 200, latitude: 0 });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('longitude');
  });
});

describe('PUT /users/me/interests', () => {
  it('replaces the set wholesale', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['music', 'running'] });

    const response = await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['coffee'] });

    expect(response.body.data.interests.map((i: { slug: string }) => i.slug)).toEqual(['coffee']);
  });

  it('rejects an unknown slug and changes nothing', async () => {
    const { tokens } = await createAuthenticatedUser();
    await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['music'] });

    const response = await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['music', 'not-a-real-interest'] });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('interests');

    const after = await api.get(`${USERS}/me`).set(authHeader(tokens));
    expect(after.body.data.interests).toHaveLength(1);
  });

  it('refuses an interest that has been retired', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['inactive'] });

    expect(response.status).toBe(400);
  });

  it('deduplicates repeats', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['music', 'music', 'music'] });

    expect(response.body.data.interests).toHaveLength(1);
  });

  it('accepts an empty list as "clear them all"', async () => {
    const { tokens } = await createAuthenticatedUser();
    await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['music'] });

    const response = await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: [] });

    expect(response.body.data.interests).toEqual([]);
  });
});

describe('PUT /users/me/prompts', () => {
  it('stores answers in the order given', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .put(`${USERS}/me/prompts`)
      .set(authHeader(tokens))
      .send({
        prompts: [
          { slug: 'weekend', answer: 'A long walk and a longer lunch.' },
          { slug: 'talk_hours', answer: 'Typography.' },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.prompts).toHaveLength(2);
    expect(response.body.data.prompts[0]).toMatchObject({ slug: 'weekend', position: 0 });
    expect(response.body.data.prompts[1]).toMatchObject({ slug: 'talk_hours', position: 1 });
  });

  it('refuses the same prompt twice', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .put(`${USERS}/me/prompts`)
      .set(authHeader(tokens))
      .send({
        prompts: [
          { slug: 'weekend', answer: 'One.' },
          { slug: 'weekend', answer: 'Two.' },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('prompts');
  });

  it('rejects an unknown prompt', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .put(`${USERS}/me/prompts`)
      .set(authHeader(tokens))
      .send({ prompts: [{ slug: 'nope', answer: 'Something.' }] });

    expect(response.status).toBe(400);
  });

  it('rejects an over-long answer', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .put(`${USERS}/me/prompts`)
      .set(authHeader(tokens))
      .send({ prompts: [{ slug: 'weekend', answer: 'x'.repeat(301) }] });

    expect(response.status).toBe(400);
  });
});

describe('profile completion percentage', () => {
  it('starts at zero and climbs as the profile fills in', async () => {
    const { tokens } = await createAuthenticatedUser();

    const empty = await api.get(`${USERS}/me`).set(authHeader(tokens));
    expect(empty.body.data.completion_percentage).toBe(0);

    await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ bio: 'A bio that is comfortably longer than twenty characters.' });

    const withBio = await api.get(`${USERS}/me`).set(authHeader(tokens));
    expect(withBio.body.data.completion_percentage).toBeGreaterThan(0);
  });

  it('reaches 100 for a fully filled profile', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api.patch(`${USERS}/me`).set(authHeader(tokens)).send({
      bio: 'A bio that is comfortably longer than twenty characters.',
      job_title: 'Designer',
      organisation: 'Foundry',
      education: 'undergraduate',
      drinking: 'socially',
      smoking: 'never',
      exercise: 'often',
    });
    await api
      .patch(`${USERS}/me/location`)
      .set(authHeader(tokens))
      .send({ longitude: LONDON.longitude, latitude: LONDON.latitude });
    await api
      .put(`${USERS}/me/interests`)
      .set(authHeader(tokens))
      .send({ interests: ['music', 'running', 'coffee'] });
    await api
      .put(`${USERS}/me/prompts`)
      .set(authHeader(tokens))
      .send({ prompts: [{ slug: 'weekend', answer: 'A long walk.' }] });
    // Batch 4 added a photo criterion. Because the score is normalised over
    // whatever criteria exist, adding one re-weighted the rest rather than
    // capping the achievable total — but 100 now genuinely requires a photo.
    await addPhoto(tokens);

    const response = await api.get(`${USERS}/me`).set(authHeader(tokens));
    expect(response.body.data.completion_percentage).toBe(100);
  });

  it('is persisted, not recomputed on read', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    await api
      .patch(`${USERS}/me`)
      .set(authHeader(tokens))
      .send({ bio: 'A bio that is comfortably longer than twenty characters.' });

    const stored = await prisma.profile.findUniqueOrThrow({ where: { user_id: userId } });
    expect(stored.completion_percentage).toBeGreaterThan(0);
  });
});
