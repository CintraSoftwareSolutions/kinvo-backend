import {
  fakeIdToken,
  INVALID_ID_TOKEN,
  mockVerifyAppleIdToken,
  mockVerifyGoogleIdToken,
} from '../../mocks/external';

/**
 * Google and Apple verification is mocked at the provider boundary. What these
 * tests exercise is everything after verification succeeds — specifically the
 * spec §5.1 rule that signing up with email and later using Google on the same
 * address LINKS to the existing user rather than creating a second one.
 */
jest.mock('@/providers/google-auth.provider', () => ({
  verifyGoogleIdToken: mockVerifyGoogleIdToken,
}));

jest.mock('@/providers/apple-auth.provider', () => ({
  verifyAppleIdToken: mockVerifyAppleIdToken,
}));

import { prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { AUTH_BASE, TEST_PASSWORD, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { uniqueEmail } from '../../helpers/factories';

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('POST /auth/google', () => {
  it('creates a pending account for a first-time user', async () => {
    const token = fakeIdToken({
      subject: 'google-subject-1',
      email: 'new.user@example.com',
      email_verified: true,
      name: 'Sarah Chen',
    });

    const response = await api.post(`${AUTH_BASE}/google`).send({ id_token: token });

    expect(response.status).toBe(201);
    expect(response.body.data.is_new_user).toBe(true);
    expect(response.body.data.access_token).toEqual(expect.any(String));

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'google', identifier: 'google-subject-1' } },
      include: { user: true },
    });

    // Google supplies no date of birth, so the account stays pending until
    // onboarding collects one and applies the under-18 check (spec §5.1).
    expect(identity.user.status).toBe('pending');
    expect(identity.user.date_of_birth).toBeNull();
    expect(identity.user.display_name).toBe('Sarah Chen');
  });

  it('returns the same user on a second sign-in', async () => {
    const token = fakeIdToken({
      subject: 'google-subject-2',
      email: 'repeat@example.com',
      email_verified: true,
    });

    const first = await api.post(`${AUTH_BASE}/google`).send({ id_token: token });
    const second = await api.post(`${AUTH_BASE}/google`).send({ id_token: token });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.is_new_user).toBe(false);
    expect(await prisma.user.count()).toBe(1);
  });

  describe('linking (spec §5.1 — never a duplicate user)', () => {
    it('links to the existing account when the verified email already registered', async () => {
      const email = uniqueEmail('linkme');
      const existing = await createAuthenticatedUser({ email });

      const response = await api.post(`${AUTH_BASE}/google`).send({
        id_token: fakeIdToken({
          subject: 'google-subject-3',
          email,
          email_verified: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.body.data.is_new_user).toBe(false);

      // One user, two identities — the whole point of AuthIdentity.
      expect(await prisma.user.count()).toBe(1);

      const identities = await prisma.authIdentity.findMany({
        where: { user_id: existing.user_id },
      });
      expect(identities.map((i) => i.provider).sort()).toEqual(['email', 'google']);
    });

    it('leaves the original password sign-in working after linking', async () => {
      const email = uniqueEmail('stillworks');
      await createAuthenticatedUser({ email });

      await api.post(`${AUTH_BASE}/google`).send({
        id_token: fakeIdToken({ subject: 'google-subject-4', email, email_verified: true }),
      });

      const login = await api.post(`${AUTH_BASE}/login`).send({ email, password: TEST_PASSWORD });
      expect(login.status).toBe(200);
    });

    it('refuses to link on an unverified email', async () => {
      const email = uniqueEmail('unverified');
      await createAuthenticatedUser({ email });

      const response = await api.post(`${AUTH_BASE}/google`).send({
        id_token: fakeIdToken({ subject: 'attacker-subject', email, email_verified: false }),
      });

      // Linking on an unverified address would let anyone claim someone else's
      // address at the provider and be handed their Kinvo account.
      expect(response.body.data.is_new_user).toBe(true);
      expect(await prisma.user.count()).toBe(2);
    });

    it('links Apple and Google to one user when both report the same verified email', async () => {
      const email = 'both.providers@example.com';

      await api.post(`${AUTH_BASE}/google`).send({
        id_token: fakeIdToken({ subject: 'g-sub', email, email_verified: true }),
      });
      const apple = await api.post(`${AUTH_BASE}/apple`).send({
        id_token: fakeIdToken({ subject: 'a-sub', email, email_verified: true }),
      });

      expect(apple.body.data.is_new_user).toBe(false);
      expect(await prisma.user.count()).toBe(1);
    });

    it('refuses registration against an address a social account already holds', async () => {
      const email = 'social.first@example.com';

      await api.post(`${AUTH_BASE}/google`).send({
        id_token: fakeIdToken({ subject: 'g-first', email, email_verified: true }),
      });

      const register = await api.post(`${AUTH_BASE}/register`).send({
        email,
        password: TEST_PASSWORD,
        display_name: 'Sarah',
        date_of_birth: '1999-03-14',
      });

      // Setting a password here would be account takeover — the caller has
      // proved nothing about owning the mailbox. See security.test.ts.
      expect(register.status).toBe(409);
      expect(await prisma.user.count()).toBe(1);
    });
  });

  it('rejects an unverifiable token', async () => {
    const response = await api.post(`${AUTH_BASE}/google`).send({ id_token: INVALID_ID_TOKEN });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
    expect(await prisma.user.count()).toBe(0);
  });

  it('validates the request body', async () => {
    const response = await api.post(`${AUTH_BASE}/google`).send({});

    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('id_token');
  });
});

describe('POST /auth/apple', () => {
  it('creates an account and uses the display name the app relays', async () => {
    // Apple sends the name only on first authorisation, so the client passes it.
    const response = await api.post(`${AUTH_BASE}/apple`).send({
      id_token: fakeIdToken({
        subject: 'apple-subject-1',
        email: 'apple.user@privaterelay.appleid.com',
        email_verified: true,
      }),
      display_name: 'Tom',
    });

    expect(response.status).toBe(201);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'apple', identifier: 'apple-subject-1' } },
      include: { user: true },
    });

    expect(identity.user.display_name).toBe('Tom');
  });

  it('handles a private relay address with no name at all', async () => {
    const response = await api.post(`${AUTH_BASE}/apple`).send({
      id_token: fakeIdToken({ subject: 'apple-subject-2', email: null, email_verified: false }),
    });

    expect(response.status).toBe(201);

    const identity = await prisma.authIdentity.findUniqueOrThrow({
      where: { provider_identifier: { provider: 'apple', identifier: 'apple-subject-2' } },
      include: { user: true },
    });

    expect(identity.user.display_name.length).toBeGreaterThan(0);
  });

  it('rejects an unverifiable token', async () => {
    const response = await api.post(`${AUTH_BASE}/apple`).send({ id_token: INVALID_ID_TOKEN });

    expect(response.status).toBe(401);
    expectErrorEnvelope(response.body, 'AUTH_TOKEN_INVALID');
  });
});
