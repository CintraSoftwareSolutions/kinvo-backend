-- ============================================================================
-- EXTENSIONS
--
-- PostGIS is created here, in the first migration, rather than in the Docker
-- init script — so it travels with the schema to CI, staging, and production
-- instead of existing only on developer machines. Every geography column below
-- depends on it, so it must come first.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "mode" AS ENUM ('dating', 'study_buddy', 'networking', 'trading', 'foodie', 'cuddle', 'pet_dates', 'fitness');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('pending', 'active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'moderator', 'admin');

-- CreateEnum
CREATE TYPE "auth_provider" AS ENUM ('email', 'phone', 'google', 'apple');

-- CreateEnum
CREATE TYPE "swipe_action" AS ENUM ('pass', 'like', 'super_like');

-- CreateEnum
CREATE TYPE "match_status" AS ENUM ('active', 'expired', 'unmatched');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('text', 'image', 'video', 'voice_note', 'venue_card');

-- CreateEnum
CREATE TYPE "moderation_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "moderation_severity" AS ENUM ('none', 'low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "verification_method" AS ENUM ('photo', 'government_id', 'social');

-- CreateEnum
CREATE TYPE "verification_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "report_reason" AS ENUM ('harassment', 'fake_profile', 'spam_scam', 'safety_concern');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('open', 'under_review', 'actioned', 'dismissed');

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('draft', 'proposed', 'confirmed', 'declined', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "venue_category" AS ENUM ('cafe', 'restaurant', 'park', 'gym', 'study_spot', 'pet_friendly', 'romantic', 'health_conscious');

-- CreateEnum
CREATE TYPE "subscription_tier" AS ENUM ('free', 'basic', 'advanced');

-- CreateEnum
CREATE TYPE "billing_cycle" AS ENUM ('monthly', 'quarterly', 'yearly');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('active', 'in_grace_period', 'on_billing_retry', 'expired', 'cancelled', 'refunded', 'revoked');

-- CreateEnum
CREATE TYPE "payment_source" AS ENUM ('apple', 'google');

-- CreateEnum
CREATE TYPE "media_kind" AS ENUM ('chat_image', 'chat_video', 'voice_note', 'verification_document', 'report_evidence');

-- CreateEnum
CREATE TYPE "device_platform" AS ENUM ('ios', 'android', 'web');

-- CreateEnum
CREATE TYPE "notification_category" AS ENUM ('new_match', 'new_like', 'new_message', 'plan_update', 'safety', 'moderation', 'subscription', 'system');

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('ringing', 'active', 'ended', 'missed', 'declined', 'failed');

-- CreateEnum
CREATE TYPE "call_safety_action_type" AS ENUM ('flag', 'end_and_report', 'send_live_update');

-- CreateEnum
CREATE TYPE "emergency_event_type" AS ENUM ('help_requested', 'location_shared', 'check_in_missed');

-- CreateEnum
CREATE TYPE "frequency" AS ENUM ('never', 'rarely', 'socially', 'regularly', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "exercise_frequency" AS ENUM ('never', 'sometimes', 'often', 'daily', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "diet" AS ENUM ('omnivore', 'vegetarian', 'vegan', 'pescatarian', 'halal', 'kosher', 'other', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "pet_situation" AS ENUM ('none', 'dog', 'cat', 'other', 'multiple', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "children_preference" AS ENUM ('none', 'have_children', 'want_children', 'do_not_want_children', 'open', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "education_level" AS ENUM ('high_school', 'undergraduate', 'postgraduate', 'doctorate', 'other', 'prefer_not_to_say');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "display_name" VARCHAR(50) NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'pending',
    "role" "user_role" NOT NULL DEFAULT 'user',
    "subscription_tier" "subscription_tier" NOT NULL DEFAULT 'free',
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_snoozed" BOOLEAN NOT NULL DEFAULT false,
    "snooze_ends_at" TIMESTAMP(3),
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "onboarded_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "suspension_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "auth_provider" NOT NULL,
    "identifier" VARCHAR(320) NOT NULL,
    "password_hash" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_id" VARCHAR(128),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" VARCHAR(128) NOT NULL,
    "platform" "device_platform" NOT NULL,
    "app_version" VARCHAR(32),
    "os_version" VARCHAR(32),
    "model" VARCHAR(64),
    "fcm_token" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bio" VARCHAR(500),
    "job_title" VARCHAR(100),
    "organisation" VARCHAR(100),
    "education" "education_level",
    "height_cm" INTEGER,
    "location" geography(Point, 4326),
    "city" VARCHAR(120),
    "country" CHAR(2),
    "location_updated_at" TIMESTAMP(3),
    "drinking" "frequency",
    "smoking" "frequency",
    "exercise" "exercise_frequency",
    "diet" "diet",
    "pets" "pet_situation",
    "children" "children_preference",
    "completion_percentage" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interests" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "modes" "mode"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "interests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_interests" (
    "profile_id" UUID NOT NULL,
    "interest_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_interests_pkey" PRIMARY KEY ("profile_id","interest_id")
);

-- CreateTable
CREATE TABLE "prompt_questions" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "question" VARCHAR(200) NOT NULL,
    "modes" "mode"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "prompt_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_answers" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "answer" VARCHAR(300) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "s3_bucket" VARCHAR(128) NOT NULL,
    "s3_key" VARCHAR(512) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "position" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "size_bytes" INTEGER,
    "moderation_status" "moderation_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "kind" "media_kind" NOT NULL,
    "s3_bucket" VARCHAR(128) NOT NULL,
    "s3_key" VARCHAR(512) NOT NULL,
    "url" VARCHAR(2048),
    "mime_type" VARCHAR(128) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "moderation_status" "moderation_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "verification_method" NOT NULL,
    "status" "verification_status" NOT NULL DEFAULT 'pending',
    "current_step" INTEGER NOT NULL DEFAULT 1,
    "asset_id" UUID,
    "social_provider" VARCHAR(32),
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_id" UUID,
    "rejection_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_modes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "min_age" INTEGER NOT NULL DEFAULT 18,
    "max_age" INTEGER NOT NULL DEFAULT 99,
    "radius_metres" INTEGER NOT NULL DEFAULT 48280,
    "verified_only" BOOLEAN NOT NULL DEFAULT false,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_modes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swipes" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "action" "swipe_action" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "status" "match_status" NOT NULL DEFAULT 'active',
    "is_super_like" BOOLEAN NOT NULL DEFAULT false,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "extended_at" TIMESTAMP(3),
    "extension_count" INTEGER NOT NULL DEFAULT 0,
    "unmatched_at" TIMESTAMP(3),
    "unmatched_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "deck_date" DATE NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deck_entries" (
    "id" UUID NOT NULL,
    "deck_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distance_metres" INTEGER,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "deck_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boosts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "mode" "mode" NOT NULL,
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_states" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "last_read_at" TIMESTAMP(3),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "type" "message_type" NOT NULL DEFAULT 'text',
    "body" VARCHAR(2000),
    "media_asset_id" UUID,
    "venue_id" UUID,
    "duration_ms" INTEGER,
    "moderation_overridden" BOOLEAN NOT NULL DEFAULT false,
    "moderation_flagged" BOOLEAN NOT NULL DEFAULT false,
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reported_id" UUID NOT NULL,
    "reason" "report_reason" NOT NULL,
    "description" VARCHAR(1000),
    "context_type" VARCHAR(32),
    "context_id" UUID,
    "also_block" BOOLEAN NOT NULL DEFAULT false,
    "status" "report_status" NOT NULL DEFAULT 'open',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "resolution_note" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_evidence" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(32),
    "email" VARCHAR(320),
    "relationship" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trusted_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_location_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_location_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_location_pings" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "location" geography(Point, 4326),
    "accuracy_metres" INTEGER,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_location_pings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "emergency_event_type" NOT NULL,
    "location" geography(Point, 4326),
    "note" VARCHAR(500),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "venue_id" UUID,
    "custom_location" VARCHAR(200),
    "custom_address" VARCHAR(300),
    "scheduled_at" TIMESTAMP(3),
    "duration_minutes" INTEGER,
    "status" "plan_status" NOT NULL DEFAULT 'draft',
    "notes" VARCHAR(1000),
    "responded_at" TIMESTAMP(3),
    "responded_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "cancellation_reason" VARCHAR(500),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_shares" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "trusted_contact_id" UUID NOT NULL,
    "shared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_windows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" "venue_category" NOT NULL,
    "description" VARCHAR(1000),
    "location" geography(Point, 4326),
    "address" VARCHAR(300),
    "city" VARCHAR(120),
    "country" CHAR(2),
    "rating" DOUBLE PRECISION,
    "price_level" INTEGER,
    "photo_url" VARCHAR(2048),
    "website_url" VARCHAR(2048),
    "phone" VARCHAR(32),
    "modes" "mode"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_venues" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_products" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "tier" "subscription_tier" NOT NULL,
    "billing_cycle" "billing_cycle" NOT NULL,
    "apple_product_id" VARCHAR(128),
    "google_product_id" VARCHAR(128),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL,
    "source" "payment_source" NOT NULL,
    "store_transaction_id" VARCHAR(256),
    "original_transaction_id" VARCHAR(256),
    "store_purchase_token" TEXT,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "cancelled_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_versions" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "source" "payment_source",
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_flags" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" VARCHAR(300),
    "value_type" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tier_entitlements" (
    "id" UUID NOT NULL,
    "tier" "subscription_tier" NOT NULL,
    "flag_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tier_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_notifications" (
    "id" UUID NOT NULL,
    "source" "payment_source" NOT NULL,
    "notification_id" VARCHAR(256) NOT NULL,
    "notification_type" VARCHAR(64),
    "payload" JSONB NOT NULL,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "error" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "endpoint" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "notification_category" NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "notification_category" NOT NULL,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_sessions" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "initiator_id" UUID NOT NULL,
    "room_name" VARCHAR(128) NOT NULL,
    "status" "call_status" NOT NULL DEFAULT 'ringing',
    "started_at" TIMESTAMP(3),
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "ended_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_safety_actions" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "call_safety_action_type" NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_safety_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_checks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" UUID,
    "content_hash" VARCHAR(64) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "severity" "moderation_severity" NOT NULL DEFAULT 'none',
    "categories" JSONB NOT NULL DEFAULT '[]',
    "raw_response" JSONB,
    "was_overridden" BOOLEAN NOT NULL DEFAULT false,
    "timed_out" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_flags" (
    "id" UUID NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" UUID NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "severity" "moderation_severity" NOT NULL DEFAULT 'low',
    "status" "report_status" NOT NULL DEFAULT 'open',
    "assigned_to_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderation_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "target_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "users_last_active_at_idx" ON "users"("last_active_at");

-- CreateIndex
CREATE INDEX "users_is_snoozed_idx" ON "users"("is_snoozed");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_identifier_key" ON "auth_identities"("provider", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "devices_fcm_token_idx" ON "devices"("fcm_token");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_device_id_key" ON "devices"("user_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_key" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "profiles_city_idx" ON "profiles"("city");

-- CreateIndex
CREATE UNIQUE INDEX "interests_slug_key" ON "interests"("slug");

-- CreateIndex
CREATE INDEX "interests_category_idx" ON "interests"("category");

-- CreateIndex
CREATE INDEX "profile_interests_interest_id_idx" ON "profile_interests"("interest_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_questions_slug_key" ON "prompt_questions"("slug");

-- CreateIndex
CREATE INDEX "profile_answers_profile_id_idx" ON "profile_answers"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "profile_answers_profile_id_question_id_key" ON "profile_answers"("profile_id", "question_id");

-- CreateIndex
CREATE INDEX "photos_profile_id_idx" ON "photos"("profile_id");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_idx" ON "media_assets"("owner_id");

-- CreateIndex
CREATE INDEX "media_assets_kind_idx" ON "media_assets"("kind");

-- CreateIndex
CREATE INDEX "verifications_user_id_idx" ON "verifications"("user_id");

-- CreateIndex
CREATE INDEX "verifications_status_idx" ON "verifications"("status");

-- CreateIndex
CREATE INDEX "user_modes_user_id_idx" ON "user_modes"("user_id");

-- CreateIndex
CREATE INDEX "user_modes_mode_is_enabled_idx" ON "user_modes"("mode", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "user_modes_user_id_mode_key" ON "user_modes"("user_id", "mode");

-- CreateIndex
CREATE INDEX "swipes_target_id_mode_action_idx" ON "swipes"("target_id", "mode", "action");

-- CreateIndex
CREATE INDEX "swipes_actor_id_mode_created_at_idx" ON "swipes"("actor_id", "mode", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "swipes_actor_id_target_id_mode_key" ON "swipes"("actor_id", "target_id", "mode");

-- CreateIndex
CREATE INDEX "matches_user_a_id_status_mode_idx" ON "matches"("user_a_id", "status", "mode");

-- CreateIndex
CREATE INDEX "matches_user_b_id_status_mode_idx" ON "matches"("user_b_id", "status", "mode");

-- CreateIndex
CREATE INDEX "matches_expires_at_idx" ON "matches"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "matches_user_a_id_user_b_id_mode_key" ON "matches"("user_a_id", "user_b_id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "decks_user_id_mode_deck_date_key" ON "decks"("user_id", "mode", "deck_date");

-- CreateIndex
CREATE INDEX "deck_entries_deck_id_position_idx" ON "deck_entries"("deck_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "deck_entries_deck_id_target_id_key" ON "deck_entries"("deck_id", "target_id");

-- CreateIndex
CREATE INDEX "boosts_user_id_mode_idx" ON "boosts"("user_id", "mode");

-- CreateIndex
CREATE INDEX "boosts_ends_at_idx" ON "boosts"("ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_match_id_key" ON "conversations"("match_id");

-- CreateIndex
CREATE INDEX "conversations_last_message_at_idx" ON "conversations"("last_message_at");

-- CreateIndex
CREATE INDEX "conversation_states_user_id_is_archived_idx" ON "conversation_states"("user_id", "is_archived");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_states_conversation_id_user_id_key" ON "conversation_states"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");

-- CreateIndex
CREATE INDEX "blocks_blocked_id_idx" ON "blocks"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blocker_id_blocked_id_key" ON "blocks"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "reports_reported_id_idx" ON "reports"("reported_id");

-- CreateIndex
CREATE INDEX "reports_reporter_id_idx" ON "reports"("reporter_id");

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "report_evidence_report_id_idx" ON "report_evidence"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_evidence_report_id_media_asset_id_key" ON "report_evidence"("report_id", "media_asset_id");

-- CreateIndex
CREATE INDEX "trusted_contacts_user_id_idx" ON "trusted_contacts"("user_id");

-- CreateIndex
CREATE INDEX "live_location_sessions_user_id_idx" ON "live_location_sessions"("user_id");

-- CreateIndex
CREATE INDEX "live_location_sessions_expires_at_idx" ON "live_location_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "live_location_pings_session_id_recorded_at_idx" ON "live_location_pings"("session_id", "recorded_at");

-- CreateIndex
CREATE INDEX "emergency_events_user_id_created_at_idx" ON "emergency_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "plans_match_id_status_idx" ON "plans"("match_id", "status");

-- CreateIndex
CREATE INDEX "plans_creator_id_idx" ON "plans"("creator_id");

-- CreateIndex
CREATE INDEX "plans_scheduled_at_idx" ON "plans"("scheduled_at");

-- CreateIndex
CREATE INDEX "plan_shares_plan_id_idx" ON "plan_shares"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_shares_plan_id_trusted_contact_id_key" ON "plan_shares"("plan_id", "trusted_contact_id");

-- CreateIndex
CREATE INDEX "availability_windows_user_id_idx" ON "availability_windows"("user_id");

-- CreateIndex
CREATE INDEX "venues_category_idx" ON "venues"("category");

-- CreateIndex
CREATE INDEX "venues_city_idx" ON "venues"("city");

-- CreateIndex
CREATE INDEX "saved_venues_user_id_idx" ON "saved_venues"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_venues_user_id_venue_id_key" ON "saved_venues"("user_id", "venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_products_slug_key" ON "subscription_products"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_products_apple_product_id_key" ON "subscription_products"("apple_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_products_google_product_id_key" ON "subscription_products"("google_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_products_tier_billing_cycle_key" ON "subscription_products"("tier", "billing_cycle");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_source_original_transaction_id_key" ON "subscriptions"("source", "original_transaction_id");

-- CreateIndex
CREATE INDEX "price_versions_product_id_effective_from_idx" ON "price_versions"("product_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_flags_key_key" ON "entitlement_flags"("key");

-- CreateIndex
CREATE UNIQUE INDEX "tier_entitlements_tier_flag_id_key" ON "tier_entitlements"("tier", "flag_id");

-- CreateIndex
CREATE INDEX "store_notifications_processed_at_idx" ON "store_notifications"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_notifications_source_notification_id_key" ON "store_notifications"("source", "notification_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_endpoint_key_key" ON "idempotency_keys"("user_id", "endpoint", "key");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_category_key" ON "notification_preferences"("user_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "call_sessions_room_name_key" ON "call_sessions"("room_name");

-- CreateIndex
CREATE INDEX "call_sessions_match_id_idx" ON "call_sessions"("match_id");

-- CreateIndex
CREATE INDEX "call_sessions_initiator_id_idx" ON "call_sessions"("initiator_id");

-- CreateIndex
CREATE INDEX "call_safety_actions_call_id_idx" ON "call_safety_actions"("call_id");

-- CreateIndex
CREATE INDEX "moderation_checks_user_id_created_at_idx" ON "moderation_checks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_checks_severity_idx" ON "moderation_checks"("severity");

-- CreateIndex
CREATE INDEX "moderation_flags_status_severity_idx" ON "moderation_flags"("status", "severity");

-- CreateIndex
CREATE INDEX "moderation_flags_subject_type_subject_id_idx" ON "moderation_flags"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_id_created_at_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_type_target_id_idx" ON "admin_audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_interests" ADD CONSTRAINT "profile_interests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_interests" ADD CONSTRAINT "profile_interests_interest_id_fkey" FOREIGN KEY ("interest_id") REFERENCES "interests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_answers" ADD CONSTRAINT "profile_answers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_answers" ADD CONSTRAINT "profile_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "prompt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_modes" ADD CONSTRAINT "user_modes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decks" ADD CONSTRAINT "decks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_entries" ADD CONSTRAINT "deck_entries_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "decks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deck_entries" ADD CONSTRAINT "deck_entries_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boosts" ADD CONSTRAINT "boosts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_contacts" ADD CONSTRAINT "trusted_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_location_sessions" ADD CONSTRAINT "live_location_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_location_sessions" ADD CONSTRAINT "live_location_sessions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_location_pings" ADD CONSTRAINT "live_location_pings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_location_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_events" ADD CONSTRAINT "emergency_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_shares" ADD CONSTRAINT "plan_shares_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_shares" ADD CONSTRAINT "plan_shares_trusted_contact_id_fkey" FOREIGN KEY ("trusted_contact_id") REFERENCES "trusted_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_venues" ADD CONSTRAINT "saved_venues_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_venues" ADD CONSTRAINT "saved_venues_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "subscription_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "subscription_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_entitlements" ADD CONSTRAINT "tier_entitlements_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "entitlement_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_initiator_id_fkey" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_safety_actions" ADD CONSTRAINT "call_safety_actions_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_safety_actions" ADD CONSTRAINT "call_safety_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_checks" ADD CONSTRAINT "moderation_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- HAND-WRITTEN CONSTRAINTS AND INDEXES
--
-- Everything below is outside what the Prisma schema language can express.
-- If you regenerate this migration, these must be re-applied.
-- ============================================================================

-- --- Geospatial indexes ------------------------------------------------------
-- Every Discover card shows a distance and every deck query filters by radius
-- (spec 2). Without a GIST index ST_DWithin degrades to a sequential scan over
-- the whole user table.

CREATE INDEX "profiles_location_gist_idx" ON "profiles" USING GIST ("location");
CREATE INDEX "venues_location_gist_idx" ON "venues" USING GIST ("location");
CREATE INDEX "live_location_pings_location_gist_idx" ON "live_location_pings" USING GIST ("location");
CREATE INDEX "emergency_events_location_gist_idx" ON "emergency_events" USING GIST ("location");

-- --- Match pair ordering -----------------------------------------------------
-- A match belongs to exactly one mode (spec 1), and the unique index on
-- (user_a_id, user_b_id, mode) only prevents duplicates if the pair is always
-- stored in the same column order. Without this CHECK, (A,B) and (B,A) are two
-- different rows and a pair could hold two matches in one mode.

ALTER TABLE "matches"
  ADD CONSTRAINT "matches_user_order_check" CHECK ("user_a_id" < "user_b_id");

-- A user cannot match themselves.
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_not_self_check" CHECK ("user_a_id" <> "user_b_id");

-- --- Swipe and block self-reference ------------------------------------------
-- Deck exclusions start with "self" (spec 5.3); enforce it at the storage layer
-- too rather than trusting every future caller.

ALTER TABLE "swipes"
  ADD CONSTRAINT "swipes_not_self_check" CHECK ("actor_id" <> "target_id");

ALTER TABLE "blocks"
  ADD CONSTRAINT "blocks_not_self_check" CHECK ("blocker_id" <> "blocked_id");

ALTER TABLE "reports"
  ADD CONSTRAINT "reports_not_self_check" CHECK ("reporter_id" <> "reported_id");

-- --- Photo ordering ----------------------------------------------------------
-- Partial unique indexes: soft-deleted photos must not keep occupying a
-- position or the primary slot. Prisma cannot express a WHERE clause on an
-- index, so these are written by hand.

CREATE UNIQUE INDEX "photos_profile_position_unique"
  ON "photos" ("profile_id", "position")
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "photos_profile_primary_unique"
  ON "photos" ("profile_id")
  WHERE "is_primary" = true AND "deleted_at" IS NULL;

-- Max 6 photos per profile (spec 7, Batch 4) is enforced in the service layer,
-- not here — a row-count constraint would require a trigger.
ALTER TABLE "photos"
  ADD CONSTRAINT "photos_position_range_check" CHECK ("position" >= 0 AND "position" <= 5);

-- --- One primary mode per user -----------------------------------------------
-- Signup picks one primary mode (spec 5.2). Onboarding can enable more, but
-- only one may be primary.

CREATE UNIQUE INDEX "user_modes_primary_unique"
  ON "user_modes" ("user_id")
  WHERE "is_primary" = true;

-- --- Preference sanity -------------------------------------------------------
-- Under-18 is rejected at registration (spec 5.1); the age range can never
-- reach below 18 regardless of what a client sends.

ALTER TABLE "user_modes"
  ADD CONSTRAINT "user_modes_age_range_check"
  CHECK ("min_age" >= 18 AND "max_age" >= "min_age" AND "max_age" <= 120);

ALTER TABLE "user_modes"
  ADD CONSTRAINT "user_modes_radius_check"
  CHECK ("radius_metres" > 0 AND "radius_metres" <= 500000);

-- --- Availability windows ----------------------------------------------------

ALTER TABLE "availability_windows"
  ADD CONSTRAINT "availability_windows_bounds_check"
  CHECK (
    "day_of_week" BETWEEN 0 AND 6
    AND "start_minute" BETWEEN 0 AND 1439
    AND "end_minute" BETWEEN 1 AND 1440
    AND "end_minute" > "start_minute"
  );

-- --- Money -------------------------------------------------------------------
-- spec 4.6: integer minor units, never floats, never negative.

ALTER TABLE "price_versions"
  ADD CONSTRAINT "price_versions_amount_check" CHECK ("amount_minor" >= 0);

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_price_level_check"
  CHECK ("price_level" IS NULL OR ("price_level" >= 1 AND "price_level" <= 4));

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_rating_check"
  CHECK ("rating" IS NULL OR ("rating" >= 0 AND "rating" <= 5));
