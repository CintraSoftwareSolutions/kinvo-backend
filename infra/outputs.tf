output "api_base_url" {
  description = "What the mobile team puts in their Dio config."
  value = var.domain_name != "" ? "https://${var.domain_name}/api/v1" : (
    local.create_cdn ? "https://${aws_cloudfront_distribution.api[0].domain_name}/api/v1" : ""
  )
}

output "health_url" {
  description = "Should return the spec 4.2 envelope with status ok."
  value = var.domain_name != "" ? "https://${var.domain_name}/health" : (
    local.create_cdn ? "https://${aws_cloudfront_distribution.api[0].domain_name}/health" : ""
  )
}

output "instance_public_ip" {
  description = "Fixed Elastic IP. Point a domain here when you have one."
  value       = aws_eip.api.public_ip
}

output "instance_id" {
  description = "For: aws ssm start-session --target <id>"
  value       = aws_instance.api.id
}

output "ecr_repository_url" {
  description = "Push the API image here."
  value       = aws_ecr_repository.api.repository_url
}

output "media_bucket" {
  value = aws_s3_bucket.media.id
}

output "verification_bucket" {
  description = "Government ID images. Separate bucket, stricter lifecycle."
  value       = aws_s3_bucket.verification.id
}

output "deploy_command" {
  description = "Build, push, and restart the API in one line."
  value       = <<-EOT
    aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${aws_ecr_repository.api.repository_url}
    docker build --platform linux/arm64 -t ${aws_ecr_repository.api.repository_url}:latest .
    docker push ${aws_ecr_repository.api.repository_url}:latest
    aws ssm send-command --instance-ids ${aws_instance.api.id} --document-name AWS-RunShellScript --parameters 'commands=["cd /opt/kinvo && docker compose pull api && docker compose up -d api"]' --region ${var.aws_region}
  EOT
}

output "migrate_command" {
  description = "Apply migrations and seed, run on the instance."
  value       = <<-EOT
    aws ssm start-session --target ${aws_instance.api.id} --region ${var.aws_region}
    # then, on the box:
    cd /opt/kinvo && docker compose run --rm api npx prisma migrate deploy
  EOT
}
