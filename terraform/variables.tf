variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "pipeline-radar"
}

variable "env_name" {
  type    = string
  default = "prod"
}

variable "image_tag" {
  type        = string
  description = "ECR image tag to deploy - CI passes the commit SHA"
}

# Flip to true AFTER creating the secret by hand (see terraform/agent.tf for
# the pattern):
#   aws secretsmanager create-secret --name pipeline-radar/langfuse \
#     --secret-string '{"publicKey":"pk-lf-...","secretKey":"sk-lf-..."}' \
#     --region us-east-1
# False keeps the data source out of the plan entirely, so deploys never
# break on a secret that does not exist yet.
variable "langfuse_enabled" {
  type        = bool
  default     = false
  description = "Wire Langfuse tracing keys from Secrets Manager into the task"
}

# com.amazonaws.global.cloudfront.origin-facing in the deployment region.
# `aws ec2 describe-managed-prefix-lists` to find it for other regions.
variable "cloudfront_prefix_list_id" {
  type    = string
  default = "pl-3b927c52"
}
