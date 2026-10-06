-- Granular admin roles, permissions and guardrails (Batch 15 — admin panel).
--
-- PURELY ADDITIVE. Five new tables and nothing else: no column on any existing
-- table changes, no enum changes, no drops. The mobile app's contract cannot
-- move because of this migration, which is the constraint this whole batch is
-- built under.
--
-- WHAT WAS REMOVED FROM THIS FILE, and must stay removed:
--
-- `prisma migrate dev` also generated 4 statements dropping the PostGIS
-- GIST indexes on profiles, venues, emergency_events and live_location_pings.
-- That is not drift. Those columns are `Unsupported("geography")` because
-- Prisma cannot model them, so it cannot see their indexes either and reads
-- every one as something to remove.
--
-- Applying them costs nothing at migrate time and turns every radius query into
-- a sequential scan — the deck builder, venue search and the safety trail all
-- go through them. A silent full-table scan on the hottest query in the product.
--
-- This is the THIRD time it has happened. `tests/unit/migrations.test.ts` now
-- fails if a committed migration contains one of these drops, so it cannot slip
-- through on the fourth.

-- CreateTable
CREATE TABLE "admin_roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "category" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_role_permissions" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_role_members" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_role_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_guardrails" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_key_key" ON "admin_roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "admin_permissions_key_key" ON "admin_permissions"("key");

-- CreateIndex
CREATE INDEX "admin_permissions_category_idx" ON "admin_permissions"("category");

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_permissions_role_id_permission_id_key" ON "admin_role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "admin_role_members_role_id_idx" ON "admin_role_members"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_members_user_id_role_id_key" ON "admin_role_members"("user_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_guardrails_key_key" ON "admin_guardrails"("key");

-- AddForeignKey
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "admin_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_role_members" ADD CONSTRAINT "admin_role_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_role_members" ADD CONSTRAINT "admin_role_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_role_members" ADD CONSTRAINT "admin_role_members_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_guardrails" ADD CONSTRAINT "admin_guardrails_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
