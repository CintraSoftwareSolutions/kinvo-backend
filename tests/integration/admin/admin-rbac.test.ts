import { API_PREFIX } from '@config/constants';
import { prisma } from '@/db/prisma';
import { ADMIN_PERMISSIONS, GUARDRAIL_KEYS } from '@modules/admin/admin.types';
import { seedAdminRbac } from '../../../prisma/seeds/admin-rbac';
import { closeDatabase, resetDatabase } from '../../helpers/db';
import { authHeader, createAuthenticatedUser } from '../../helpers/auth';
import { api, expectSuccessEnvelope } from '../../helpers/request';
import { connectRedis, disconnectRedis, seedEntitlements } from '../../helpers/entitlements';

/**
 * Admin roles, permissions and guardrails (Batch 15).
 *
 * Two rules carry most of this file, and both are about blast radius. The admin
 * surface can read anyone's identity documents and change who has access, so a
 * mistake here is worth more than a mistake almost anywhere else in the product.
 *
 *   A granular role NARROWS; it never GRANTS staff status.
 *   `role: admin` holds every permission without consulting the tables.
 *
 * The first stops role assignment becoming a privilege-escalation path. The
 * second stops the matrix becoming a way to lock out the only account able to
 * fix it.
 */

const ADMIN = `${API_PREFIX}/admin`;

/** A staff account holding one granular role, by key. */
async function staffWithRole(roleKey: string) {
  const user = await createAuthenticatedUser({ role: 'moderator' });
  const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: roleKey } });

  await prisma.adminRoleMember.create({ data: { user_id: user.user_id, role_id: role.id } });

  return { ...user, role };
}

beforeAll(connectRedis);

beforeEach(async () => {
  await resetDatabase();
  await seedEntitlements();
  await seedAdminRbac();
});

afterAll(async () => {
  await closeDatabase();
  await disconnectRedis();
});

describe('who gets in at all', () => {
  it('refuses an ordinary account', async () => {
    const user = await createAuthenticatedUser();

    const response = await api.get(`${ADMIN}/me`).set(authHeader(user.tokens));

    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await api.get(`${ADMIN}/me`);

    expect(response.status).toBe(401);
  });

  it('lets any staff member ask what they hold', async () => {
    const staff = await staffWithRole('analyst');

    // No permission of its own: requiring one to discover your permissions is
    // a loop, and the panel needs this before it can render anything.
    const response = await api.get(`${ADMIN}/me`).set(authHeader(staff.tokens));

    expectSuccessEnvelope(response.body);
    expect(response.body.data.role).toBe('moderator');
    expect(response.body.data.is_super_admin).toBe(false);
    expect(response.body.data.permissions).toContain(ADMIN_PERMISSIONS.ANALYTICS_READ);
    expect(response.body.data.permissions).not.toContain(ADMIN_PERMISSIONS.ROLES_WRITE);
    expect(response.body.data.roles[0].key).toBe('analyst');
  });
});

describe('an admin cannot be locked out by the tables', () => {
  it('gives role: admin every permission without any membership', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    const response = await api.get(`${ADMIN}/me`).set(authHeader(admin.tokens));

    expect(response.body.data.is_super_admin).toBe(true);
    // The whole catalogue, not an empty set — otherwise the panel would hide
    // every screen from the one account guaranteed to have access.
    expect(response.body.data.permissions).toContain(ADMIN_PERMISSIONS.ROLES_WRITE);
    expect(response.body.data.permissions.length).toBeGreaterThan(10);
    expect(response.body.data.roles).toEqual([]);
  });

  it('still admits an admin after every matrix cell is denied', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    // Somebody turns everything off, everywhere.
    await prisma.adminRolePermission.updateMany({ data: { allowed: false } });

    const response = await api.get(`${ADMIN}/roles`).set(authHeader(admin.tokens));

    expect(response.status).toBe(200);
  });
});

describe('a granular role narrows, it never grants staff access', () => {
  it('refuses to attach a role to an ordinary account', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const ordinary = await createAuthenticatedUser();
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'moderator' } });

    const response = await api
      .post(`${ADMIN}/roles/${role.id}/members`)
      .set(authHeader(admin.tokens))
      .send({ user_id: ordinary.user_id });

    // Allowing this would make role assignment a privilege-escalation path:
    // the gate would be a table every admin can write to.
    expect(response.status).toBe(409);

    expect(await prisma.adminRoleMember.count({ where: { user_id: ordinary.user_id } })).toBe(0);
  });

  it('ignores a membership attached behind the API to a non-staff account', async () => {
    const ordinary = await createAuthenticatedUser();
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'administrator' } });

    // Written straight to the table, as a bad migration or a careless script
    // might. The rule has to hold at resolution time, not only at the endpoint.
    await prisma.adminRoleMember.create({
      data: { user_id: ordinary.user_id, role_id: role.id },
    });

    const response = await api.get(`${ADMIN}/me`).set(authHeader(ordinary.tokens));

    expect(response.status).toBe(403);
  });
});

describe('the permission matrix', () => {
  it('returns every permission with its state, absent meaning denied', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'analyst' } });

    const response = await api
      .get(`${ADMIN}/roles/${role.id}/permissions`)
      .set(authHeader(admin.tokens));

    const byKey = new Map<string, boolean>(
      response.body.data.permissions.map((p: { key: string; allowed: boolean }) => [
        p.key,
        p.allowed,
      ]),
    );

    // The matrix is COMPLETE: every catalogue key appears, allowed or not, so
    // the panel never renders a role with fewer rows than its neighbours.
    expect(byKey.size).toBeGreaterThan(10);
    expect(byKey.get(ADMIN_PERMISSIONS.ANALYTICS_READ)).toBe(true);
    expect(byKey.get(ADMIN_PERMISSIONS.ROLES_WRITE)).toBe(false);
  });

  it('saves the whole matrix in one request', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'analyst' } });

    const response = await api
      .put(`${ADMIN}/roles/${role.id}/permissions`)
      .set(authHeader(admin.tokens))
      .send({
        permissions: [
          { key: ADMIN_PERMISSIONS.ANALYTICS_READ, allowed: false },
          { key: ADMIN_PERMISSIONS.VENUES_WRITE, allowed: true },
        ],
      });

    expect(response.status).toBe(200);

    const after = await api
      .get(`${ADMIN}/roles/${role.id}/permissions`)
      .set(authHeader(admin.tokens));

    const byKey = new Map<string, boolean>(
      after.body.data.permissions.map((p: { key: string; allowed: boolean }) => [p.key, p.allowed]),
    );

    expect(byKey.get(ADMIN_PERMISSIONS.ANALYTICS_READ)).toBe(false);
    expect(byKey.get(ADMIN_PERMISSIONS.VENUES_WRITE)).toBe(true);
  });

  it('refuses an unknown key rather than ignoring it', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'analyst' } });

    const response = await api
      .put(`${ADMIN}/roles/${role.id}/permissions`)
      .set(authHeader(admin.tokens))
      .send({ permissions: [{ key: 'users.invent_money', allowed: true }] });

    // Silently dropping it would let the operator believe they had changed a
    // setting that does not exist.
    expect(response.status).toBe(400);
  });

  it('takes effect immediately, with no cache to wait out', async () => {
    const staff = await staffWithRole('analyst');

    const before = await api.get(`${ADMIN}/audit-log`).set(authHeader(staff.tokens));
    expect(before.status).toBe(403);

    const flag = await prisma.adminPermission.findUniqueOrThrow({
      where: { key: ADMIN_PERMISSIONS.AUDIT_READ },
    });
    await prisma.adminRolePermission.updateMany({
      where: { role_id: staff.role.id, permission_id: flag.id },
      data: { allowed: true },
    });

    const after = await api.get(`${ADMIN}/audit-log`).set(authHeader(staff.tokens));
    expect(after.status).toBe(200);
  });
});

describe('roles', () => {
  it('creates a role with every permission denied', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    const created = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'support', title: 'Support' });

    expect(created.status).toBe(201);
    expect(created.body.data.role.rights).toBe(0);
    expect(created.body.data.role.is_system).toBe(false);

    const matrix = await api
      .get(`${ADMIN}/roles/${created.body.data.role.id}/permissions`)
      .set(authHeader(admin.tokens));

    // Complete and all denied, rather than empty.
    expect(matrix.body.data.permissions.length).toBeGreaterThan(10);
    expect(matrix.body.data.permissions.every((p: { allowed: boolean }) => !p.allowed)).toBe(true);
  });

  it('rejects a duplicate key', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    const response = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'moderator', title: 'Another moderator' });

    expect(response.status).toBe(409);
  });

  it('rejects a key that code could not match on', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    const response = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'Support Team', title: 'Support' });

    expect(response.status).toBe(400);
  });

  it('refuses to delete a built-in role', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'administrator' } });

    const response = await api.delete(`${ADMIN}/roles/${role.id}`).set(authHeader(admin.tokens));

    expect(response.status).toBe(409);
  });

  it('refuses to delete a role somebody still holds', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const staff = await staffWithRole('analyst');

    const response = await api
      .delete(`${ADMIN}/roles/${staff.role.id}`)
      .set(authHeader(admin.tokens));

    // Cascading would strip access from everyone at once, and the first they
    // would know is a 403 mid-task.
    expect(response.status).toBe(409);
  });

  it('counts holders and allowed permissions, which are the panel columns', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    await staffWithRole('moderator');

    const response = await api.get(`${ADMIN}/roles`).set(authHeader(admin.tokens));

    const moderator = response.body.data.roles.find(
      (role: { key: string }) => role.key === 'moderator',
    );

    expect(moderator.admins).toBe(1);
    expect(moderator.rights).toBeGreaterThan(0);
  });

  it('grants and removes a role idempotently', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const staff = await createAuthenticatedUser({ role: 'moderator' });
    const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'analyst' } });

    const first = await api
      .post(`${ADMIN}/roles/${role.id}/members`)
      .set(authHeader(admin.tokens))
      .send({ user_id: staff.user_id });
    const second = await api
      .post(`${ADMIN}/roles/${role.id}/members`)
      .set(authHeader(admin.tokens))
      .send({ user_id: staff.user_id });

    expect(first.status).toBe(201);
    // Granting a role somebody already holds is not an error worth showing.
    expect(second.status).toBe(201);
    expect(await prisma.adminRoleMember.count({ where: { user_id: staff.user_id } })).toBe(1);

    const removed = await api
      .delete(`${ADMIN}/roles/${role.id}/members/${staff.user_id}`)
      .set(authHeader(admin.tokens));

    expect(removed.status).toBe(200);
    expect(await prisma.adminRoleMember.count({ where: { user_id: staff.user_id } })).toBe(0);
  });
});

describe('read-only mode', () => {
  async function setReadOnly(enabled: boolean) {
    await prisma.adminGuardrail.update({
      where: { key: GUARDRAIL_KEYS.READ_ONLY },
      data: { enabled },
    });
  }

  it('freezes changes but not reads', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    await setReadOnly(true);

    const read = await api.get(`${ADMIN}/roles`).set(authHeader(admin.tokens));
    const write = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'frozen', title: 'Frozen' });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    expect(write.body.error.details.guardrail).toBe(GUARDRAIL_KEYS.READ_ONLY);
  });

  it('can always be turned back off', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    await setReadOnly(true);

    // The switch is itself a guardrail. Freezing this route would leave the
    // panel stuck with no way back short of a database edit.
    const response = await api
      .patch(`${ADMIN}/guardrails/${GUARDRAIL_KEYS.READ_ONLY}`)
      .set(authHeader(admin.tokens))
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(response.body.data.enabled).toBe(false);

    const write = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'thawed', title: 'Thawed' });

    expect(write.status).toBe(201);
  });

  it('404s an unknown guardrail rather than creating one', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    const response = await api
      .patch(`${ADMIN}/guardrails/admin.invent_a_switch`)
      .set(authHeader(admin.tokens))
      .send({ enabled: true });

    // A guardrail exists only once an endpoint reads it.
    expect(response.status).toBe(404);
  });
});

describe('the audit log', () => {
  it('records every change with the actor and the target', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'audited', title: 'Audited' });

    const response = await api.get(`${ADMIN}/audit-log`).set(authHeader(admin.tokens));

    const entry = response.body.data.find(
      (row: { action: string }) => row.action === 'role.create',
    );

    expect(entry).toBeDefined();
    expect(entry.admin.id).toBe(admin.user_id);
    expect(entry.target_type).toBe('admin_role');
    expect(entry.ip_address).not.toBeNull();
  });

  it('filters to one actor or one target', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });
    const other = await createAuthenticatedUser({ role: 'admin' });

    const mineCreated = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'role_one', title: 'One' });
    const theirsCreated = await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(other.tokens))
      .send({ key: 'role_two', title: 'Two' });

    // Asserted, because a rejected create writes no audit row and the filter
    // would then pass on an empty list for the wrong reason.
    expect(mineCreated.status).toBe(201);
    expect(theirsCreated.status).toBe(201);

    const mine = await api
      .get(`${ADMIN}/audit-log?actor_id=${admin.user_id}`)
      .set(authHeader(admin.tokens));

    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].admin.id).toBe(admin.user_id);
  });

  it('is newest first, unlike a review queue', async () => {
    const admin = await createAuthenticatedUser({ role: 'admin' });

    await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'older', title: 'Older' });
    await api
      .post(`${ADMIN}/roles`)
      .set(authHeader(admin.tokens))
      .send({ key: 'newer', title: 'Newer' });

    const response = await api.get(`${ADMIN}/audit-log`).set(authHeader(admin.tokens));

    // A record being read, not work to get through: the question is almost
    // always "what just happened".
    expect(response.body.data[0].metadata.key).toBe('newer');
    expect(response.body.meta.pagination).toBeDefined();
  });

  it('is not readable without the permission', async () => {
    const staff = await staffWithRole('moderator');

    const response = await api.get(`${ADMIN}/audit-log`).set(authHeader(staff.tokens));

    expect(response.status).toBe(403);
    expect(response.body.error.details.required_permission).toBe(ADMIN_PERMISSIONS.AUDIT_READ);
  });
});
