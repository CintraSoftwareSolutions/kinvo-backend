import type { Request, Response } from 'express';

import type {
  Mode,
  ReportStatus,
  SubscriptionTier,
  UserRole,
  UserStatus,
  VenueCategory,
} from '@/db/prisma';
import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as adminService from './admin.service';
import * as analyticsService from './analytics.service';
import * as contentService from './content.service';
import * as catalogueService from './catalogue.service';
import * as snapshotService from './snapshot.service';
import * as usersService from './users.service';
import type {
  ActivityQuery,
  AddRoleMemberBody,
  AssignFlagBody,
  AuditLogQuery,
  CreateRoleBody,
  CreateVenueBody,
  EscalationsQuery,
  ListUsersQuery,
  ListVenuesQuery,
  ModerationQueueQuery,
  SetGuardrailBody,
  SetPermissionsBody,
  SetProductPriceBody,
  SetStaffRoleBody,
  SuspendUserBody,
  UpdateProductBody,
  UpdateRoleBody,
  UpdateVenueBody,
} from './admin.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

/** The caller's IP, recorded on every audit entry. Meaningful because of `trust proxy`. */
function actor(req: Request): { adminId: string; ipAddress: string | null } {
  return { adminId: requireUser(req).id, ipAddress: req.ip ?? null };
}

export async function getSelf(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await adminService.describeSelf(user);

  sendSuccess(res, { ...result });
}

export async function listRoles(_req: Request, res: Response): Promise<void> {
  const roles = await adminService.listRoles();

  sendSuccess(res, { roles });
}

export async function createRole(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateRoleBody;

  const role = await adminService.createRole({ ...body, ...actor(req) });

  sendSuccess(res, { role }, 201);
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateRoleBody;

  const role = await adminService.updateRole({
    roleId: req.params.id!,
    ...body,
    ...actor(req),
  });

  sendSuccess(res, { role });
}

export async function deleteRole(req: Request, res: Response): Promise<void> {
  await adminService.deleteRole({ roleId: req.params.id!, ...actor(req) });

  sendSuccess(res, { deleted: true });
}

export async function getRolePermissions(req: Request, res: Response): Promise<void> {
  const result = await adminService.getRolePermissions(req.params.id!);

  sendSuccess(res, { ...result });
}

export async function setRolePermissions(req: Request, res: Response): Promise<void> {
  const body = req.body as SetPermissionsBody;

  const result = await adminService.setRolePermissions({
    roleId: req.params.id!,
    permissions: body.permissions,
    ...actor(req),
  });

  sendSuccess(res, { ...result });
}

export async function listRoleMembers(req: Request, res: Response): Promise<void> {
  const result = await adminService.listRoleMembers(req.params.id!);

  sendSuccess(res, { ...result });
}

export async function addRoleMember(req: Request, res: Response): Promise<void> {
  const body = req.body as AddRoleMemberBody;

  await adminService.addRoleMember({
    roleId: req.params.id!,
    userId: body.user_id,
    ...actor(req),
  });

  sendSuccess(res, { added: true }, 201);
}

export async function removeRoleMember(req: Request, res: Response): Promise<void> {
  await adminService.removeRoleMember({
    roleId: req.params.id!,
    userId: req.params.userId!,
    ...actor(req),
  });

  sendSuccess(res, { removed: true });
}

export async function listGuardrails(_req: Request, res: Response): Promise<void> {
  const guardrails = await adminService.listGuardrails();

  sendSuccess(res, { guardrails });
}

export async function setGuardrail(req: Request, res: Response): Promise<void> {
  const body = req.body as SetGuardrailBody;

  const result = await adminService.setGuardrail({
    key: req.params.key!,
    enabled: body.enabled,
    ...actor(req),
  });

  sendSuccess(res, { ...result });
}

export async function listAuditLog(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as AuditLogQuery;

  const result = await adminService.listAuditLog({
    actorId: query.actor_id,
    targetType: query.target_type,
    targetId: query.target_id,
    action: query.action,
    limit: query.limit,
    cursor: query.cursor,
  });

  sendList(res, result.entries, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

// --- users -----------------------------------------------------------------

export async function listUsers(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListUsersQuery;

  const result = await usersService.listUsers({
    limit: query.limit,
    cursor: query.cursor,
    search: query.search,
    status: query.status as UserStatus | undefined,
    tier: query.tier as SubscriptionTier | undefined,
    mode: query.mode as Mode | undefined,
    flagged: query.flagged,
    staff: query.staff,
  });

  sendList(res, result.users, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function getUserSnapshot(_req: Request, res: Response): Promise<void> {
  const snapshot = await snapshotService.userSnapshot();

  sendSuccess(res, { ...snapshot });
}

export async function getUser(req: Request, res: Response): Promise<void> {
  const user = await usersService.getUser(req.params.id!);

  sendSuccess(res, { user });
}

export async function listMemberships(req: Request, res: Response): Promise<void> {
  const memberships = await usersService.listMemberships(req.params.id!);

  sendSuccess(res, { memberships });
}

export async function listActivity(req: Request, res: Response): Promise<void> {
  const { limit } = req.query as unknown as ActivityQuery;

  const activity = await usersService.listActivity(req.params.id!, limit);

  sendSuccess(res, { activity });
}

export async function suspendUser(req: Request, res: Response): Promise<void> {
  const body = req.body as SuspendUserBody;

  const user = await usersService.suspendUser({
    userId: req.params.id!,
    reason: body.reason,
    ...actor(req),
  });

  sendSuccess(res, { user });
}

export async function reinstateUser(req: Request, res: Response): Promise<void> {
  const user = await usersService.reinstateUser({
    userId: req.params.id!,
    ...actor(req),
  });

  sendSuccess(res, { user });
}

export async function setStaffRole(req: Request, res: Response): Promise<void> {
  const body = req.body as SetStaffRoleBody;
  const { adminId, ipAddress } = actor(req);

  const user = await usersService.setStaffRole({
    userId: req.params.id!,
    role: body.role as UserRole,
    actingAdminId: adminId,
    ipAddress,
  });

  sendSuccess(res, { user });
}

// --- moderation queue ------------------------------------------------------

export async function getModerationQueue(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ModerationQueueQuery;

  const result = await contentService.moderationQueue({
    status: query.status as ReportStatus | undefined,
    severity: query.severity,
    assignedToId: query.assigned_to_id,
    unassigned: query.unassigned,
    limit: query.limit,
    cursor: query.cursor,
  });

  sendList(res, result.items, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function getModerationInsights(_req: Request, res: Response): Promise<void> {
  const insights = await contentService.moderationInsights();

  sendSuccess(res, { ...insights });
}

export async function assignFlag(req: Request, res: Response): Promise<void> {
  const body = req.body as AssignFlagBody;

  const result = await contentService.assignFlag({
    flagId: req.params.id!,
    assigneeId: body.assignee_id,
    ...actor(req),
  });

  sendSuccess(res, { flag: result });
}

// --- venues ----------------------------------------------------------------

export async function listVenues(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListVenuesQuery;

  const result = await contentService.listVenues({
    search: query.search,
    category: query.category as VenueCategory | undefined,
    featured: query.featured,
    reviewed: query.reviewed,
    active: query.active,
    limit: query.limit,
    cursor: query.cursor,
  });

  sendList(res, result.venues, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function updateVenue(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateVenueBody;

  const venue = await contentService.updateVenue({
    venueId: req.params.id!,
    changes: body as Parameters<typeof contentService.updateVenue>[0]['changes'],
    ...actor(req),
  });

  sendSuccess(res, { venue });
}

// --- plans -----------------------------------------------------------------

export async function listSubscriptionProducts(_req: Request, res: Response): Promise<void> {
  const plans = await catalogueService.listSubscriptionProducts();

  sendSuccess(res, { plans });
}

export async function updateSubscriptionProduct(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateProductBody;

  const plan = await catalogueService.updateSubscriptionProduct({
    productId: req.params.id!,
    changes: body as Parameters<typeof catalogueService.updateSubscriptionProduct>[0]['changes'],
    ...actor(req),
  });

  sendSuccess(res, { plan });
}

export async function setProductPrice(req: Request, res: Response): Promise<void> {
  const body = req.body as SetProductPriceBody;

  const plan = await catalogueService.setProductPrice({
    productId: req.params.id!,
    amountMinor: body.amount_minor,
    currency: body.currency,
    note: body.note,
    ...actor(req),
  });

  sendSuccess(res, { plan }, 201);
}

export async function getProductPriceHistory(req: Request, res: Response): Promise<void> {
  const versions = await catalogueService.productPriceHistory(req.params.id!);

  sendSuccess(res, { versions });
}

// --- analytics -------------------------------------------------------------

export async function getAnalytics(_req: Request, res: Response): Promise<void> {
  const dashboard = await analyticsService.analyticsDashboard();

  sendSuccess(res, { ...dashboard });
}

export async function createVenue(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateVenueBody;

  const venue = await contentService.createVenue({
    data: body as Parameters<typeof contentService.createVenue>[0]['data'],
    ...actor(req),
  });

  sendSuccess(res, { venue }, 201);
}

export async function getModerationEscalations(req: Request, res: Response): Promise<void> {
  const { limit } = req.query as unknown as EscalationsQuery;

  const cases = await contentService.moderationEscalations(limit);

  sendSuccess(res, { cases });
}
