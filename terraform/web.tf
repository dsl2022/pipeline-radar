# Private S3 bucket (OAC only - no public bucket policy, no website endpoint)
# behind CloudFront. One distribution, two origins: default -> S3 (the Vite
# build), /api/* -> the ALB. The frontend fetches relative /api/... so nothing
# environment-specific is ever baked into the bundle.

resource "aws_s3_bucket" "web" {
  bucket = "${var.project}-web-${data.aws_caller_identity.current.account_id}"

  # Interview project: tearing down cleanly matters more than retention.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.project}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Only this distribution may read the bucket, and only over TLS.
data "aws_iam_policy_document" "web" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }

  statement {
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web.json
}

# --- dist upload -------------------------------------------------------------
# Replaces CDK's BucketDeployment. etag on content means re-running apply after
# a rebuild uploads only what changed.

locals {
  dist_dir   = "${path.module}/../pipeline-radar/dist"
  dist_index = "${local.dist_dir}/index.html"
  dist_files = fileexists(local.dist_index) ? fileset(local.dist_dir, "**") : toset([])

  content_types = {
    html  = "text/html"
    css   = "text/css"
    js    = "application/javascript"
    json  = "application/json"
    svg   = "image/svg+xml"
    png   = "image/png"
    jpg   = "image/jpeg"
    ico   = "image/x-icon"
    woff2 = "font/woff2"
    map   = "application/json"
    txt   = "text/plain"
  }
}

resource "aws_s3_object" "web" {
  for_each = local.dist_files

  bucket       = aws_s3_bucket.web.id
  key          = each.value
  source       = "${local.dist_dir}/${each.value}"
  etag         = filemd5("${local.dist_dir}/${each.value}")
  content_type = lookup(local.content_types, lower(reverse(split(".", each.value))[0]), "application/octet-stream")
}

# The interviewer-facing demo guide at a clean, shareable /demo-guide. A
# second key for the same file: the for_each above serves it at
# /demo-guide.html by extension, but an extensionless key would fall through
# the content-type lookup to octet-stream and download instead of render -
# so this object pins text/html explicitly.
resource "aws_s3_object" "demo_guide_clean_path" {
  count = fileexists("${local.dist_dir}/demo-guide.html") ? 1 : 0

  bucket       = aws_s3_bucket.web.id
  key          = "demo-guide"
  source       = "${local.dist_dir}/demo-guide.html"
  etag         = filemd5("${local.dist_dir}/demo-guide.html")
  content_type = "text/html"
}

# --- distribution ------------------------------------------------------------

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# SPA routing is done at the edge on the way IN, not by rewriting errors on
# the way out. custom_error_response is distribution-wide - it cannot be
# scoped to a cache behaviour - and it rewrites ORIGIN errors as well as
# CloudFront's own. With a 403 -> 200 /index.html rule in place, every denial
# the API returns (no session, forged cookie, cross-site) reached the browser
# as HTTP 200 carrying the HTML shell, so the agent's guards looked like they
# had passed. Verified against production before this change:
#
#   GET /api/definitely-not-a-route  ->  200  <!doctype html>...   (origin said 404)
#
# Rewriting the URI before the origin means SPA routes never produce an error
# to rewrite, so API status codes survive intact.
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.project}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Serve index.html for client-side routes without touching API responses"
  publish = true

  code = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // Defensive: this function is only attached to the S3 behaviour, so
      // /api/* should never reach it. Cheap insurance if that ever changes.
      if (uri.startsWith('/api/')) return request;

      // Static pages published at clean extensionless paths - real S3 keys
      // that must bypass the SPA rewrite. Review caught the original miss:
      // without this, /demo-guide silently served the app shell and the S3
      // object was unreachable dead weight.
      if (uri === '/demo-guide') return request;

      // Anything with an extension is a real object - let S3 answer, including
      // answering 404 for a genuinely missing asset.
      var last = uri.substring(uri.lastIndexOf('/') + 1);
      if (last.indexOf('.') !== -1) return request;

      request.uri = '/index.html';
      return request;
    }
  JS
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  web_acl_id          = aws_wafv2_web_acl.main.arn
  comment             = "${var.project} ${var.env_name}"
  default_root_object = "index.html"

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]

      # Defaults to 30s, and for a streamed response it applies to the gap
      # BETWEEN packets - so an agent turn that thinks for 35s without
      # emitting a token would have its SSE stream cut. 60 is the maximum
      # without a service quota increase. The real fix is the server-side
      # heartbeat (every 10s); this is headroom behind it.
      origin_read_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    # The agent chat endpoint is a POST. Without the write methods here
    # CloudFront rejects it with 403 before it ever reaches the ALB, which
    # reads like an application bug. cached_methods stays GET/HEAD - a POST
    # must never be served from cache.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    # The proxy caches server-side; CloudFront must not double-cache (and must
    # forward query strings, which the API cache key needs).
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
