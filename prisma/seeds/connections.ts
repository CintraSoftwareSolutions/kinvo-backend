import { Mode, SwipeAction, prisma } from '@/db/prisma';
import { createMatchIfMutual } from '@modules/matches/match.service';

/**
 * Matches and conversations for development (spec §7, Batch 8).
 *
 * Goes through `createMatchIfMutual`, the same function the swipe endpoint
 * calls, rather than inserting match rows directly. That matters: the
 * conversation and both `conversation_state` rows are created inside that
 * function, so a hand-built match row would be invisible to `GET /matches` and
 * the mobile team would be developing against a shape the product never
 * produces. Reusing the real path means this seed cannot drift from it.
 *
 * Idempotent: swipes are unique on (actor, target, mode) and the match lookup
 * returns the existing row, so re-running changes nothing.
 */

/** Pairs of dev-user emails that like each other, by mode. */
const CONNECTIONS: { a: string; b: string; mode: Mode; messages: string[] }[] = [
  {
    // Both have dating enabled in the user seed. A pair that does not share an
    // enabled mode is skipped rather than forced.
    a: 'sarah.dev@kinvo.test',
    b: 'james.dev@kinvo.test',
    mode: Mode.dating,
    messages: [
      'Hey! Your bookshelf photo is unreasonably tidy.',
      'Ha, it lasted exactly one afternoon. How was the climbing?',
      'Good. Elbows are complaining though.',
    ],
  },
  {
    a: 'sarah.dev@kinvo.test',
    b: 'priya.dev@kinvo.test',
    mode: Mode.foodie,
    messages: [
      'That ramen place you saved, is it worth the queue?',
      'Absolutely. Go before 6 though.',
    ],
  },
  {
    // No messages: the mobile team needs an empty conversation to build the
    // "say something first" state against.
    a: 'sarah.dev@kinvo.test',
    b: 'marcus.dev@kinvo.test',
    mode: Mode.networking,
    messages: [],
  },
];

async function userIdFor(email: string): Promise<string | null> {
  const identity = await prisma.authIdentity.findFirst({
    where: { provider: 'email', identifier: email },
    select: { user_id: true },
  });

  return identity?.user_id ?? null;
}

export async function seedConnections(): Promise<{ matches: number; messages: number }> {
  let matches = 0;
  let messages = 0;

  for (const connection of CONNECTIONS) {
    const [aId, bId] = await Promise.all([userIdFor(connection.a), userIdFor(connection.b)]);

    if (!aId || !bId) {
      continue;
    }

    // Both people must have the mode enabled, or the pair would be a match in a
    // mode neither can see — a state the product cannot reach.
    const enabled = await prisma.userMode.count({
      where: { mode: connection.mode, is_enabled: true, user_id: { in: [aId, bId] } },
    });

    if (enabled < 2) {
      continue;
    }

    const match = await prisma.$transaction(async (tx) => {
      for (const [actor, target] of [
        [bId, aId],
        [aId, bId],
      ]) {
        await tx.swipe.upsert({
          where: {
            actor_id_target_id_mode: {
              actor_id: actor as string,
              target_id: target as string,
              mode: connection.mode,
            },
          },
          create: {
            actor_id: actor as string,
            target_id: target as string,
            mode: connection.mode,
            action: SwipeAction.like,
          },
          update: {},
        });
      }

      return createMatchIfMutual(tx, {
        actorId: aId,
        targetId: bId,
        mode: connection.mode,
        isSuperLike: false,
      });
    });

    if (!match) {
      continue;
    }

    matches += 1;

    // Development matches must not rot.
    //
    // `createMatchIfMutual` is used deliberately above, so seeded matches go
    // through exactly the path a real swipe does — including the production
    // 14-day expiry. That is right for the creation logic and wrong for the
    // data: two weeks after a seed, every seeded match expires and staging
    // silently loses chat, plans and calling, because all three refuse on an
    // expired match. It presents as "the API is broken" to whoever is testing.
    //
    // Pushed out here rather than by parameterising the real function, which
    // would put a test-only knob in production code.
    await prisma.match.update({
      where: { id: match.id },
      data: { expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    });

    const conversation = await prisma.conversation.findUnique({
      where: { match_id: match.id },
      select: { id: true, messages: { select: { id: true }, take: 1 } },
    });

    if (!conversation || conversation.messages.length > 0) {
      continue;
    }

    for (const [index, body] of connection.messages.entries()) {
      // Spaced a minute apart so the backwards-paginating history has a stable
      // order rather than several rows sharing a timestamp.
      const createdAt = new Date(Date.now() - (connection.messages.length - index) * 60_000);

      await prisma.message.create({
        data: {
          conversation_id: conversation.id,
          sender_id: index % 2 === 0 ? aId : bId,
          type: 'text',
          body,
          created_at: createdAt,
        },
      });

      messages += 1;
    }

    const last = connection.messages.at(-1);

    if (last) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { last_message_at: new Date(), last_message_preview: last.slice(0, 200) },
      });

      await prisma.conversationState.updateMany({
        where: {
          conversation_id: conversation.id,
          user_id: connection.messages.length % 2 === 0 ? aId : bId,
        },
        data: { unread_count: 1 },
      });
    }
  }

  return { matches, messages };
}
