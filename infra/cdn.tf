# ---------------------------------------------------------------------------
# CloudFront — HTTPS without owning a domain
#
# iOS App Transport Security refuses plain http://, and no certificate authority
# will issue a certificate for a bare IP address. CloudFront hands you
# https://xxxx.cloudfront.net on an AWS certificate, which is enough for the
# mobile app and TestFlight while a domain is being sorted out.
#
# The honest caveat: TLS terminates at CloudFront and the hop to the instance is
# HTTP. Acceptable for staging with test data; not acceptable for production
# with real users. Set var.domain_name and Caddy takes over TLS end to end,
# at which point this distribution can be pointed at the domain or removed.
# ---------------------------------------------------------------------------

locals {
  create_cdn = var.domain_name == ""
}

# An API is not a website. Every response is user-specific and must never be
# served from cache to the wrong person.
resource "aws_cloudfront_cache_policy" "no_cache" {
  count = local.create_cdn ? 1 : 0

  name        = "${local.name}-no-cache"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    # enable_accept_encoding_gzip is deliberately absent. CloudFront rejects it
    # when caching is disabled — content-encoding negotiation only means
    # something if responses are cached, and all TTLs here are zero.
    # Compression still happens: `compress = true` on the cache behaviour below.

    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# Everything the API needs must reach it. Authorization in particular: drop that
# header and every authenticated request fails with AUTH_REQUIRED.
resource "aws_cloudfront_origin_request_policy" "forward_all" {
  count = local.create_cdn ? 1 : 0

  name = "${local.name}-forward-all"

  cookies_config { cookie_behavior = "all" }
  query_strings_config { query_string_behavior = "all" }

  headers_config {
    header_behavior = "allViewer"
  }
}

resource "aws_cloudfront_distribution" "api" {
  count = local.create_cdn ? 1 : 0

  enabled         = true
  comment         = "${local.name} API"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    domain_name = aws_eip.api.public_dns
    origin_id   = "api"

    custom_origin_config {
      http_port  = 80
      https_port = 443
      # http-only until a domain exists: a public certificate authority will not
      # issue for a bare IP, so there is nothing for CloudFront to validate.
      # The hop is inside AWS's network and, with the security group and the
      # header below, reachable from nowhere else.
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }

    # Caddy rejects anything without this. See the note on
    # random_password.origin_secret: the prefix list proves "a CloudFront", this
    # proves "our CloudFront".
    custom_header {
      name  = "X-Origin-Secret"
      value = random_password.origin_secret.result
    }
  }

  default_cache_behavior {
    target_origin_id = "api"
    # Redirects http:// callers rather than refusing them, so a misconfigured
    # client gets a working request instead of a confusing failure.
    viewer_protocol_policy = "redirect-to-https"

    # POST, PUT, PATCH and DELETE must be allowed or the API is read-only.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = aws_cloudfront_cache_policy.no_cache[0].id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.forward_all[0].id

    compress = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    # The default *.cloudfront.net certificate. Valid, trusted, and free.
    cloudfront_default_certificate = true
  }

  tags = { Name = "${local.name}-cdn" }
}
