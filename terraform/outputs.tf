output "app_url" {
  description = "Share this with the interviewer"
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "distribution_id" {
  description = "Used by CI to invalidate after a deploy"
  value       = aws_cloudfront_distribution.main.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.id
}
