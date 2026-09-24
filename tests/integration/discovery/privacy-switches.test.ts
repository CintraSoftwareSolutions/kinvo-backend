import { API_PREFIX } from '@config/constants';
import { MatchStatus, Mode, prisma } from '@/db/prisma';
import type { AuthTokens } from '@modules/auth/auth.types';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader } from '../../helpers/auth';
import { CAMDEN, LONDON, createBlock } from '../../helpers/factories';
import { createDiscoverableUser, createDiscoverableViewer } from '../../helpers/discovery';
import { api, expectErrorEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';

/**
 * The three privacy switches (DECISIONS.md, 24 Sep 2026), stored since
 * 18 Sep and applied from today:
 *
 * - incognito: only people you have liked see you, and your matches still do.
 * - global_verified_only: only verified people, in every mode.
 * - pause_new_matches: still visible, but no new match; the likes wait, and
 *   the pairs that became mutual are matched the moment the pause ends.
 */

const DECK = (mode: string) => `${API_PREFIX}/discovery/${mode}/deck`;
const SWIPE = (mode: string) => `${API_PREFIX}/discovery/${mode}/swipe`;
const SETTINGS = `${API_PREFIX}/settings`;
const PROFILE = (id: string) => `${API_PREFIX}/users/${id}`;

type Person = { user_id: string; tokens: AuthTokens };

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

async function deckIds(person: Person, mode = 'dating'): Promise<string[]> {
  const response = await api.get(DECK(mode)).set(authHeader(person.tokens));
  expect(response.status).toBe(200);
  return response.body.data.map((card: { user: { id: string } }) => card.user.id);
}

function set(person: Person, body: Record<string, boolean>) {
  return api.patch(SETTINGS).set(authHeader(person.tokens)).send(body);
}

function swipe(person: Person, target: Person, action = 'like', mode = 'dating') {
  return api
    .post(SWIPE(mode))
    .set(authHeader(person.tokens))
    .send({ target_id: target.user_id, action });
}

function person(options: { coordinates?: typeof LONDON; also?: Mode[] } = {}) {
  return createDiscoverableViewer({
    mode: Mode.dating,
    coordinates: options.coordinates ?? CAMDEN,
    also_modes: options.also,
  });
}

async function matchesBetween(a: Person, b: Person): Promise<number> {
  return prisma.match.count({
    where: {
      OR: [
        { user_a_id: a.user_id, user_b_id: b.user_id },
        { user_a_id: b.user_id, user_b_id: a.user_id },
      ],
    },
  });
}

describe('incognito: only people you have liked see you', () => {
  it('keeps someone incognito out of a stranger’s deck', async () => {
    const viewer = await person({ coordinates: LONDON });
    const hidden = await person();
    expect(await deckIds(viewer)).toContain(hidden.user_id);

    await set(hidden, { incognito: true });

    // Decks are built once a day; the rule holds on every read, so turning it
    // on hides someone from a deck already built at once.
    expect(await deckIds(viewer)).not.toContain(hidden.user_id);
  });

  it('shows them to someone they liked, in that mode only', async () => {
    const viewer = await person({ coordinates: LONDON, also: [Mode.study_buddy] });
    const hidden = await person({ also: [Mode.study_buddy] });
    await set(hidden, { incognito: true });

    await swipe(hidden, viewer);

    expect(await deckIds(viewer)).toContain(hidden.user_id);
    // A like in dating reveals nobody to a study-buddy deck.
    expect(await deckIds(viewer, 'study_buddy')).not.toContain(hidden.user_id);
  });

  it('can still match, with the people it chose first', async () => {
    const viewer = await person({ coordinates: LONDON });
    const hidden = await person();
    await set(hidden, { incognito: true });

    // Unseen, so not to be acted on: the same 404 as nobody at all.
    const blind = await swipe(viewer, hidden);
    expect(blind.status).toBe(404);

    await swipe(hidden, viewer);
    const liked = await swipe(viewer, hidden);

    expect(liked.status).toBe(201);
    expect(liked.body.data.is_match).toBe(true);
  });

  it('answers a stranger asking for their profile exactly as for nobody', async () => {
    const stranger = await person({ coordinates: LONDON });
    const hidden = await person();
    await set(hidden, { incognito: true });

    const response = await api.get(PROFILE(hidden.user_id)).set(authHeader(stranger.tokens));
    const nobody = await api
      .get(PROFILE('00000000-0000-4000-8000-000000000000'))
      .set(authHeader(stranger.tokens));

    expect(response.status).toBe(404);
    expect(response.body).toEqual(nobody.body);
  });

  it('keeps their profile open to people they liked and to their matches', async () => {
    const liked = await person({ coordinates: LONDON });
    const matched = await person({ coordinates: LONDON });
    const hidden = await person();

    await swipe(hidden, matched);
    await swipe(matched, hidden);
    await set(hidden, { incognito: true });
    await swipe(hidden, liked);

    // The match alone must be enough: the like behind it is gone.
    await prisma.swipe.deleteMany({
      where: { actor_id: hidden.user_id, target_id: matched.user_id },
    });

    for (const viewer of [liked, matched]) {
      const response = await api.get(PROFILE(hidden.user_id)).set(authHeader(viewer.tokens));
      expect(response.status).toBe(200);
    }
  });
});

describe('verified people only, in every mode', () => {
  it('keeps unverified people out of every deck, and rebuilds today’s', async () => {
    const viewer = await person({ coordinates: LONDON, also: [Mode.study_buddy] });
    const verified = await createDiscoverableUser({
      mode: Mode.dating,
      also_modes: [Mode.study_buddy],
      coordinates: CAMDEN,
      is_verified: true,
    });
    const unverified = await createDiscoverableUser({
      mode: Mode.dating,
      also_modes: [Mode.study_buddy],
      coordinates: CAMDEN,
    });

    // Built for today, with both in.
    expect(await deckIds(viewer)).toContain(unverified.user.id);
    expect(await deckIds(viewer, 'study_buddy')).toContain(unverified.user.id);

    await set(viewer, { global_verified_only: true });

    for (const mode of ['dating', 'study_buddy']) {
      const ids = await deckIds(viewer, mode);
      expect(ids).toContain(verified.user.id);
      expect(ids).not.toContain(unverified.user.id);
    }

    await set(viewer, { global_verified_only: false });
    expect(await deckIds(viewer)).toContain(unverified.user.id);
  });
});

describe('pause new matches: visible, but no new match', () => {
  it('refuses a like, and the refusal costs nothing', async () => {
    const paused = await person({ coordinates: LONDON });
    const other = await person();
    await set(paused, { pause_new_matches: true });

    const like = await swipe(paused, other);

    expect(like.status).toBe(409);
    expectErrorEnvelope(like.body, 'NEW_MATCHES_PAUSED');
    expect(await prisma.swipe.count({ where: { actor_id: paused.user_id } })).toBe(0);

    // A pass starts nothing, so it still works.
    const pass = await swipe(paused, other, 'pass');
    expect(pass.status).toBe(201);
  });

  it('keeps the paused account in other people’s decks', async () => {
    const viewer = await person({ coordinates: LONDON });
    const paused = await person();
    await set(paused, { pause_new_matches: true });

    expect(await deckIds(viewer)).toContain(paused.user_id);
  });

  it('holds a pair that became mutual, and matches it when the pause ends', async () => {
    const paused = await person({ coordinates: LONDON });
    const admirer = await person();

    await swipe(paused, admirer);
    await set(paused, { pause_new_matches: true });

    const answered = await swipe(admirer, paused);
    expect(answered.status).toBe(201);
    expect(answered.body.data.is_match).toBe(false);
    expect(await matchesBetween(paused, admirer)).toBe(0);

    const resumed = await set(paused, { pause_new_matches: false });

    expect(resumed.status).toBe(200);
    expect(await matchesBetween(paused, admirer)).toBe(1);
    // Announced to both, as it would have been at the time.
    for (const side of [paused, admirer]) {
      expect(
        await prisma.notification.count({
          where: { user_id: side.user_id, category: 'new_match' },
        }),
      ).toBe(1);
    }
  });

  it('waits for both when both have paused', async () => {
    const first = await person({ coordinates: LONDON });
    const second = await person();

    await swipe(first, second);
    await set(first, { pause_new_matches: true });
    await swipe(second, first);
    await set(second, { pause_new_matches: true });

    await set(first, { pause_new_matches: false });
    expect(await matchesBetween(first, second)).toBe(0);

    await set(second, { pause_new_matches: false });
    expect(await matchesBetween(first, second)).toBe(1);
  });

  it('never matches again a pair that has had a match', async () => {
    const paused = await person({ coordinates: LONDON });
    const former = await person();

    await swipe(paused, former);
    await swipe(former, paused);
    await prisma.match.updateMany({
      data: { status: MatchStatus.unmatched, unmatched_at: new Date() },
    });

    await set(paused, { pause_new_matches: true });
    await set(paused, { pause_new_matches: false });

    // Unmatching was a decision. Unpausing is not a way around it.
    expect(await matchesBetween(paused, former)).toBe(1);
    expect(await prisma.match.count({ where: { status: MatchStatus.active } })).toBe(0);
  });

  it('does not match across a block made while paused', async () => {
    const paused = await person({ coordinates: LONDON });
    const other = await person();

    await swipe(paused, other);
    await set(paused, { pause_new_matches: true });
    await swipe(other, paused);
    await createBlock(paused.user_id, other.user_id);

    await set(paused, { pause_new_matches: false });

    expect(await matchesBetween(paused, other)).toBe(0);
  });
});
