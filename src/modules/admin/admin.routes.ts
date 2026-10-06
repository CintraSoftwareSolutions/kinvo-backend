import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requirePermission } from '@middleware/require-permission';
import { requireRole } from '@middleware/require-role';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './admin.controller';
import { ADMIN_PERMISSIONS } from './admin.types';
import {
  activityQuerySchema,
  addRoleMemberSchema,
  assignFlagSchema,
  auditLogQuerySchema,
  createRoleSchema,
  createVenueSchema,
  flagIdParamSchema,
  guardrailKeyParamSchema,
  listUsersQuerySchema,
  listVenuesQuerySchema,
  moderationQueueQuerySchema,
  productIdParamSchema,
  roleIdParamSchema,
  roleMemberParamsSchema,
  setGuardrailSchema,
  setPermissionsSchema,
  setProductPriceSchema,
  setStaffRoleSchema,
  suspendUserSchema,
  updateProductSchema,
  updateRoleSchema,
  updateVenueSchema,
  userIdParamSchema,
  venueIdParamSchema,
} from './admin.schema';

/**
 * Admin routes (spec §7, Batch 15).
 *
 * The admin PANEL is a separate codebase. These are the endpoints it calls.
 *
 * `/admin/*` rather than scattering them through the feature modules. When
 * there were two such endpoints that would have been a third convention for no
 * gain; at this size it is one namespace, one auth model, and one base path for
 * the panel to point at. The six role-gated endpoints that already existed
 * (`/reports/review`, `/moderation/flags`, `/verification/review`) are LEFT
 * EXACTLY WHERE THEY ARE — moving them would change a shipped contract, and
 * this whole batch is additive by constraint.
 *
 * TWO GATES, in order:
 *
 *   `requireRole('moderator', 'admin')`  — is this person staff at all?
 *   `requirePermission(key)`             — may this person do THIS?
 *
 * The first is deliberately redundant with the second, which already refuses a
 * `role: 'user'` account. Belt and braces on the surface that can read anyone's
 * identity documents and change who has access: if `requirePermission` is ever
 * refactored wrongly, the router still refuses a non-staff caller.
 *
 * `mutates: true` marks a route that read-only mode freezes. Declared per route
 * rather than inferred from the method, because a POST that only reads should
 * stay available while the panel is paused.
 */
export const adminRouter: Router = Router();

adminRouter.use(authenticate, requireRole('moderator', 'admin'));

/**
 * Who am I, and what may I do.
 *
 * Needs no permission of its own: any staff member may ask what they hold, and
 * requiring a permission to discover your permissions is a loop. The panel
 * calls this first and hides what the answer omits — presentation only, since
 * every endpoint still checks for itself.
 */
adminRouter.get('/me', asyncHandler(controller.getSelf));

// --- roles and the permission matrix ---------------------------------------

adminRouter.get(
  '/roles',
  requirePermission(ADMIN_PERMISSIONS.ROLES_READ),
  asyncHandler(controller.listRoles),
);

adminRouter.post(
  '/roles',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE, { mutates: true }),
  validate({ body: createRoleSchema }),
  asyncHandler(controller.createRole),
);

adminRouter.patch(
  '/roles/:id',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE, { mutates: true }),
  validate({ params: roleIdParamSchema, body: updateRoleSchema }),
  asyncHandler(controller.updateRole),
);

adminRouter.delete(
  '/roles/:id',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE, { mutates: true }),
  validate({ params: roleIdParamSchema }),
  asyncHandler(controller.deleteRole),
);

adminRouter.get(
  '/roles/:id/permissions',
  requirePermission(ADMIN_PERMISSIONS.ROLES_READ),
  validate({ params: roleIdParamSchema }),
  asyncHandler(controller.getRolePermissions),
);

adminRouter.put(
  '/roles/:id/permissions',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE, { mutates: true }),
  validate({ params: roleIdParamSchema, body: setPermissionsSchema }),
  asyncHandler(controller.setRolePermissions),
);

adminRouter.get(
  '/roles/:id/members',
  requirePermission(ADMIN_PERMISSIONS.ROLES_READ),
  validate({ params: roleIdParamSchema }),
  asyncHandler(controller.listRoleMembers),
);

adminRouter.post(
  '/roles/:id/members',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE, { mutates: true }),
  validate({ params: roleIdParamSchema, body: addRoleMemberSchema }),
  asyncHandler(controller.addRoleMember),
);

adminRouter.delete(
  '/roles/:id/members/:userId',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE, { mutates: true }),
  validate({ params: roleMemberParamsSchema }),
  asyncHandler(controller.removeRoleMember),
);

// --- guardrails ------------------------------------------------------------

adminRouter.get(
  '/guardrails',
  requirePermission(ADMIN_PERMISSIONS.ROLES_READ),
  asyncHandler(controller.listGuardrails),
);

/**
 * Deliberately NOT marked `mutates`.
 *
 * Read-only mode is itself a guardrail, so freezing this route would make the
 * switch impossible to turn off — the panel would be stuck frozen with no way
 * back short of a database edit.
 */
adminRouter.patch(
  '/guardrails/:key',
  requirePermission(ADMIN_PERMISSIONS.ROLES_WRITE),
  validate({ params: guardrailKeyParamSchema, body: setGuardrailSchema }),
  asyncHandler(controller.setGuardrail),
);

// --- audit log -------------------------------------------------------------

adminRouter.get(
  '/audit-log',
  requirePermission(ADMIN_PERMISSIONS.AUDIT_READ),
  validate({ query: auditLogQuerySchema }),
  asyncHandler(controller.listAuditLog),
);

// --- users -----------------------------------------------------------------

/**
 * Mounted BEFORE `/users/:id`, so `snapshot` is never parsed as a user id.
 */
adminRouter.get(
  '/users/snapshot',
  requirePermission(ADMIN_PERMISSIONS.USERS_READ),
  asyncHandler(controller.getUserSnapshot),
);

adminRouter.get(
  '/users',
  requirePermission(ADMIN_PERMISSIONS.USERS_READ),
  validate({ query: listUsersQuerySchema }),
  asyncHandler(controller.listUsers),
);

adminRouter.get(
  '/users/:id',
  requirePermission(ADMIN_PERMISSIONS.USERS_READ),
  validate({ params: userIdParamSchema }),
  asyncHandler(controller.getUser),
);

adminRouter.get(
  '/users/:id/membership',
  requirePermission(ADMIN_PERMISSIONS.USERS_READ),
  validate({ params: userIdParamSchema }),
  asyncHandler(controller.listMemberships),
);

adminRouter.get(
  '/users/:id/activity',
  requirePermission(ADMIN_PERMISSIONS.USERS_READ),
  validate({ params: userIdParamSchema, query: activityQuerySchema }),
  asyncHandler(controller.listActivity),
);

adminRouter.post(
  '/users/:id/suspend',
  requirePermission(ADMIN_PERMISSIONS.USERS_SUSPEND, { mutates: true }),
  validate({ params: userIdParamSchema, body: suspendUserSchema }),
  asyncHandler(controller.suspendUser),
);

adminRouter.post(
  '/users/:id/reinstate',
  requirePermission(ADMIN_PERMISSIONS.USERS_SUSPEND, { mutates: true }),
  validate({ params: userIdParamSchema }),
  asyncHandler(controller.reinstateUser),
);

/**
 * The most dangerous route in the admin surface: it is how somebody grants
 * themselves more. Its own permission, separate from suspension, so an
 * operator who can police accounts cannot also create administrators.
 */
adminRouter.patch(
  '/users/:id/role',
  requirePermission(ADMIN_PERMISSIONS.USERS_ROLE, { mutates: true }),
  validate({ params: userIdParamSchema, body: setStaffRoleSchema }),
  asyncHandler(controller.setStaffRole),
);

// --- moderation queue ------------------------------------------------------
//
// These READ and ASSIGN. Resolution stays on the shipped `/reports/review` and
// `/moderation/flags` endpoints, which already do the second-review check, the
// badge recomputation, the audit entry and the notification (CLAUDE.md). A
// second way to resolve a report would be a second chance to skip all four.

adminRouter.get(
  '/moderation/queue',
  requirePermission(ADMIN_PERMISSIONS.MODERATION_READ),
  validate({ query: moderationQueueQuerySchema }),
  asyncHandler(controller.getModerationQueue),
);

adminRouter.get(
  '/moderation/insights',
  requirePermission(ADMIN_PERMISSIONS.MODERATION_READ),
  asyncHandler(controller.getModerationInsights),
);

adminRouter.patch(
  '/moderation/flags/:id/assignee',
  requirePermission(ADMIN_PERMISSIONS.MODERATION_RESOLVE, { mutates: true }),
  validate({ params: flagIdParamSchema, body: assignFlagSchema }),
  asyncHandler(controller.assignFlag),
);

// --- venues ----------------------------------------------------------------

adminRouter.get(
  '/venues',
  requirePermission(ADMIN_PERMISSIONS.VENUES_READ),
  validate({ query: listVenuesQuerySchema }),
  asyncHandler(controller.listVenues),
);

/**
 * The only route in this API that writes a PostGIS column from a request body.
 *
 * The insert and the spatial write commit together, so a venue can never exist
 * without a location — which would make it invisible to every radius query
 * while looking complete in the panel.
 */
adminRouter.post(
  '/venues',
  requirePermission(ADMIN_PERMISSIONS.VENUES_WRITE, { mutates: true }),
  validate({ body: createVenueSchema }),
  asyncHandler(controller.createVenue),
);

adminRouter.patch(
  '/venues/:id',
  requirePermission(ADMIN_PERMISSIONS.VENUES_WRITE, { mutates: true }),
  validate({ params: venueIdParamSchema, body: updateVenueSchema }),
  asyncHandler(controller.updateVenue),
);

// --- plans and pricing -----------------------------------------------------
//
// The catalogue only. Nothing under here can create a subscription or grant
// entitlement — see the header of `plans.service.ts`, and the test that asserts
// it. `SUBSCRIPTIONS_WRITE` names the catalogue, not anybody's access.

adminRouter.get(
  '/subscription-products',
  requirePermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_READ),
  asyncHandler(controller.listSubscriptionProducts),
);

adminRouter.patch(
  '/subscription-products/:id',
  requirePermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_WRITE, { mutates: true }),
  validate({ params: productIdParamSchema, body: updateProductSchema }),
  asyncHandler(controller.updateSubscriptionProduct),
);

adminRouter.get(
  '/subscription-products/:id/prices',
  requirePermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_READ),
  validate({ params: productIdParamSchema }),
  asyncHandler(controller.getProductPriceHistory),
);

/**
 * POST, not PATCH, and it answers 201.
 *
 * A price change CREATES a version rather than editing one, so the method says
 * what actually happens. The old amount has to survive for grandfathering and
 * for reconciling what people were really charged (spec §5.10).
 */
adminRouter.post(
  '/subscription-products/:id/prices',
  requirePermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_WRITE, { mutates: true }),
  validate({ params: productIdParamSchema, body: setProductPriceSchema }),
  asyncHandler(controller.setProductPrice),
);

// --- analytics -------------------------------------------------------------

adminRouter.get(
  '/analytics',
  requirePermission(ADMIN_PERMISSIONS.ANALYTICS_READ),
  asyncHandler(controller.getAnalytics),
);
