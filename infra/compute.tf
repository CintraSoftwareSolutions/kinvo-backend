# ---------------------------------------------------------------------------
# Secrets
#
# Generated here and stored in SSM Parameter Store as SecureStrings, so nothing
# secret is typed by a human, committed, or written to disk on the instance.
# The instance reads them at boot through its IAM role.
#
# They do land in Terraform state, which is why state is git-ignored and must
# move to an encrypted S3 backend before anyone else runs this.
# ---------------------------------------------------------------------------

resource "random_password" "jwt_access" {
  length  = 48
  special = false
}

resource "random_password" "jwt_refresh" {
  length  = 48
  special = false
}

resource "random_password" "db" {
  length = 32
  # Excluded because the value goes into a postgres:// URL, where they would
  # need escaping and silently break the connection string.
  special = false
}

# Proves a request came from OUR CloudFront distribution.
#
# The security group already limits the origin to CloudFront's address ranges,
# but those ranges belong to every CloudFront customer — anyone could point
# their own distribution at this Elastic IP and be inside the allowed CIDRs.
# The header is what makes it ours specifically.
resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

locals {
  secrets = {
    jwt_access_secret  = random_password.jwt_access.result
    jwt_refresh_secret = random_password.jwt_refresh.result
    db_password        = random_password.db.result
    origin_secret      = random_password.origin_secret.result
  }
}

resource "aws_ssm_parameter" "secret" {
  for_each = local.secrets

  name  = "/${var.project}/${var.environment}/${each.key}"
  type  = "SecureString"
  value = each.value

  tags = { Name = "${local.name}-${each.key}" }
}

resource "aws_iam_role_policy" "ssm_read" {
  name = "${local.name}-ssm-read"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
      Resource = "arn:aws:ssm:${var.aws_region}:*:parameter/${var.project}/${var.environment}/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# The instance
# ---------------------------------------------------------------------------

# Amazon Linux 2023. The architecture here MUST match var.instance_type —
# AWS refuses to launch on a mismatch, which is the good outcome.
data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.ami.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  # IMDSv2 only. Version 1 lets any server-side request forgery bug in the app
  # read the instance's IAM credentials with a plain GET.
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  user_data = templatefile("${path.module}/user-data.sh", {
    aws_region          = var.aws_region
    project             = var.project
    environment         = var.environment
    ecr_repository      = aws_ecr_repository.api.repository_url
    media_bucket        = aws_s3_bucket.media.id
    verification_bucket = aws_s3_bucket.verification.id
    ses_sender_address  = var.ses_sender_address
    ses_configuration_set = aws_sesv2_configuration_set.main.configuration_set_name
    domain_name         = var.domain_name
    log_level           = var.log_level
  })

  # Left true so that IF the instance is ever intentionally rebuilt, it boots
  # from the current script rather than a stale one.
  user_data_replace_on_change = true

  lifecycle {
    # user-data runs ONCE, at first boot. After that the instance is maintained
    # by deploy.sh over SSM, so an edit here changes nothing about the running
    # box — it only changes what a FUTURE instance would boot with.
    #
    # Without this, editing the bootstrap script queues a destroy-and-recreate
    # on the next apply. Postgres and Redis run in containers on this instance
    # with their data in local volumes, so that apply would take the database
    # with it — and the plan says "must be replaced", not "will delete your
    # data". Rebuilding has to be a deliberate act:
    #
    #     terraform apply -replace=aws_instance.api
    #
    # …and it must be preceded by a backup restore plan. The nightly dumps in
    # storage.tf exist for exactly this reason.
    ignore_changes = [user_data]
  }

  tags = { Name = "${local.name}-api" }
}

# A fixed address. Without it the public IP changes on every stop/start, and
# anything pointing at the old one silently breaks.
resource "aws_eip" "api" {
  instance = aws_instance.api.id
  domain   = "vpc"

  tags = { Name = "${local.name}-eip" }
}
