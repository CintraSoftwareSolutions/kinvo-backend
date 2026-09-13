import { Router } from 'express';

import { env } from '@config/env';
import { docsRouter } from '@/docs/docs.routes';
import { authRouter } from '@modules/auth/auth.routes';
import { configRouter } from '@modules/config/config.routes';
import { chatRouter } from '@modules/chat/chat.routes';
import { discoveryRouter } from '@modules/discovery/discovery.routes';
import { matchesRouter } from '@modules/matches/matches.routes';
import { entitlementsRouter } from '@modules/entitlements/entitlements.routes';
import { healthRouter } from '@modules/health/health.routes';
import { mediaRouter, verificationRouter } from '@modules/media/media.routes';
import { moderationRouter } from '@modules/moderation/moderation.routes';
import { notificationsRouter } from '@modules/notifications/notifications.routes';
import { plansRouter } from '@modules/plans/plans.routes';
import { callsRouter } from '@modules/calls/calls.routes';
import { subscriptionsRouter } from '@modules/subscriptions/subscriptions.routes';
import { blocksRouter, reportsRouter, safetyRouter } from '@modules/safety/safety.routes';
import { venuesRouter } from '@modules/venues/venues.routes';
import { modesRouter } from '@modules/modes/modes.routes';
import { devicesRouter, settingsRouter } from '@modules/settings/settings.routes';
import { onboardingRouter, usersRouter } from '@modules/users/users.routes';

/**
 * Every versioned route mounts here. Module routers are added batch by batch.
 */
export const apiRouter: Router = Router();

// Documentation first, and deliberately outside the versioned resource
// routes: /docs describes v1 but is not part of the v1 contract.
if (env.DOCS_ENABLED) {
  apiRouter.use('/docs', docsRouter);
}

apiRouter.use('/health', healthRouter);
apiRouter.use('/config', configRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/onboarding', onboardingRouter);
apiRouter.use('/media', mediaRouter);
apiRouter.use('/verification', verificationRouter);
apiRouter.use('/me', entitlementsRouter);
apiRouter.use('/discovery', discoveryRouter);
apiRouter.use('/matches', matchesRouter);
apiRouter.use('/conversations', chatRouter);
apiRouter.use('/modes', modesRouter);
apiRouter.use('/moderation', moderationRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/blocks', blocksRouter);
apiRouter.use('/safety', safetyRouter);
apiRouter.use('/plans', plansRouter);
apiRouter.use('/venues', venuesRouter);
apiRouter.use('/subscriptions', subscriptionsRouter);
apiRouter.use('/calls', callsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/devices', devicesRouter);
