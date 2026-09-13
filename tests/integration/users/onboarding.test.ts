import { API_PREFIX } from '@config/constants';
import { UserStatus, prisma } from '@/db/prisma';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { LONDON, adultDateOfBirth } from '../../helpers/factories';
import { addPhoto } from '../../helpers/media';

/**
 * spec §5.1: onboarding is a state machine, `pending -> active`, and only
 * advances when the required fields are present.
 *
 * This is the gate that makes the under-18 rule work for social and phone
 * signups, which arrive with no date of birth at all.
 */

const USERS = `${API_PREFIX}/users`;
const ONBOARDING = `${API_PREFIX}/onboarding`;

beforeEach(async () => {
  await resetDatabase();
  await prisma.interest.createMany({
    data: [{ slug: 'music', label: 'Music', category: 'general', modes: ['dating'] }],
  });

  // Batch 5 gated onboarding on having a mode enabled, and enabling one reads
  // the tier cap from the entitlement matrix. That matrix is data (spec §5.11),
  // so tests must seed it exactly as the real seed does.
  const flag = await prisma.entitlementFlag.create({
    data: { key: 'max_simultaneous_modes', label: 'Simultaneous modes', value_type: 'number' },
  });
  await prisma.tierEntitlement.create({
    data: { tier: 'free', flag_id: flag.id, value: 3 },
  });
});
afterAll(closeDatabase);

/** Fills in everything the checklist asks for. */
async function satisfyRequirements(tokens: {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}) {
  const auth = authHeader(tokens);
  await api.patch(`${USERS}/me`).set(auth).send({ bio: 'A short but genuine bio.' });
  await api
    .patch(`${USERS}/me/location`)
    .set(auth)
    .send({ longitude: LONDON.longitude, latitude: LONDON.latitude });
  await api
    .put(`${USERS}/me/interests`)
    .set(auth)
    .send({ interests: ['music'] });
  // Batch 4 added "at least one approved photo" to the checklist. A deck full
  // of blank cards is not a product, so this is a real requirement.
  await addPhoto(tokens);
  // Batch 5 added "at least one enabled mode". An account with none has no
  // deck to show, so onboarding is not finished without one (spec §5.2).
  await api.patch(`${API_PREFIX}/modes/dating`).set(auth).send({ is_enabled: true });
}

describe('GET /onboarding', () => {
  it('lists every step and what is still missing', async () => {
    const { tokens } = await createAuthenticatedUser({ status: 'pending', onboarded: false });

    const response = await api.get(ONBOARDING).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.is_complete).toBe(false);
    expect(response.body.data.can_complete).toBe(false);
    expect(response.body.data.steps.map((s: { key: string }) => s.key)).toEqual([
      'display_name',
      'date_of_birth',
      'bio',
      'location',
      'interests',
      'photo',
      'mode',
    ]);
    expect(response.body.data.missing).toEqual(
      expect.arrayContaining(['bio', 'location', 'interests', 'photo', 'mode']),
    );
  });

  it('flips can_complete once the requirements are met', async () => {
    const { tokens } = await createAuthenticatedUser({ status: 'pending', onboarded: false });

    await satisfyRequirements(tokens);

    const response = await api.get(ONBOARDING).set(authHeader(tokens));
    expect(response.body.data.can_complete).toBe(true);
    expect(response.body.data.missing).toEqual([]);
  });
});

describe('POST /onboarding/complete', () => {
  it('moves the user from pending to active', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser({
      status: 'pending',
      onboarded: false,
    });
    await satisfyRequirements(tokens);

    const response = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));

    expect(response.status).toBe(200);
    expect(response.body.data.is_complete).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe(UserStatus.active);
    expect(user.onboarded_at).toBeInstanceOf(Date);
  });

  it('refuses while requirements are outstanding, and says which', async () => {
    const { tokens } = await createAuthenticatedUser({ status: 'pending', onboarded: false });

    const response = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ONBOARDING_INCOMPLETE');
    expect(response.body.error.details.missing).toEqual(
      expect.arrayContaining(['bio', 'location', 'interests', 'photo', 'mode']),
    );
  });

  it('is idempotent — completing twice is not an error', async () => {
    const { tokens } = await createAuthenticatedUser({ status: 'pending', onboarded: false });
    await satisfyRequirements(tokens);

    const first = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));
    const second = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.is_complete).toBe(true);
  });

  it('refuses a suspended account', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser({
      status: 'pending',
      onboarded: false,
    });
    await satisfyRequirements(tokens);
    await prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.suspended },
    });

    const response = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'ACCOUNT_SUSPENDED');
  });
});

describe('the under-18 gate for social and phone signups (spec §5.1)', () => {
  it('cannot complete onboarding without a date of birth', async () => {
    // Exactly the account a Google, Apple, or OTP signup creates.
    const { tokens } = await createAuthenticatedUser({
      status: 'pending',
      onboarded: false,
      date_of_birth: null,
    });
    await satisfyRequirements(tokens);

    const response = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));

    expect(response.status).toBe(403);
    expect(response.body.error.details.missing).toContain('date_of_birth');
  });

  it('rejects a date of birth under 18 and stores nothing', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser({
      status: 'pending',
      onboarded: false,
      date_of_birth: null,
    });

    const under18 = new Date();
    under18.setUTCFullYear(under18.getUTCFullYear() - 16);

    const response = await api
      .post(`${ONBOARDING}/date-of-birth`)
      .set(authHeader(tokens))
      .send({ date_of_birth: under18.toISOString().slice(0, 10) });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toHaveProperty('date_of_birth');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.date_of_birth).toBeNull();
    expect(user.status).toBe(UserStatus.pending);
  });

  it('accepts an adult date of birth and then allows completion', async () => {
    const { tokens, user_id: userId } = await createAuthenticatedUser({
      status: 'pending',
      onboarded: false,
      date_of_birth: null,
    });
    await satisfyRequirements(tokens);

    const set = await api
      .post(`${ONBOARDING}/date-of-birth`)
      .set(authHeader(tokens))
      .send({ date_of_birth: '1999-03-14' });

    expect(set.status).toBe(200);
    expect(set.body.data.can_complete).toBe(true);

    const complete = await api.post(`${ONBOARDING}/complete`).set(authHeader(tokens));
    expect(complete.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe(UserStatus.active);
  });

  it('refuses to change a date of birth that is already set', async () => {
    const { tokens } = await createAuthenticatedUser({
      date_of_birth: adultDateOfBirth(30),
    });

    const response = await api
      .post(`${ONBOARDING}/date-of-birth`)
      .set(authHeader(tokens))
      .send({ date_of_birth: '2000-01-01' });

    // Letting users edit this freely would reopen the age gate.
    expect(response.status).toBe(409);
    expectErrorEnvelope(response.body, 'CONFLICT');
  });

  it('rejects a malformed date', async () => {
    const { tokens } = await createAuthenticatedUser({ date_of_birth: null, onboarded: false });

    const response = await api
      .post(`${ONBOARDING}/date-of-birth`)
      .set(authHeader(tokens))
      .send({ date_of_birth: '14/03/1999' });

    expect(response.status).toBe(400);
  });
});
