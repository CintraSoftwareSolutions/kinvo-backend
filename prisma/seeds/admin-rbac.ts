import { prisma } from '@/db/prisma';
import {
  GUARDRAIL_CATALOGUE,
  PERMISSION_CATALOGUE,
  SYSTEM_ROLES,
} from '@modules/admin/admin.types';

/**
 * Admin roles, the permission catalogue, and guardrails (Batch 15).
 *
 * The catalogue is seeded FROM CODE rather than created through the API,
 * because `requirePermission` matches on these keys literally. A permission row
 * that no endpoint checks would render as a toggle in the panel which promises
 * something nothing enforces.
 *
 * Idempotent, and safe to re-run: permissions are upserted by key, and a role's
 * matrix is only filled in for cells that do not exist yet. That last part
 * matters — re-seeding must never silently undo a deliberate change somebody
 * made in the panel.
 */
export async function seedAdminRbac(): Promise<{
  permissions: number;
  roles: number;
  guardrails: number;
}> {
  // One transaction for the catalogue. A half-applied permission list is worse
  // than none: the matrix would render with gaps and a role would appear to
  // lack access it was granted.
  const permissions = await prisma.$transaction(
    PERMISSION_CATALOGUE.map((permission) =>
      prisma.adminPermission.upsert({
        where: { key: permission.key },
        create: permission,
        update: {
          title: permission.title,
          description: permission.description,
          category: permission.category,
        },
      }),
    ),
  );

  const byKey = new Map(permissions.map((permission) => [permission.key, permission.id]));

  for (const role of SYSTEM_ROLES) {
    const record = await prisma.adminRole.upsert({
      where: { key: role.key },
      create: {
        key: role.key,
        title: role.title,
        description: role.description,
        is_system: true,
      },
      // Deliberately does NOT reset `is_system` or touch the matrix.
      update: { title: role.title, description: role.description },
    });

    const granted =
      role.permissions === 'all'
        ? PERMISSION_CATALOGUE.map((permission) => permission.key)
        : role.permissions;

    for (const permission of PERMISSION_CATALOGUE) {
      const permissionId = byKey.get(permission.key);

      if (!permissionId) {
        continue;
      }

      // `create` only. An existing cell is left exactly as it is, so somebody
      // who narrowed a seeded role in the panel does not find it widened again
      // after the next deploy.
      const existing = await prisma.adminRolePermission.findUnique({
        where: { role_id_permission_id: { role_id: record.id, permission_id: permissionId } },
        select: { id: true },
      });

      if (existing) {
        continue;
      }

      await prisma.adminRolePermission.create({
        data: {
          role_id: record.id,
          permission_id: permissionId,
          allowed: granted.includes(permission.key),
        },
      });
    }
  }

  for (const guardrail of GUARDRAIL_CATALOGUE) {
    await prisma.adminGuardrail.upsert({
      where: { key: guardrail.key },
      create: guardrail,
      // `enabled` is never reset. It is an operational switch somebody may have
      // deliberately flipped, and a deploy must not turn it back.
      update: { title: guardrail.title, description: guardrail.description },
    });
  }

  return {
    permissions: PERMISSION_CATALOGUE.length,
    roles: SYSTEM_ROLES.length,
    guardrails: GUARDRAIL_CATALOGUE.length,
  };
}
