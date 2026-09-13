import type { Request, Response } from 'express';

import { requireUser } from '@middleware/authenticate';
import { sendList, sendSuccess } from '@utils/response';
import * as chatService from './chat.service';
import type {
  ListQuery,
  MessagesQuery,
  SendMessageBody,
  UpdateConversationBody,
} from './chat.schema';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function listConversations(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor, archived, mode } = req.query as unknown as ListQuery;

  const result = await chatService.listConversations(user.id, { limit, cursor, archived, mode });

  sendList(res, result.conversations, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function getConversation(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await chatService.getConversation(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function listMessages(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const { limit, cursor } = req.query as unknown as MessagesQuery;

  const result = await chatService.listMessages(user.id, req.params.id as string, {
    limit,
    cursor,
  });

  sendList(res, result.messages, {
    next_cursor: result.next_cursor,
    has_more: result.has_more,
    limit: result.limit,
  });
}

export async function sendMessage(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as SendMessageBody;

  const result = await chatService.sendMessage(user.id, req.params.id as string, body);

  sendSuccess(res, { ...result }, 201);
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await chatService.markRead(user.id, req.params.id as string);

  sendSuccess(res, { ...result });
}

export async function updateConversation(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as UpdateConversationBody;

  const result = await chatService.updateConversationState(user.id, req.params.id as string, body);

  sendSuccess(res, { ...result });
}

export async function unreadTotal(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);

  const result = await chatService.unreadTotal(user.id);

  sendSuccess(res, { ...result });
}
