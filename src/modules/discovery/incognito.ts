import { type Mode, type Prisma, prisma } from '@/db/prisma';
import { LIKE_ACTIONS, orderPair } from '@modules/matches/match.service';
import { ApiError } from '@utils/api-error';

/**
 * Incognito (DECISIONS.md, 24 Sep 2026): only people you have liked can see
 * you — and your matches still can.
 *
 * The product owner's choice, and the meaning Tinder, Bumble and OkCupid give
 * the word. It is also the one that lets an incognito account still match:
 * with the people it chose first. Hiding from everyone but existing matches
 * would have made its likes invisible, and so pointless.
 *
 * A setting on the settings table, read with a join — unlike snooze, which
 * lives on the user row so the shared clause never has to. The difference is
 * the size of what is filtered: this runs only where a deck is built or read,
 * over a day's candidate pool or a page of cards, through the settings table's
 * unique index and the swipes table's (actor, target, mode) one. It never
 * runs over the whole user table.
 */

/**
 * Deck candidates the viewer may see in [mode]: anyone who is not incognito,
 * and anyone incognito who has liked the viewer in this mode.
 *
 * Mode-scoped like everything in discovery: a like in dating reveals someone
 * to that person's dating deck, not their study-buddy one.
 */
export function incognitoFilter(viewerId: string, mode: Mode): Prisma.UserWhereInput {
  return {
    NOT: {
      AND: [
        { settings: { is: { incognito: true } } },
        {
          swipes_made: {
            none: { target_id: viewerId, mode, action: { in: LIKE_ACTIONS } },
          },
        },
      ],
    },
  };
}

/**
 * Throws the 404 a user who never existed gets, unless [viewerId] may see
 * [targetId]: they are not incognito, they have matched with the viewer at any
 * time, or they have liked the viewer — in [mode] when given, in any mode
 * otherwise.
 *
 * A 404 and not a 403, for the reason every visibility check here answers 404:
 * a different answer would tell the viewer the account exists and is hiding.
 */
export async function assertIncognitoAllows(
  viewerId: string,
  targetId: string,
  options: { mode?: Mode } = {},
): Promise<void> {
  if (viewerId === targetId) return;

  const settings = await prisma.userSettings.findUnique({
    where: { user_id: targetId },
    select: { incognito: true },
  });
  if (!settings?.incognito) return;

  const [userAId, userBId] = orderPair(viewerId, targetId);
  const [match, like] = await Promise.all([
    // Any match, even one that expired or ended: its conversation is still
    // there to read, and the profile it links to must still open.
    prisma.match.findFirst({
      where: { user_a_id: userAId, user_b_id: userBId },
      select: { id: true },
    }),
    prisma.swipe.findFirst({
      where: {
        actor_id: targetId,
        target_id: viewerId,
        action: { in: LIKE_ACTIONS },
        ...(options.mode ? { mode: options.mode } : {}),
      },
      select: { id: true },
    }),
  ]);

  if (!match && !like) {
    throw ApiError.notFound();
  }
}
