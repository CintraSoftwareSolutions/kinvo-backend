import { API_PREFIX } from '@config/constants';
import { UserStatus, prisma } from '@/db/prisma';
import { connectRedis, disconnectRedis } from '@/db/redis';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD, authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope, expectSuccessEnvelope } from '../../helpers/request';

const USERS = `${API_PREFIX}/users`;
const CONFIG = `${API_PREFIX}/config`;

/**
 * This suite hits /health/ready, which pings Redis. The client is lazy, so the
 * connection must be opened explicitly and — critically — closed again, or the
 * open socket keeps Jest alive after the last assertion and the run hangs
 * rather than failing.
 */
beforeAll(connectRedis);
beforeEach(resetDatabase);
afterAll(async () => {
  await disconnectRedis();
  await closeDatabase();
});

describe('DELETE /users/me', () => {
  it('soft-deletes the account and reports when', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();

    const response = await api.delete(`${USERS}/me`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.data.deleted_at).toEqual(expect.any(String));

    // Soft, not hard: the row survives for moderation history.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.deleted_at).toBeInstanceOf(Date);
    expect(user.status).toBe(UserStatus.deleted);
  });

  it('revokes every session so a live token cannot outlive the account', async () => {
    const { tokens } = await createAuthenticatedUser();

    await api.delete(`${USERS}/me`).set(authHeader(tokens));

    const refresh = await api
      .post(`${AUTH_BASE}/refresh`)
      .send({ refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(401);

    const me = await api.get(`${AUTH_BASE}/me`).set(authHeader(tokens));
    expect(me.status).toBe(401);
    expectErrorEnvelope(me.body, 'AUTH_TOKEN_INVALID');
  });

  it('stops the account signing in again', async () => {
    const { tokens, email } = await createAuthenticatedUser();

    await api.delete(`${USERS}/me`).set(authHeader(tokens));

    const login = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });

    expect(login.status).toBe(401);
    expectErrorEnvelope(login.body, 'AUTH_INVALID_CREDENTIALS');
  });

  it('hides the account from everyone else immediately', async () => {
    const viewer = await createAuthenticatedUser();
    const leaving = await createAuthenticatedUser();
    await prisma.profile.create({ data: { user_id: leaving.user_id } });

    await api.delete(`${USERS}/me`).set(authHeader(leaving.tokens));

    const response = await api.get(`${USERS}/${leaving.user_id}`).set(authHeader(viewer.tokens));
    expect(response.status).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await api.delete(`${USERS}/me`);

    expect(response.status).toBe(401);
  });
});

describe('GET /config (spec §4.12)', () => {
  it('is reachable without a token — the app needs it before sign-in', async () => {
    const response = await api.get(CONFIG);

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
  });

  it('lists all eight modes with their render labels', async () => {
    const response = await api.get(CONFIG);
    const modes = response.body.data.modes as { value: string; primary_action_label: string }[];

    expect(modes.map((mode) => mode.value)).toEqual([
      'dating',
      'study_buddy',
      'networking',
      'trading',
      'foodie',
      'cuddle',
      'pet_dates',
      'fitness',
    ]);

    // The label is the ONLY thing a mode changes about the deck action
    // (spec §1). Serving it from here is what keeps that true without an app
    // release per mode.
    expect(modes.find((mode) => mode.value === 'study_buddy')?.primary_action_label).toBe('Study');
    expect(modes.find((mode) => mode.value === 'trading')?.primary_action_label).toBe('Trade');
  });

  it('serves exactly three deck actions, shared by every mode', async () => {
    const response = await api.get(CONFIG);

    expect(response.body.data.deck_actions).toEqual(['pass', 'like', 'super_like']);
  });

  it('serves the report reasons from spec §5.7', async () => {
    const response = await api.get(CONFIG);
    const values = (response.body.data.report_reasons as { value: string }[]).map((r) => r.value);

    expect(values).toEqual(['harassment', 'fake_profile', 'spam_scam', 'safety_concern']);
  });

  it('serves only active catalogue entries', async () => {
    await prisma.interest.createMany({
      data: [
        { slug: 'live', label: 'Live', category: 'general', modes: ['dating'] },
        { slug: 'retired', label: 'Retired', category: 'general', modes: [], is_active: false },
      ],
    });

    const response = await api.get(CONFIG);
    const slugs = (response.body.data.interests as { slug: string }[]).map((i) => i.slug);

    expect(slugs).toContain('live');
    expect(slugs).not.toContain('retired');
  });

  it('publishes the limits the client needs to build its forms', async () => {
    const response = await api.get(CONFIG);

    expect(response.body.data.limits).toMatchObject({
      max_interests: 10,
      max_prompts: 3,
      max_photos: 6,
      bio_max_length: 500,
      default_page_size: 20,
      max_page_size: 100,
    });
  });
});

describe('GET /health/ready', () => {
  it('reports both dependencies reachable', async () => {
    const response = await api.get(`${API_PREFIX}/health/ready`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'ready', database: true, redis: true });
  });

  it('is separate from liveness, which checks nothing', async () => {
    const liveness = await api.get(`${API_PREFIX}/health`);

    // Wiring the orchestrator's liveness probe to a dependency check turns a
    // brief Postgres blip into a restart loop.
    expect(liveness.body.data).not.toHaveProperty('database');
    expect(liveness.body.data.status).toBe('ok');
  });
});
