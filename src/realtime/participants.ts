import { prisma } from '@/db/prisma';

export async function otherParticipantId(
  conversationId: string,
  viewerId: string,
): Promise<string | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      match: { OR: [{ user_a_id: viewerId }, { user_b_id: viewerId }] },
    },
    select: { match: { select: { user_a_id: true, user_b_id: true } } },
  });

  if (!conversation) {
    return null;
  }

  const { user_a_id, user_b_id } = conversation.match;

  return user_a_id === viewerId ? user_b_id : user_a_id;
}
