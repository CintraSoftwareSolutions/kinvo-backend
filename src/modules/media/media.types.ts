import type { BucketName } from '@/providers/s3.provider';

/**
 * What an upload is for. Drives the bucket, the size and type limits, and what
 * the finished asset may be attached to.
 */
export type UploadPurpose =
  | 'profile_photo'
  | 'chat_image'
  | 'chat_video'
  | 'voice_note'
  | 'verification_document'
  | 'report_evidence';

export interface UploadPolicy {
  bucket: BucketName;
  /** Exhaustive allow-list. Anything not named here is refused. */
  mime_types: readonly string[];
  max_bytes: number;
  /** Voice notes must declare a duration (spec §5.4). */
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
  /** Derived from the latest approved record (spec §7, Batch 4). */
  is_verified: boolean;
}
