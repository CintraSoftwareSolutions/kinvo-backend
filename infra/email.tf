# ---------------------------------------------------------------------------
# Email — Amazon SES  (spec §3, Batch 11)
# ---------------------------------------------------------------------------
#
# SES rather than generic SMTP because it needs NO STATIC CREDENTIALS: the
# instance role signs the API calls, exactly as it does for S3. SMTP would have
# put a long-lived password back on the box, which is the one thing the S3 setup
# deliberately avoids.
#
# TWO OPERATIONAL LIMITS, both real:
#
#  1. A new SES account is in SANDBOX. It delivers only to verified addresses
#     and caps at 200 messages a day. Mail to anyone else is accepted by the API
#     and silently dropped, which is the worst failure mode to discover in
#     production. Production access is a support request, and AWS asks how
#     bounces and complaints are handled — which is what the rest of this file
#     is for.
#
#  2. Without a verified DOMAIN there is no DKIM or SPF alignment, so delivered
#     mail is far more likely to land in spam. That needs a domain; it cannot be
#     configured around.

# The sender. A bare address until a domain exists — verified out of band,
# because AWS emails a confirmation link that a human has to click.
data "aws_sesv2_email_identity" "sender" {
  email_identity = var.ses_sender_address
}

# ---------------------------------------------------------------------------
# Bounce and complaint handling
# ---------------------------------------------------------------------------
#
# Not optional, and not only for AWS's benefit. Without suppression, one dead
# address is retried on every send forever, the bounce rate climbs, and AWS
# suspends the account. A suspended SES account takes password resets down with
# it.

resource "aws_sns_topic" "email_events" {
  name = "${local.name}-email-events"

  tags = { Name = "${local.name}-email-events" }
}

# Groups the events and routes them at the topic. A configuration set is also
# how sending is attributed later — reputation metrics are per set, so a
# transactional set can be watched separately from anything marketing.
resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = local.name

  delivery_options {
    # Refuse to send unencrypted rather than downgrade silently.
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "${local.name}-sns"

  event_destination {
    enabled = true

    # BOUNCE and COMPLAINT are the two that must suppress an address. DELIVERY
    # and REJECT are carried because a delivery rate that quietly drops is the
    # first sign of a reputation problem, and REJECT means SES refused before
    # it ever left.
    matching_event_types = ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.email_events.arn
    }
  }
}

# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

resource "aws_iam_role_policy" "ses" {
  name = "${local.name}-ses"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ses:SendEmail", "ses:SendRawEmail"]
        # Scoped to the one identity and the one configuration set. A wildcard
        # here would let a compromised instance send as any verified identity in
        # the account.
        Resource = [
          data.aws_sesv2_email_identity.sender.arn,
          aws_sesv2_configuration_set.main.arn,
        ]
      }
    ]
  })
}

output "ses_sender" {
  value       = var.ses_sender_address
  description = "Verified SES sender. Sandbox delivers only to verified recipients."
}

output "ses_events_topic_arn" {
  value       = aws_sns_topic.email_events.arn
  description = "Bounce and complaint events. Subscribe the API webhook to this."
}

# ---------------------------------------------------------------------------
# Reputation alarms
# ---------------------------------------------------------------------------
#
# SES suppresses bounced and complained addresses at the ACCOUNT level already
# — that was checked, not assumed: SuppressedReasons is ["BOUNCE","COMPLAINT"].
# So the application needs no suppression table and no webhook; SES refuses to
# send to a dead address on its own.
#
# What is still needed is knowing when the rates climb, because AWS suspends
# accounts that cross the thresholds and a suspended SES account takes password
# resets down with it. These alarms are that, and they are also the honest
# answer to "how do you handle bounces?" on the production-access request.

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"

  tags = { Name = "${local.name}-alarms" }
}

# An alarm nobody receives is decoration. Confirmed out of band — AWS sends a
# subscription confirmation link.
resource "aws_sns_topic_subscription" "alarms_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.ses_sender_address
}

# AWS review begins around 5%. Alarming at 3% leaves room to find the cause
# before the account is at risk rather than after.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  alarm_name          = "${local.name}-ses-bounce-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.BounceRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Average"
  threshold           = 0.03

  alarm_description = "SES bounce rate above 3%. AWS reviews accounts at 5%."
  alarm_actions     = [aws_sns_topic.alarms.arn]

  # Missing data means nothing was sent that hour, which is not a problem.
  treat_missing_data = "notBreaching"
}

# Complaints are judged far more harshly than bounces: AWS acts around 0.1%,
# so this alarms at a third of that.
resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  alarm_name          = "${local.name}-ses-complaint-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.ComplaintRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Average"
  threshold           = 0.0003

  alarm_description  = "SES complaint rate above 0.03%. AWS acts at 0.1%."
  alarm_actions      = [aws_sns_topic.alarms.arn]
  treat_missing_data = "notBreaching"
}
