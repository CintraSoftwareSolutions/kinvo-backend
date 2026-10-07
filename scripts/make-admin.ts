import { prisma, UserRole } from '@/db/prisma';
import { seedAdminRbac } from '../prisma/seeds/admin-rbac';

/**
 * Promotes an existing account to staff, so somebody can sign into the admin
 * panel for the first time.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT. `PATCH /admin/users/{id}/role` is
 * how roles change once a panel is running, and it requires `users.role` —
 * which only an administrator holds. That is correct and it is also a bootstrap
 * problem: with no administrator in the database, nothing can create one, and
 * an endpoint that could would be an unauthenticated way to grant yourself the
 * most privileged role in the product.
 *
 * So the first administrator is made by someone with database access, which is
 * the only authority that should be able to. After that, every further change
 * goes through the audited endpoint.
 *
 * It does NOT create an account. Register normally through the API or the app
 * first, then promote that email — so the password is argon2-hashed by the same
 * code path as every other account, and this script never touches credentials.
 *
 *   npx tsx scripts/make-admin.ts someone@example.com
 *   npx tsx scripts/make-admin.ts someone@example.com --moderator
 *
 * On the server, run it inside the API container so it uses the same
 * DATABASE_URL the API does.
 */

/* eslint-disable no-console -- a CLI script's output IS its result. */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((arg) => !arg.startsWith('--'))?.trim().toLowerCase();
  const role = args.includes('--moderator') ? UserRole.moderator : UserRole.admin;

  if (!email) {
    console.error('Usage: npx tsx scripts/make-admin.ts <email> [--moderator]');
    process.exitCode = 1;
    return;
  }

  // Identities carry the email, not the user row — one account can sign in with
  // several, and `email` on User is a denormalised copy.
  const identity = await prisma.authIdentity.findFirst({
    where: { identifier: email },
    select: { user: { select: { id: true, display_name: true, role: true, deleted_at: true } } },
  });

  const user = identity?.user;

  if (!user) {
    console.error(`No account found for ${email}.`);
    console.error('Register it through the API first — this script never creates credentials.');
    process.exitCode = 1;
    return;
  }

  if (user.deleted_at !== null) {
    // Promoting a deleted account would resurrect it as staff.
    console.error(`${email} is deleted. Refusing to promote it.`);
    process.exitCode = 1;
    return;
  }

  if (user.role === role) {
    console.log(`${email} is already ${role}. Nothing to do.`);
    return;
  }

  // The roles and the permission matrix have to exist before a staff account is
  // any use, and seeding is idempotent — so it runs here rather than being a
  // separate step somebody can forget and then wonder why the panel is empty.
  const seeded = await seedAdminRbac();

  await prisma.user.update({ where: { id: user.id }, data: { role } });

  console.log(`${email} (${user.display_name}) is now ${role}.`);
  console.log(`RBAC seeded: ${seeded.roles} roles, ${seeded.permissions} permissions.`);
  console.log('');
  console.log('`admin` holds every permission without consulting the matrix, so it');
  console.log('cannot be locked out. `moderator` holds only what its granular roles allow.');
}

main()
  .catch((error: unknown) => {
    // The WHOLE error, not just `.message`. Prisma puts the useful part — a
    // refused connection, a wrong DATABASE_URL, a missing table — outside the
    // message, and printing only the message left "Invalid invocation" with no
    // cause, which is indistinguishable from a bug in this script.
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

/* eslint-enable no-console */
