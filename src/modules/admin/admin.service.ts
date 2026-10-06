import { type Prisma, UserRole, prisma } from '@/db/prisma';
import { effectivePermissionsFor } from '@middleware/require-permission';
import { ApiError } from '@utils/api-error';
import { USER_COMPACT_SELECT, type UserCompact, toUserCompact } from '@utils/compact';
import { decodeCursor, paginate } from '@utils/cursor';
import { ERROR_CODES } from '@utils/error-codes';
import { getPrimaryPhotoUrlsFor } from '@modules/media/photos.service';
import { logger } from '@utils/logger';
import { ADMIN_PERMISSIONS, PERMISSION_CATALOGUE } from './admin.types';

/**
 * Admin roles, permissions, guardrails and the audit log (Batch 15).
 *
 * The admin PANEL is a separate codebase; this is the surface it calls. Every
 * mutation here writes an audit row, because the whole point of a permission
 * system is being able to answer "who gave them that" afterwards.
 *
 * Nothing in this module touches an endpoint the mobile app uses. That is a
 * hard constraint on this batch, not a coincidence: the app is shipped, so the
 * admin surface is additive or it is wrong.
 */

export interface AdminRoleView {
  id: string;
  key: string;
  title: string;
  description: string | null;
  is_system: boolean;
  /** Panel column: how many staff hold this role. */
  admins: number;
  /** Panel column: how many permissions it allows. */
  rights: number;
}

export interface PermissionView {
  id: string;
  key: string;
  title: string;
  description: string | null;
  category: string;
  allowed: boolean;
}

/** Records an admin action. Never throws into the caller's path. */
export async function writeAudit(input: {
  adminId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        admin_id: input.adminId,
        action: input.action,
        target_type: input.targetType,
        target_id: input.targetId ?? null,
        metadata: input.metadata ?? {},
        ip_address: input.ipAddress ?? null,
      },
    });
  } catch (error) {
    // Logged, not raised. A failure to record must not roll back an action that
    // already happened — an unlogged change is recoverable, a lost one is not.
    logger.error({ err: error, action: input.action }, 'failed to write admin audit log');
  }
}

/**
 * What the signed-in staff member is and may do.
 *
 * The panel calls this first and hides what the answer does not include. That
 * is presentation only — every endpoint still checks for itself, because a
 * client deciding its own permissions is the same mistake as a client deciding
 * its own entitlement.
 */
export async function describeSelf(user: { id: string; role: UserRole }): Promise<{
  id: string;
  role: UserRole;
  is_super_admin: boolean;
  permissions: string[];
  roles: { id: string; key: string; title: string }[];
}> {
  const effective = await effectivePermissionsFor(user);

  const memberships = await prisma.adminRoleMember.findMany({
    where: { user_id: user.id },
    select: { role: { select: { id: true, key: true, title: true } } },
    orderBy: { created_at: 'asc' },
  });

  return {
    id: user.id,
    role: user.role,
    is_super_admin: effective.isSuperAdmin,
    // A super admin holds everything, so the catalogue IS the answer. Returning
    // an empty set would make the panel hide every screen from the one account
    // guaranteed to have access.
    permissions: effective.isSuperAdmin
      ? PERMISSION_CATALOGUE.map((permission) => permission.key)
      : [...effective.keys].sort(),
    roles: memberships.map((row) => row.role),
  };
}

export async function listRoles(): Promise<AdminRoleView[]> {
  const roles = await prisma.adminRole.findMany({
    orderBy: [{ is_system: 'desc' }, { title: 'asc' }],
    include: {
      _count: { select: { members: true } },
      permissions: { where: { allowed: true }, select: { id: true } },
    },
  });

  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    title: role.title,
    description: role.description,
    is_system: role.is_system,
    admins: role._count.members,
    rights: role.permissions.length,
  }));
}

export async function createRole(input: {
  key: string;
  title: string;
  description?: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminRoleView> {
  const existing = await prisma.adminRole.findUnique({
    where: { key: input.key },
    select: { id: true },
  });

  if (existing) {
    throw new ApiError(ERROR_CODES.CONFLICT, 'A role with that key already exists.');
  }

  const role = await prisma.adminRole.create({
    data: {
      key: input.key,
      title: input.title,
      description: input.description ?? null,
      is_system: false,
    },
  });

  // Every permission is created DENIED rather than left absent. The matrix then
  // renders complete from the first load, instead of a new role showing fewer
  // rows than the others until somebody saves it.
  const permissions = await prisma.adminPermission.findMany({ select: { id: true } });

  await prisma.adminRolePermission.createMany({
    data: permissions.map((permission) => ({
      role_id: role.id,
      permission_id: permission.id,
      allowed: false,
    })),
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'role.create',
    targetType: 'admin_role',
    targetId: role.id,
    metadata: { key: role.key, title: role.title },
    ipAddress: input.ipAddress,
  });

  return {
    id: role.id,
    key: role.key,
    title: role.title,
    description: role.description,
    is_system: false,
    admins: 0,
    rights: 0,
  };
}

export async function updateRole(input: {
  roleId: string;
  title?: string;
  description?: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<AdminRoleView> {
  const role = await prisma.adminRole.findUnique({ where: { id: input.roleId } });

  if (!role) {
    throw ApiError.notFound('That role does not exist.');
  }

  const updated = await prisma.adminRole.update({
    where: { id: role.id },
    data: {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    include: {
      _count: { select: { members: true } },
      permissions: { where: { allowed: true }, select: { id: true } },
    },
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'role.update',
    targetType: 'admin_role',
    targetId: role.id,
    metadata: { title: input.title ?? null, description: input.description ?? null },
    ipAddress: input.ipAddress,
  });

  return {
    id: updated.id,
    key: updated.key,
    title: updated.title,
    description: updated.description,
    is_system: updated.is_system,
    admins: updated._count.members,
    rights: updated.permissions.length,
  };
}

export async function deleteRole(input: {
  roleId: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<void> {
  const role = await prisma.adminRole.findUnique({
    where: { id: input.roleId },
    include: { _count: { select: { members: true } } },
  });

  if (!role) {
    throw ApiError.notFound('That role does not exist.');
  }

  if (role.is_system) {
    // Deleting "Administrator" while somebody depends on it is not a mistake
    // worth leaving available.
    throw new ApiError(ERROR_CODES.CONFLICT, 'A built-in role cannot be deleted.');
  }

  if (role._count.members > 0) {
    // Refused rather than cascading. Removing a role silently strips access
    // from everyone holding it, and the first anybody knows is a 403 mid-task.
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      'Remove the people holding this role before deleting it.',
      { members: role._count.members },
    );
  }

  await prisma.adminRole.delete({ where: { id: role.id } });

  await writeAudit({
    adminId: input.adminId,
    action: 'role.delete',
    targetType: 'admin_role',
    targetId: role.id,
    metadata: { key: role.key, title: role.title },
    ipAddress: input.ipAddress,
  });
}

/** The full matrix for one role: every permission, allowed or not. */
export async function getRolePermissions(roleId: string): Promise<{
  role: { id: string; key: string; title: string; is_system: boolean };
  permissions: PermissionView[];
}> {
  const role = await prisma.adminRole.findUnique({
    where: { id: roleId },
    select: { id: true, key: true, title: true, is_system: true },
  });

  if (!role) {
    throw ApiError.notFound('That role does not exist.');
  }

  const permissions = await prisma.adminPermission.findMany({
    orderBy: [{ category: 'asc' }, { title: 'asc' }],
    include: { roles: { where: { role_id: roleId }, select: { allowed: true } } },
  });

  return {
    role,
    permissions: permissions.map((permission) => ({
      id: permission.id,
      key: permission.key,
      title: permission.title,
      description: permission.description,
      category: permission.category,
      // No row means not allowed. Absence-as-denial, so a permission added to
      // the catalogue later is off everywhere until somebody turns it on.
      allowed: permission.roles[0]?.allowed ?? false,
    })),
  };
}

export async function setRolePermissions(input: {
  roleId: string;
  permissions: { key: string; allowed: boolean }[];
  adminId: string;
  ipAddress?: string | null;
}): Promise<{ role: { id: string; key: string }; changed: number }> {
  const role = await prisma.adminRole.findUnique({
    where: { id: input.roleId },
    select: { id: true, key: true },
  });

  if (!role) {
    throw ApiError.notFound('That role does not exist.');
  }

  const known = await prisma.adminPermission.findMany({ select: { id: true, key: true } });
  const byKey = new Map(known.map((permission) => [permission.key, permission.id]));

  const unknown = input.permissions.filter((entry) => !byKey.has(entry.key));

  if (unknown.length > 0) {
    // Refused rather than ignored. A key the catalogue does not contain is a
    // panel sending something stale, and silently dropping it would let the
    // operator believe they had changed a setting that does not exist.
    throw ApiError.validation({
      permissions: [`Unknown permission keys: ${unknown.map((entry) => entry.key).join(', ')}`],
    });
  }

  // One transaction for the whole matrix. A half-saved matrix is a role with
  // access somebody has already decided it should not have.
  await prisma.$transaction(
    input.permissions.map((entry) =>
      prisma.adminRolePermission.upsert({
        where: {
          role_id_permission_id: { role_id: role.id, permission_id: byKey.get(entry.key)! },
        },
        create: {
          role_id: role.id,
          permission_id: byKey.get(entry.key)!,
          allowed: entry.allowed,
        },
        update: { allowed: entry.allowed },
      }),
    ),
  );

  await writeAudit({
    adminId: input.adminId,
    action: 'role.permissions.set',
    targetType: 'admin_role',
    targetId: role.id,
    metadata: {
      role_key: role.key,
      // The full set, not a delta. An audit entry has to stand alone: a delta
      // is meaningless once the row it referenced has changed again.
      granted: input.permissions.filter((entry) => entry.allowed).map((entry) => entry.key),
      denied: input.permissions.filter((entry) => !entry.allowed).map((entry) => entry.key),
    },
    ipAddress: input.ipAddress,
  });

  return { role, changed: input.permissions.length };
}

export async function listRoleMembers(roleId: string): Promise<{
  role: { id: string; key: string; title: string };
  members: (UserCompact & { granted_at: string })[];
}> {
  const role = await prisma.adminRole.findUnique({
    where: { id: roleId },
    select: { id: true, key: true, title: true },
  });

  if (!role) {
    throw ApiError.notFound('That role does not exist.');
  }

  const members = await prisma.adminRoleMember.findMany({
    where: { role_id: roleId },
    orderBy: { created_at: 'asc' },
    include: { user: { select: USER_COMPACT_SELECT } },
  });

  const photoUrls = await getPrimaryPhotoUrlsFor(members.map((row) => row.user_id));

  return {
    role,
    members: members.map((row) => ({
      ...toUserCompact(row.user, photoUrls.get(row.user_id) ?? null),
      granted_at: row.created_at.toISOString(),
    })),
  };
}

export async function addRoleMember(input: {
  roleId: string;
  userId: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<void> {
  const [role, user] = await Promise.all([
    prisma.adminRole.findUnique({ where: { id: input.roleId }, select: { id: true, key: true } }),
    prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, role: true, deleted_at: true },
    }),
  ]);

  if (!role) {
    throw ApiError.notFound('That role does not exist.');
  }

  if (!user || user.deleted_at !== null) {
    throw ApiError.notFound('That account does not exist.');
  }

  if (user.role === UserRole.user) {
    // THE RULE THAT KEEPS THIS SAFE: a granular role narrows what a staff
    // member may do; it never makes somebody staff. Allowing this would turn
    // role assignment into privilege escalation, because the gate would be a
    // table every admin can write to.
    throw new ApiError(
      ERROR_CODES.CONFLICT,
      'Give the account a staff role first. A permission role does not grant staff access on its own.',
    );
  }

  await prisma.adminRoleMember.upsert({
    where: { user_id_role_id: { user_id: user.id, role_id: role.id } },
    create: { user_id: user.id, role_id: role.id, granted_by_id: input.adminId },
    // Idempotent: granting a role somebody already holds is not an error worth
    // showing an operator.
    update: {},
  });

  await writeAudit({
    adminId: input.adminId,
    action: 'role.member.add',
    targetType: 'user',
    targetId: user.id,
    metadata: { role_id: role.id, role_key: role.key },
    ipAddress: input.ipAddress,
  });
}

export async function removeRoleMember(input: {
  roleId: string;
  userId: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<void> {
  const membership = await prisma.adminRoleMember.findUnique({
    where: { user_id_role_id: { user_id: input.userId, role_id: input.roleId } },
    include: { role: { select: { key: true } } },
  });

  if (!membership) {
    throw ApiError.notFound('That person does not hold this role.');
  }

  await prisma.adminRoleMember.delete({ where: { id: membership.id } });

  await writeAudit({
    adminId: input.adminId,
    action: 'role.member.remove',
    targetType: 'user',
    targetId: input.userId,
    metadata: { role_id: input.roleId, role_key: membership.role.key },
    ipAddress: input.ipAddress,
  });
}

export async function listGuardrails(): Promise<
  { key: string; title: string; description: string | null; enabled: boolean; updated_at: string }[]
> {
  const guardrails = await prisma.adminGuardrail.findMany({ orderBy: { title: 'asc' } });

  return guardrails.map((guardrail) => ({
    key: guardrail.key,
    title: guardrail.title,
    description: guardrail.description,
    enabled: guardrail.enabled,
    updated_at: guardrail.updated_at.toISOString(),
  }));
}

export async function setGuardrail(input: {
  key: string;
  enabled: boolean;
  adminId: string;
  ipAddress?: string | null;
}): Promise<{ key: string; enabled: boolean }> {
  const guardrail = await prisma.adminGuardrail.findUnique({ where: { key: input.key } });

  if (!guardrail) {
    // Not created on demand. A guardrail only exists once an endpoint reads it,
    // so an unknown key is a stale panel rather than a new switch.
    throw ApiError.notFound('That guardrail does not exist.');
  }

  const updated = await prisma.adminGuardrail.update({
    where: { key: input.key },
    data: { enabled: input.enabled, updated_by_id: input.adminId },
  });

  await writeAudit({
    adminId: input.adminId,
    action: input.enabled ? 'guardrail.enable' : 'guardrail.disable',
    targetType: 'admin_guardrail',
    targetId: guardrail.id,
    metadata: { key: guardrail.key },
    ipAddress: input.ipAddress,
  });

  logger.warn({ guardrail: guardrail.key, enabled: input.enabled }, 'admin guardrail changed');

  return { key: updated.key, enabled: updated.enabled };
}

export interface AuditEntryView {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: unknown;
  ip_address: string | null;
  created_at: string;
  admin: UserCompact | null;
}

export async function listAuditLog(options: {
  actorId?: string;
  targetType?: string;
  targetId?: string;
  action?: string;
  limit: number;
  cursor?: string;
}): Promise<{
  entries: AuditEntryView[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;

  const rows = await prisma.adminAuditLog.findMany({
    where: {
      ...(options.actorId ? { admin_id: options.actorId } : {}),
      ...(options.targetType ? { target_type: options.targetType } : {}),
      ...(options.targetId ? { target_id: options.targetId } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(after ? { created_at: { lt: new Date(String(after.k)) } } : {}),
    },
    // Newest first. Unlike a review queue, this is a record being read rather
    // than work to get through — the question is almost always "what just
    // happened".
    orderBy: { created_at: 'desc' },
    take: options.limit + 1,
    include: { admin: { select: USER_COMPACT_SELECT } },
  });

  const page = paginate(rows, options.limit, (row) => ({
    k: row.created_at.toISOString(),
    id: row.id,
  }));

  const photoUrls = await getPrimaryPhotoUrlsFor(page.items.map((row) => row.admin_id));

  return {
    entries: page.items.map((row) => ({
      id: row.id,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      metadata: row.metadata,
      ip_address: row.ip_address,
      created_at: row.created_at.toISOString(),
      admin: toUserCompact(row.admin, photoUrls.get(row.admin_id) ?? null),
    })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    limit: page.limit,
  };
}

export { ADMIN_PERMISSIONS };
