import type { RequestHandler } from 'express';

import { UserRole, prisma } from '@/db/prisma';
import { ApiError } from '@utils/api-error';
import { ERROR_CODES } from '@utils/error-codes';
import { GUARDRAIL_KEYS, type AdminPermissionKey } from '@modules/admin/admin.types';

/**
 * Granular permission check for admin endpoints (Batch 15).
 *
 * DISTINCT FROM `requireRole`, which is unchanged and still guards everything
 * that existed before this. `User.role` remains the coarse gate — is this
 * person staff at all — and this narrows within that.
 *
 * TWO RULES THAT MATTER MORE THAN THE REST:
 *
 * A granular role NARROWS; it never GRANTS staff status. An account with
 * `role: 'user'` is refused no matter what rows point at it, so assigning
 * somebody a role can never be a privilege-escalation path. If it could, the
 * gate would be a table every admin can write to.
 *
 * `role: 'admin'` means every permission, without consulting the tables. An
 * administrator cannot be locked out by a row somebody edited, and the matrix
 * cannot become a way to strand the only person able to fix it.
 */

/** Set on the request so a handler can report what the caller may do. */
export interface EffectivePermissions {
  keys: Set<string>;
  isSuperAdmin: boolean;
}

/**
 * Everything this account may do, from its granular roles.
 *
 * A MISSING row means not allowed. Absence-as-denial is what makes adding a
 * permission to the catalogue safe: it is off for every existing role until
 * somebody turns it on, rather than granted to all of them at once.
 */
export async function effectivePermissionsFor(user: {
  id: string;
  role: UserRole;
}): Promise<EffectivePermissions> {
  if (user.role === UserRole.user) {
    // Not staff. Role memberships are ignored entirely rather than merged,
    // which is the rule above expressed in code.
    return { keys: new Set(), isSuperAdmin: false };
  }

  if (user.role === UserRole.admin) {
    return { keys: new Set(), isSuperAdmin: true };
  }

  const rows = await prisma.adminRolePermission.findMany({
    where: {
      allowed: true,
      role: { members: { some: { user_id: user.id } } },
    },
    select: { permission: { select: { key: true } } },
  });

  return {
    keys: new Set(rows.map((row) => row.permission.key)),
    isSuperAdmin: false,
  };
}

export function hasPermission(
  effective: EffectivePermissions,
  permission: AdminPermissionKey,
): boolean {
  return effective.isSuperAdmin || effective.keys.has(permission);
}

/**
 * Is admin read-only mode on?
 *
 * Read per request rather than cached. A guardrail exists to be flipped during
 * an incident, and a sixty-second cache means a minute of writes somebody
 * believes they have already stopped.
 */
async function readOnlyModeEnabled(): Promise<boolean> {
  const guardrail = await prisma.adminGuardrail.findUnique({
    where: { key: GUARDRAIL_KEYS.READ_ONLY },
    select: { enabled: true },
  });

  return guardrail?.enabled ?? false;
}

/**
 * Guards one admin endpoint.
 *
 * `mutates` marks a route that changes something, and those are what read-only
 * mode refuses. Declared per route rather than inferred from the HTTP method,
 * because a POST that only reads — a search with a long body, say — should stay
 * available while the panel is frozen.
 */
export function requirePermission(
  permission: AdminPermissionKey,
  options: { mutates?: boolean } = {},
): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;

    if (!user) {
      next(new ApiError(ERROR_CODES.AUTH_REQUIRED));
      return;
    }

    void (async () => {
      try {
        const effective = await effectivePermissionsFor(user);

        if (!hasPermission(effective, permission)) {
          // 403 rather than the block-style 404. A staff member denied one
          // permission is not being hidden from — they are being told they
          // lack it, which is what lets them ask for it.
          next(
            new ApiError(ERROR_CODES.FORBIDDEN, 'You do not have permission to do this.', {
              required_permission: permission,
            }),
          );
          return;
        }

        if (options.mutates && (await readOnlyModeEnabled())) {
          next(
            new ApiError(
              ERROR_CODES.FORBIDDEN,
              'The admin panel is in read-only mode. Changes are paused.',
              { guardrail: GUARDRAIL_KEYS.READ_ONLY },
            ),
          );
          return;
        }

        req.adminPermissions = effective;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
