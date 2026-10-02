import { type Mode, type Prisma, prisma } from '@/db/prisma';
import { LIKE_ACTIONS, orderPair } from '@modules/matches/match.service';
import { ApiError } from '@utils/api-error';

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
