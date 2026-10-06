import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as adminService from './admin.service';
import type {
  AddRoleMemberBody,
  AuditLogQuery,
  CreateRoleBody,
  SetGuardrailBody,
  SetPermissionsBody,
  UpdateRoleBody,
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
