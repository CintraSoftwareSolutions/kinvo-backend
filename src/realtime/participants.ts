import { prisma } from '@/db/prisma';

/**
 * Conversation membership lookups for the realtime layer.
 *
 * Separate from chat.service on purpose: the chat service imports the emitters
 * and the socket handlers need membership, so putting this there would make the
 * two modules import each other.
 */

/** The other participant, or null if the caller is not in the conversation. */
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
