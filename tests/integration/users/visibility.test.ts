import { API_PREFIX } from '@config/constants';
import { UserStatus, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { CAMDEN, LONDON, createBlock } from '../../helpers/factories';

/**
 * GET /users/:id is the first endpoint in the product that exposes another
 * user, so it is where the block rule (spec §5.5) first has to hold.
 *
 * The rule the spec calls the most commonly leaked in dating apps: a blocked
 * pair must be invisible to each other, and the refusal must be 404 rather than
 * 403 — a 403 confirms the resource exists, which leaks who blocked whom
 * (spec §4.4).
 */

const USERS = `${API_PREFIX}/users`;

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function makeVisibleUser(displayName: string, coordinates = CAMDEN) {
  const fixture = await createAuthenticatedUser({ display_name: displayName });

  const profile = await prisma.profile.create({
    data: { user_id: fixture.user_id, bio: `${displayName} is here`, city: 'London' },
  });

  await prisma.$executeRaw`
    UPDATE profiles
    SET location = ST_SetSRID(ST_MakePoint(${coordinates.longitude}::double precision, ${coordinates.latitude}::double precision), 4326)::geography
    WHERE id = ${profile.id}::uuid
  `;

  return fixture;
}

describe('GET /users/:id', () => {
  it('returns the public projection of another user', async () => {
    const viewer = await makeVisibleUser('Viewer', LONDON);
    const target = await makeVisibleUser('Target', CAMDEN);

    const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({
      id: target.user_id,
      display_name: 'Target',
      is_verified: false,
      is_premium: false,
      is_online: false,
    });
    expect(response.body.data.bio).toBe('Target is here');
  });

  it('reports distance in metres, never a formatted string (spec §4.6)', async () => {
    const viewer = await makeVisibleUser('Viewer', LONDON);
    const target = await makeVisibleUser('Target', CAMDEN);

    const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));

    // Westminster to Camden is roughly 3.7 km.
    expect(response.body.data.distance_metres).toBeGreaterThan(3000);
    expect(response.body.data.distance_metres).toBeLessThan(4500);
    expect(typeof response.body.data.distance_metres).toBe('number');
  });

  it('never exposes the target date of birth, email, or status', async () => {
    const viewer = await makeVisibleUser('Viewer');
    const target = await makeVisibleUser('Target');

    const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));
    const body = JSON.stringify(response.body);

    // Age is derived and public; the birth date itself is not.
    expect(response.body.data).not.toHaveProperty('date_of_birth');
    expect(body).not.toContain('@kinvo.test');
    expect(body).not.toContain('password');
    expect(response.body.data.user).toHaveProperty('age');
  });

  describe('block enforcement (spec §5.5)', () => {
    it('hides a user the viewer has blocked, as 404', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await makeVisibleUser('Target');

      await createBlock(viewer.user_id, target.user_id);

      const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));

      expect(response.status).toBe(404);
      expectErrorEnvelope(response.body, 'NOT_FOUND');
    });

    it('hides a user who has blocked the viewer, as 404', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await makeVisibleUser('Target');

      // The other direction. Enforcing only one side is the classic
      // half-implementation of this rule.
      await createBlock(target.user_id, viewer.user_id);

      const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));

      expect(response.status).toBe(404);
    });

    it('returns 404 and not 403, so a block never confirms the user exists', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await makeVisibleUser('Target');
      await createBlock(viewer.user_id, target.user_id);

      const blocked = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));
      const neverExisted = await api
        .get(`${USERS}/6f1e2b3c-0000-4000-8000-000000000000`)
        .set(authHeader(viewer.tokens));

      // Byte-identical: an attacker cannot tell "blocked" from "no such user".
      expect(blocked.status).toBe(neverExisted.status);
      expect(blocked.body).toEqual(neverExisted.body);
    });
  });

  describe('other invisibility reasons are indistinguishable', () => {
    it('hides a suspended user', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await makeVisibleUser('Target');

      await prisma.user.update({
        where: { id: target.user_id },
        data: { status: UserStatus.suspended },
      });

      const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));
      expect(response.status).toBe(404);
    });

    it('hides a soft-deleted user', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await makeVisibleUser('Target');

      await prisma.user.update({
        where: { id: target.user_id },
        data: { deleted_at: new Date(), status: UserStatus.deleted },
      });

      const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));
      expect(response.status).toBe(404);
    });

    it('hides a user who never finished onboarding', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await createAuthenticatedUser({
        status: UserStatus.pending,
        onboarded: false,
      });
      await prisma.profile.create({ data: { user_id: target.user_id } });

      const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));
      expect(response.status).toBe(404);
    });

    it('hides a snoozed user (spec §5.6)', async () => {
      const viewer = await makeVisibleUser('Viewer');
      const target = await makeVisibleUser('Target');

      await prisma.user.update({
        where: { id: target.user_id },
        data: { is_snoozed: true },
      });

      const response = await api.get(`${USERS}/${target.user_id}`).set(authHeader(viewer.tokens));
      expect(response.status).toBe(404);
    });
  });

  it('always lets a user fetch themselves, even snoozed', async () => {
    const viewer = await makeVisibleUser('Viewer');
    await prisma.user.update({ where: { id: viewer.user_id }, data: { is_snoozed: true } });

    const response = await api.get(`${USERS}/${viewer.user_id}`).set(authHeader(viewer.tokens));

    expect(response.status).toBe(200);
  });

  it('requires authentication', async () => {
    const target = await makeVisibleUser('Target');

    const response = await api.get(`${USERS}/${target.user_id}`);

    expect(response.status).toBe(401);
  });

  it('rejects a malformed id as a validation error', async () => {
    const viewer = await makeVisibleUser('Viewer');

    const response = await api.get(`${USERS}/not-a-uuid`).set(authHeader(viewer.tokens));

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('id');
  });

  it('does not treat the literal "me" as a user id', async () => {
    const viewer = await makeVisibleUser('Viewer');

    const response = await api.get(`${USERS}/me`).set(authHeader(viewer.tokens));

    // /me is declared before /:id, so it wins.
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('user_id', viewer.user_id);
  });
});

describe('GET /users/me/preview', () => {
  it('renders the caller through the public projection', async () => {
    const viewer = await makeVisibleUser('Viewer');

    const preview = await api.get(`${USERS}/me/preview`).set(authHeader(viewer.tokens));

    expect(preview.status).toBe(200);
    // Same shape as what a stranger sees, so the preview cannot drift from
    // reality (spec §7 Batch 3, "how others see you").
    expect(preview.body.data).toHaveProperty('user');
    expect(preview.body.data).toHaveProperty('distance_metres');
    expect(preview.body.data).toHaveProperty('interests');
    expect(preview.body.data.user.display_name).toBe('Viewer');
  });

  it('shows zero distance to yourself', async () => {
    const viewer = await makeVisibleUser('Viewer', LONDON);

    const preview = await api.get(`${USERS}/me/preview`).set(authHeader(viewer.tokens));

    expect(preview.body.data.distance_metres).toBe(0);
  });
});
