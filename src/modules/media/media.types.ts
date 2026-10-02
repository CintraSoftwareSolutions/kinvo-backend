import type { BucketName } from '@/providers/s3.provider';

export type UploadPurpose =
  | 'profile_photo'
  | 'chat_image'
  | 'chat_video'
  | 'voice_note'
  | 'verification_document'
  | 'report_evidence';

export interface UploadPolicy {
  bucket: BucketName;
  mime_types: readonly string[];
  max_bytes: number;
  requires_duration: boolean;
  max_duration_ms?: number;
}

export interface UploadTicket {
  upload_id: string;
  purpose: UploadPurpose;
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface MediaAssetView {
  id: string;
  kind: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  moderation_status: string;
  is_uploaded: boolean;
  url: string | null;
  created_at: string;
}

export interface PhotoView {
  id: string;
  url: string | null;
  position: number;
  is_primary: boolean;
  moderation_status: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface VerificationView {
  id: string | null;
  method: string | null;
  status: string;
  current_step: number;
  total_steps: number;
  submitted_at: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  is_verified: boolean;
}
