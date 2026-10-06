import { Router } from 'express';

import { authenticate } from '@middleware/authenticate';
import { requirePermission } from '@middleware/require-permission';
import { requireRole } from '@middleware/require-role';
import { validate } from '@middleware/validate';
import { asyncHandler } from '@utils/async-handler';
import * as controller from './admin.controller';
import { ADMIN_PERMISSIONS } from './admin.types';
import {
  addRoleMemberSchema,
  auditLogQuerySchema,
  createRoleSchema,
  guardrailKeyParamSchema,
  roleIdParamSchema,
  roleMemberParamsSchema,
  setGuardrailSchema,
  setPermissionsSchema,
  updateRoleSchema,
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
