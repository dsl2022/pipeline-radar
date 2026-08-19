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

# com.amazonaws.global.cloudfront.origin-facing in the deployment region.
# `aws ec2 describe-managed-prefix-lists` to find it for other regions.
variable "cloudfront_prefix_list_id" {
  type    = string
  default = "pl-3b927c52"
}
