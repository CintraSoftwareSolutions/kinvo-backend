import type { Request, Response } from 'express';

import { type VerificationMethod } from '@/db/prisma';
import { requireUser } from '@middleware/authenticate';
import { sendSuccess } from '@utils/response';
import type {
  AddPhotoBody,
  AttachDocumentBody,
  CreateUploadBody,
  ReorderPhotosBody,
  StartVerificationBody,
} from './media.schema';
import * as mediaService from './media.service';
import * as photosService from './photos.service';
import * as verificationService from './verification.service';

/** HTTP translation only. No business logic, no database access (spec §0.5). */

export async function createUpload(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as CreateUploadBody;

  const ticket = await mediaService.createUpload(user.id, body);
  sendSuccess(res, { ...ticket }, 201);
}

export async function completeUpload(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const asset = await mediaService.completeUpload(user.id, req.params.id!);
  sendSuccess(res, { ...asset });
}

export async function deleteUpload(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  await mediaService.deleteAsset(user.id, req.params.id!);
  sendSuccess(res, { deleted: true });
}

export async function getUploadUrl(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const url = await mediaService.getOwnAssetUrl(user.id, req.params.id!);
  sendSuccess(res, { url });
}

export async function listPhotos(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const photos = await photosService.listPhotos(user.id);

  // spec §4.6: a list is always an array, never null.
  sendSuccess(res, { photos, max_photos: photosService.MAX_PHOTOS });
}

export async function addPhoto(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as AddPhotoBody;

  const photo = await photosService.addPhoto(user.id, body);
  sendSuccess(res, { ...photo }, 201);
}

export async function deletePhoto(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  await photosService.deletePhoto(user.id, req.params.id!);
  sendSuccess(res, { deleted: true });
}

export async function reorderPhotos(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as ReorderPhotosBody;

  const photos = await photosService.reorderPhotos(user.id, body.photo_ids);
  sendSuccess(res, { photos });
}

export async function setPrimaryPhoto(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const photos = await photosService.setPrimaryPhoto(user.id, req.params.id!);
  sendSuccess(res, { photos });
}

export async function getVerification(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const status = await verificationService.getVerificationStatus(user.id);
  sendSuccess(res, { ...status });
}

export async function startVerification(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as StartVerificationBody;

  const status = await verificationService.startVerification(
    user.id,
    body.method as VerificationMethod,
  );
  sendSuccess(res, { ...status }, 201);
}

export async function attachVerificationDocument(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const body = req.body as AttachDocumentBody;

  const status = await verificationService.attachVerificationDocument(
    user.id,
    req.params.id!,
    body.upload_id,
  );
  sendSuccess(res, { ...status });
}

export async function submitVerification(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const status = await verificationService.submitVerification(user.id, req.params.id!);
  sendSuccess(res, { ...status });
}
