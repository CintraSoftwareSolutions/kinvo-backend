/**
 * The admin permission vocabulary (Batch 15).
 *
 * Declared in code, not created through the API, and imported by both the seed
 * and `requirePermission`. A typo is then a compile error rather than a
 * permission that is silently never granted — the same reason the entitlement
 * flag keys live in `entitlements.types.ts`.
 *
 * THE RULE FOR ADDING ONE: a permission belongs here only when an endpoint
 * actually checks it. A key nothing reads renders as a toggle in the panel that
 * promises something no code enforces, which is worse than a missing feature —
 * somebody will grant it and believe they have restricted access.
 */

export const ADMIN_PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_SUSPEND: 'users.suspend',
  USERS_ROLE: 'users.role',
  MODERATION_READ: 'moderation.read',
  MODERATION_RESOLVE: 'moderation.resolve',
  VERIFICATION_READ: 'verification.read',
  VERIFICATION_REVIEW: 'verification.review',
  VENUES_READ: 'venues.read',
  VENUES_WRITE: 'venues.write',
  SUBSCRIPTIONS_READ: 'subscriptions.read',
  SUBSCRIPTIONS_WRITE: 'subscriptions.write',
  ANALYTICS_READ: 'analytics.read',
  AUDIT_READ: 'audit.read',
  ROLES_READ: 'roles.read',
  ROLES_WRITE: 'roles.write',
} as const;

export type AdminPermissionKey = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

/** Groups the matrix into sections in the panel. */
export const PERMISSION_CATALOGUE: {
  key: AdminPermissionKey;
  title: string;
  description: string;
  category: string;
}[] = [
  {
    key: ADMIN_PERMISSIONS.USERS_READ,
    title: 'View users',
    description: 'Read the user list, a single account, and its membership and activity history.',
    category: 'Users',
  },
  {
    key: ADMIN_PERMISSIONS.USERS_SUSPEND,
    title: 'Suspend and reinstate accounts',
    description: 'Suspend an account or lift a suspension. Never deletes anything.',
    category: 'Users',
  },
  {
    key: ADMIN_PERMISSIONS.USERS_ROLE,
    title: 'Change staff roles',
    description:
      'Grant or remove staff access. The most dangerous permission here — it is how somebody gives themselves more.',
    category: 'Users',
  },
  {
    key: ADMIN_PERMISSIONS.MODERATION_READ,
    title: 'View the moderation queue',
    description: 'Read reports and moderation flags awaiting a decision.',
    category: 'Moderation',
  },
  {
    key: ADMIN_PERMISSIONS.MODERATION_RESOLVE,
    title: 'Resolve reports',
    description: 'Close a report with an outcome.',
    category: 'Moderation',
  },
  {
    key: ADMIN_PERMISSIONS.VERIFICATION_READ,
    title: 'View the verification queue',
    description: 'Read submitted verifications, including the identity document.',
    category: 'Moderation',
  },
  {
    key: ADMIN_PERMISSIONS.VERIFICATION_REVIEW,
    title: 'Approve or decline verifications',
    description: 'Decide a verification. Grants the badge, which is a hard discovery filter.',
    category: 'Moderation',
  },
  {
    key: ADMIN_PERMISSIONS.VENUES_READ,
    title: 'View venues',
    description: 'Read the venue catalogue and suggestions awaiting review.',
    category: 'Venues',
  },
  {
    key: ADMIN_PERMISSIONS.VENUES_WRITE,
    title: 'Manage venues',
    description: 'Create, edit, feature and retire venues.',
    category: 'Venues',
  },
  {
    key: ADMIN_PERMISSIONS.SUBSCRIPTIONS_READ,
    title: 'View plans and subscriptions',
    description: 'Read the product catalogue, prices and subscriber state.',
    category: 'Subscriptions',
  },
  {
    key: ADMIN_PERMISSIONS.SUBSCRIPTIONS_WRITE,
    title: 'Manage plans and pricing',
    description:
      'Change what is on sale and at what price. Does not grant entitlement to anybody — only the catalogue.',
    category: 'Subscriptions',
  },
  {
    key: ADMIN_PERMISSIONS.ANALYTICS_READ,
    title: 'View analytics',
    description: 'Read aggregate engagement, revenue and retention figures.',
    category: 'Analytics',
  },
  {
    key: ADMIN_PERMISSIONS.AUDIT_READ,
    title: 'View the audit log',
    description: 'Read the record of what every staff member has done.',
    category: 'Administration',
  },
  {
    key: ADMIN_PERMISSIONS.ROLES_READ,
    title: 'View roles and permissions',
    description: 'Read the role list and the permission matrix.',
    category: 'Administration',
  },
  {
    key: ADMIN_PERMISSIONS.ROLES_WRITE,
    title: 'Manage roles and permissions',
    description:
      'Create roles, change the matrix, and assign staff to roles. Equivalent to granting any permission.',
    category: 'Administration',
  },
];

/**
 * Seeded roles.
 *
 * `administrator` is defined for completeness and for the panel to display, but
 * it is not what grants an admin their access: `User.role === 'admin'` already
 * means every permission, so an administrator can never be locked out by a row
 * somebody edited in this table.
 */
export const SYSTEM_ROLES: {
  key: string;
  title: string;
  description: string;
  permissions: AdminPermissionKey[] | 'all';
}[] = [
  {
    key: 'administrator',
    title: 'Administrator',
    description: 'Full access, including roles and permissions.',
    permissions: 'all',
  },
  {
    key: 'moderator',
    title: 'Moderator',
    description: 'Works the moderation and verification queues. Cannot change plans or roles.',
    permissions: [
      ADMIN_PERMISSIONS.USERS_READ,
      ADMIN_PERMISSIONS.USERS_SUSPEND,
      ADMIN_PERMISSIONS.MODERATION_READ,
      ADMIN_PERMISSIONS.MODERATION_RESOLVE,
      ADMIN_PERMISSIONS.VERIFICATION_READ,
      ADMIN_PERMISSIONS.VERIFICATION_REVIEW,
      ADMIN_PERMISSIONS.VENUES_READ,
    ],
  },
  {
    key: 'analyst',
    title: 'Analyst',
    description: 'Read-only. Sees figures and accounts, changes nothing.',
    permissions: [
      ADMIN_PERMISSIONS.USERS_READ,
      ADMIN_PERMISSIONS.ANALYTICS_READ,
      ADMIN_PERMISSIONS.SUBSCRIPTIONS_READ,
      ADMIN_PERMISSIONS.VENUES_READ,
    ],
  },
];

/**
 * Seeded guardrails.
 *
 * Same rule as permissions, applied harder: a guardrail is seeded only once an
 * endpoint reads it. A switch labelled "read-only mode" that does not actually
 * stop writes is worse than no switch, because somebody will flip it during an
 * incident and believe the system is frozen.
 *
 * `admin.read_only` is enforced in `requirePermission` for every mutating admin
 * route, which is why it can be seeded now.
 */
export const GUARDRAIL_KEYS = {
  READ_ONLY: 'admin.read_only',
} as const;

export const GUARDRAIL_CATALOGUE: {
  key: string;
  title: string;
  description: string;
}[] = [
  {
    key: GUARDRAIL_KEYS.READ_ONLY,
    title: 'Admin read-only mode',
    description:
      'Refuses every admin change while on. Reading is unaffected, and the app is untouched — this only freezes the panel.',
  },
];
