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

# Lets the deploy assert that the revision it just applied is the one actually
# running. ECS's circuit breaker rolls a bad task definition back and the
# service then reports a healthy steady state, so "apply succeeded" and even
# "service is stable" are both true while production runs the previous image.
output "task_definition_arn" {
  value       = aws_ecs_task_definition.api.arn
  description = "The task definition revision this apply created"
}
