# ---------------------------------------------------------------------------
# S3 — replaces local MinIO
#
# Two buckets, matching docker-compose exactly, because the separation is a
# safety property and not a naming convention: government ID images must never
# share a bucket policy with profile selfies (spec §7, Batch 4).
#
# The application changes nothing. S3_ENDPOINT and S3_FORCE_PATH_STYLE are
# simply absent in the cloud, so the AWS SDK talks to real S3 instead of MinIO.
# ---------------------------------------------------------------------------

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

locals {
  media_bucket        = "${local.name}-media-${random_id.bucket_suffix.hex}"
  verification_bucket = "${local.name}-verification-${random_id.bucket_suffix.hex}"
}

resource "aws_s3_bucket" "media" {
  bucket = local.media_bucket
  tags   = { Name = local.media_bucket, Contents = "profile-photos-chat-media" }
}

resource "aws_s3_bucket" "verification" {
  bucket = local.verification_bucket
  tags   = { Name = local.verification_bucket, Contents = "government-id-report-evidence" }
}

# Both buckets are private. Every read is a presigned URL minted per request,
# which is what makes the short verification-document URL lifetime meaningful.
resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "verification" {
  bucket                  = aws_s3_bucket.verification.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "verification" {
  bucket = aws_s3_bucket.verification.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Versioning on the verification bucket only. An accidental delete of an ID
# document during a dispute is unrecoverable otherwise; profile photos are not
# worth the storage cost.
resource "aws_s3_bucket_versioning" "verification" {
  bucket = aws_s3_bucket.verification.id
  versioning_configuration { status = "Enabled" }
}

# The stricter lifecycle the spec asks for. Verification documents are the most
# sensitive data in the system and have no reason to be retained once review is
# done — holding them indefinitely is a liability, not a feature.
resource "aws_s3_bucket_lifecycle_configuration" "verification" {
  bucket = aws_s3_bucket.verification.id

  rule {
    id     = "expire-verification-documents"
    status = "Enabled"
    filter {}

    expiration { days = 180 }
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}

    # A presigned upload the client abandoned halfway leaves billable parts.
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }

  # Nightly database dumps.
  #
  # Postgres runs in a container on the API instance with its data in a local
  # volume, so losing the instance loses the database. Until it moves to RDS,
  # these dumps are the only thing standing between a terminated instance and
  # starting over — including every account the mobile team has set up.
  #
  # Fourteen days is enough to notice corruption that was not obvious on the
  # day it happened, and cheap: a dump of this database is measured in
  # kilobytes.
  rule {
    id     = "expire-database-backups"
    status = "Enabled"

    filter { prefix = "_backups/" }

    expiration { days = 14 }
  }
}

# CORS so the mobile client can PUT straight to the presigned URL. Without this
# the browser-based admin console (and some HTTP stacks) reject the upload.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = ["*"]
    max_age_seconds = 3000
  }
}

# ---------------------------------------------------------------------------
# ECR — where the API image lives
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration { scan_on_push = true }
}

# Old images are pure cost. Keep enough to roll back, discard the rest.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# Instance identity
#
# The instance gets an IAM role, not access keys. Nothing secret is written to
# the box, so a compromised instance cannot yield credentials that outlive it —
# and there is no key to rotate or accidentally commit.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "instance" {
  name = "${local.name}-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Object-level access to exactly these two buckets, and nothing else in S3.
resource "aws_iam_role_policy" "s3" {
  name = "${local.name}-s3"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.media.arn}/*", "${aws_s3_bucket.verification.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [aws_s3_bucket.media.arn, aws_s3_bucket.verification.arn]
      }
    ]
  })
}

# Pull the API image from ECR.
resource "aws_iam_role_policy_attachment" "ecr" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Session Manager: shell access with no open SSH port and an audit trail.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}
