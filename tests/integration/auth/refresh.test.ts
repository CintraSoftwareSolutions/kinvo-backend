import jwt from 'jsonwebtoken';

import { env } from '@config/env';
import { prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';

/**
 * spec §4.3: rotate the refresh token on every use and invalidate the old one.
 * If a rotated token is replayed, treat it as theft and revoke the entire
 * token family for that user.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function refresh(token: string) {
  return api.post(`${AUTH_BASE}/refresh`).send({ refresh_token: token });
}

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await refresh(tokens.refresh_token);

    expect(response.status).toBe(200);
    expect(response.body.data.access_token).toEqual(expect.any(String));
    expect(response.body.data.refresh_token).not.toBe(tokens.refresh_token);
  });

  it('invalidates the presented token — rotation, not reuse', async () => {
    const { tokens } = await createAuthenticatedUser();
    await refresh(tokens.refresh_token);

    const replay = await refresh(tokens.refresh_token);

    expect(replay.status).toBe(401);
    expectErrorEnvelope(replay.body, 'AUTH_TOKEN_INVALID');
  });

  it('keeps the new token working across several rotations', async () => {
    const { tokens } = await createAuthenticatedUser();

    let current = tokens.refresh_token;
    for (let round = 0; round < 3; round += 1) {
      const response = await refresh(current);
      expect(response.status).toBe(200);
      current = response.body.data.refresh_token;
    }
  });

  it('stays in one family across rotations', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser();
    await refresh(tokens.refresh_token);
    await refresh((await refresh(tokens.refresh_token)).body.data?.refresh_token ?? '');

    const stored = await prisma.refreshToken.findMany({ where: { user_id: userId } });
    const families = new Set(stored.map((token) => token.family_id));

    expect(families.size).toBe(1);
  });

  describe('replay is treated as theft (spec §4.3)', () => {
    it('revokes the entire family when a rotated token comes back', async () => {
      const { tokens, user_id: userId } = await createAuthenticatedUser();

      // The legitimate client rotates.
      const rotated = await refresh(tokens.refresh_token);
      const liveToken = rotated.body.data.refresh_token;

      // An attacker replays the stolen, already-rotated token.
      const replay = await refresh(tokens.refresh_token);
      expect(replay.status).toBe(401);

      // The legitimate client's current token must now also be dead — there is
      // no way to tell which holder is genuine, so neither may continue.
      const afterTheft = await refresh(liveToken);
      expect(afterTheft.status).toBe(401);
      expectErrorEnvelope(afterTheft.body, 'AUTH_TOKEN_INVALID');

      const live = await prisma.refreshToken.count({
        where: { user_id: userId, revoked_at: null },
      });
      expect(live).toBe(0);
    });

    it('leaves other devices signed in', async () => {
      const { tokens, user_id: userId } = await createAuthenticatedUser();

      // A second device: its own family.
      const secondDevice = await api.post(`${AUTH_BASE}/login`).send({
        email: (
          await prisma.authIdentity.findFirstOrThrow({
            where: { user_id: userId, provider: 'email' },
          })
        ).identifier,
        password: 'correct horse battery staple',
      });
      const secondToken = secondDevice.body.data.refresh_token;

      await refresh(tokens.refresh_token);
      await refresh(tokens.refresh_token); // replay, kills family one

      // Family two is untouched.
      const stillWorks = await refresh(secondToken);
      expect(stillWorks.status).toBe(200);
    });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { sub: 'a3f1c2d4-0000-4000-8000-000000000000', jti: 'x', fam: 'y', type: 'refresh' },
      'an-attacker-chosen-secret-value-000000000',
      { expiresIn: 3600, issuer: env.JWT_ISSUER },
    );

    const response = await refresh(forged);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });

  it('rejects a correctly signed token that we never issued', async () => {
    const { user_id: userId } = await createAuthenticatedUser();

    // Signed with the real secret but with no matching row — the database is
    // the authority, not the signature alone.
    const orphan = jwt.sign(
      { sub: userId, jti: 'never-stored', fam: 'never-stored', type: 'refresh' },
      env.JWT_REFRESH_SECRET,
      { expiresIn: 3600, issuer: env.JWT_ISSUER },
    );

    const response = await refresh(orphan);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });

  it('reports an expired token as AUTH_TOKEN_EXPIRED, not INVALID', async () => {
    const { user_id: userId } = await createAuthenticatedUser();

    const expired = jwt.sign(
      { sub: userId, jti: 'expired', fam: 'expired', type: 'refresh' },
      env.JWT_REFRESH_SECRET,
      { expiresIn: -60, issuer: env.JWT_ISSUER },
    );

    const response = await refresh(expired);

    // The app refreshes on EXPIRED and logs out on INVALID — conflating them
    // logs out users who should have been renewed silently.
    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_EXPIRED');
  });

  it('refuses an access token presented as a refresh token', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await refresh(tokens.access_token);

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });

  it('validates the request body', async () => {
    const response = await api.post(`${AUTH_BASE}/refresh`).send({});

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('refresh_token');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the presented family and reports success', async () => {
    const { tokens } = await createAuthenticatedUser();

    const response = await api
      .post(`${AUTH_BASE}/logout`)
      .send({ refresh_token: tokens.refresh_token });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ signed_out: true });

    const afterLogout = await refresh(tokens.refresh_token);
    expect(afterLogout.status).toBe(401);
  });

  it('succeeds for an unknown token rather than confirming which are real', async () => {
    const response = await api
      .post(`${AUTH_BASE}/logout`)
      .send({ refresh_token: 'not-a-token-we-ever-issued' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ signed_out: true });
  });

  it('leaves other devices signed in', async () => {
    const { tokens, email } = await createAuthenticatedUser();
    const second = await api
      .post(`${AUTH_BASE}/login`)
      .send({ email, password: 'correct horse battery staple' });

    await api.post(`${AUTH_BASE}/logout`).send({ refresh_token: tokens.refresh_token });

    const stillWorks = await refresh(second.body.data.refresh_token);
    expect(stillWorks.status).toBe(200);
  });
});
