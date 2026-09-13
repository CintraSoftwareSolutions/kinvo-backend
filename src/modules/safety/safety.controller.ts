import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as blocksService from './blocks.service';
import * as contactsService from './contacts.service';
import * as locationService from './location.service';
import * as reportsService from './reports.service';
import type {
  CreateContactBody,
  CreateReportBody,
  EmergencyBody,
  ListQuery,
  PingBody,
  ResolveReportBody,
  ReviewReportsQuery,
  StartSharingBody,
  UpdateContactBody,
} from './safety.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

// --- reports ---------------------------------------------------------------

export async function createReport(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as CreateReportBody;

  const result = await reportsService.createReport({
    reporterId: user.id,
    reportedId: body.reported_id,
    reason: body.reason,
    description: body.description,
    contextType: body.context_type,
    contextId: body.context_id,
    alsoBlock: body.also_block,
    evidenceAssetIds: body.evidence_asset_ids,
  });

  sendSuccess(res, { ...result }, 201);
}

export async function listMyReports(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor } = req.query as unknown as ListQuery;

  const result = await reportsService.listMyReports(user.id, { limit, cursor });

  sendList(res, result.reports, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function listReportsForReview(req: Request, res: Response): Promise<void> {
  const { limit, cursor, status, reason } = req.query as unknown as ReviewReportsQuery;

  const result = await reportsService.listReportsForReview({ limit, cursor, status, reason });

  sendList(res, result.reports, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function resolveReport(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as ResolveReportBody;

  const result = await reportsService.resolveReport(user.id, req.params.id as string, {
    status: body.status,
    resolution_note: body.resolution_note,
  });

  sendSuccess(res, { ...result });
}

// --- blocks ----------------------------------------------------------------

export async function block(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await blocksService.block(user.id, (req.body as { user_id: string }).user_id);

  sendSuccess(res, { ...result }, 201);
}

export async function unblock(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await blocksService.unblock(user.id, req.params.user_id as string);

  sendSuccess(res, { unblocked: true });
}

export async function listBlocks(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor } = req.query as unknown as ListQuery;

  const result = await blocksService.listBlocks(user.id, { limit, cursor });

  sendList(res, result.blocks, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

// --- trusted contacts ------------------------------------------------------

export async function listContacts(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const contacts = await contactsService.listContacts(user.id);

  sendSuccess(res, { contacts });
}

export async function createContact(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await contactsService.createContact(user.id, req.body as CreateContactBody);

  sendSuccess(res, { ...result }, 201);
}

export async function updateContact(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await contactsService.updateContact(
    user.id,
    req.params.id as string,
    req.body as UpdateContactBody,
  );

  sendSuccess(res, { ...result });
}

export async function deleteContact(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await contactsService.deleteContact(user.id, req.params.id as string);

  sendSuccess(res, { deleted: true });
}

// --- live location ---------------------------------------------------------

export async function startSharing(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await locationService.startSharing(user.id, req.body as StartSharingBody);

  sendSuccess(res, { ...result }, 201);
}

export async function activeSession(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const session = await locationService.activeSession(user.id);

  // spec §4.6: return null, never omit the key.
  sendSuccess(res, { session });
}

export async function stopSharing(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  await locationService.stopSharing(user.id, req.params.id as string);

  sendSuccess(res, { stopped: true });
}

export async function recordPing(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as PingBody;

  await locationService.recordPing(
    user.id,
    req.params.id as string,
    { latitude: body.latitude, longitude: body.longitude },
    body.accuracy_metres,
  );

  sendSuccess(res, { recorded: true }, 201);
}

export async function readTrail(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await locationService.readTrail(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

// --- emergency -------------------------------------------------------------

export async function raiseEmergency(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as EmergencyBody;

  const result = await locationService.raiseEmergency(user.id, {
    type: body.type,
    note: body.note,
    coordinates:
      body.latitude !== undefined && body.longitude !== undefined
        ? { latitude: body.latitude, longitude: body.longitude }
        : undefined,
  });

  sendSuccess(res, { ...result }, 201);
}

export async function listEmergencies(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const events = await locationService.listEmergencies(user.id);

  sendSuccess(res, { events });
}
