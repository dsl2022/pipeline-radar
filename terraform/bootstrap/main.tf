# One-time bootstrap, applied MANUALLY from a laptop with admin credentials.
# Mirrors the old GithubOidcStack: after this exists, GitHub Actions never
# needs stored AWS keys. Uses LOCAL state on purpose — it creates the very
# bucket the main layer stores its state in, so it cannot use a remote backend.
#
#   cd terraform/bootstrap && terraform init && terraform apply

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "github_repo" {
  type        = string
  description = "owner/repo allowed to assume the deploy role"
  default     = "dsl2022/pipeline-radar"
}

variable "deploy_ref" {
  type        = string
  description = "Exact git ref allowed to deploy - fork PRs can never match this"
  default     = "refs/heads/main"
}

# GitHub can issue either a plain sub claim (repo:owner/repo:ref:...) or an
# ID-qualified one (repo:owner@<owner_id>/repo@<repo_id>:ref:...) depending on
# whether immutable subject claims are enabled. The numeric IDs survive a
# rename, so a deleted-and-recreated repo of the same name can't inherit trust.
# Both are pinned exactly - see the sub condition below.
#   gh api repos/OWNER/REPO --jq '{repo_id: .id, owner_id: .owner.id}'
variable "github_owner_id" {
  type        = number
  description = "Numeric GitHub account id of the repo owner"
  default     = 11345415
}

variable "github_repo_id" {
  type        = number
  description = "Numeric GitHub repository id"
  default     = 1339087067
}

variable "project" {
  type    = string
  default = "pipeline-radar"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  # "owner/repo" -> "owner@<owner_id>/repo@<repo_id>"
  github_owner = split("/", var.github_repo)[0]
  github_name  = split("/", var.github_repo)[1]

  github_repo_qualified = "${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}"
}

# --- Terraform state backend -------------------------------------------------
# CI runners are ephemeral, so state has to live remotely. Versioning is on so
# a botched apply can be rolled back.

resource "aws_s3_bucket" "state" {
  bucket        = "${var.project}-tfstate-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "state_lock" {
  name         = "${var.project}-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# --- ECR ---------------------------------------------------------------------
# Lives here rather than in the app layer so CI can push an image BEFORE the
# app layer runs (the task definition needs an image tag that already exists).

resource "aws_ecr_repository" "api" {
  name                 = "${var.project}-api"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# --- GitHub OIDC -------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Exact ref, not a wildcard: a fork PR can never assume this role. Two
    # exact values rather than a StringLike wildcard - StringEquals ORs the
    # list, so both claim formats are accepted without loosening the match.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:${var.deploy_ref}",
        "repo:${local.github_repo_qualified}:ref:${var.deploy_ref}",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.project}-github-deploy"
  description        = "Assumed by GitHub Actions (OIDC) to run terraform apply on push to main"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Terraform has no bootstrap-role indirection the way CDK does, so this role
# needs real permissions. Scoped to the services the stack actually uses.
data "aws_iam_policy_document" "deploy" {
  statement {
    effect = "Allow"
    actions = [
      "ec2:*", "ecs:*", "ecr:*", "elasticloadbalancing:*",
      "cloudfront:*", "s3:*", "logs:*", "application-autoscaling:*",
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem",
    ]
    resources = ["*"]
  }

  # PassRole is what lets ECS assume the task roles; keep it to this project.
  statement {
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-*"]
  }

  # Milestone 6 adds a DynamoDB table for the agent's shared rate-limit
  # counters and its kill-switch flag (MILESTONE-6-PLAN.md 6.3). Scoped to
  # this project's tables. The GetItem/PutItem/DeleteItem above are a
  # different thing entirely - they are the S3 backend's state lock.
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeTable",
      "dynamodb:UpdateTable", "dynamodb:TagResource", "dynamodb:UntagResource",
      "dynamodb:ListTagsOfResource",
      "dynamodb:DescribeTimeToLive", "dynamodb:UpdateTimeToLive",
      "dynamodb:DescribeContinuousBackups", "dynamodb:UpdateContinuousBackups",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:dynamodb:*:${data.aws_caller_identity.current.account_id}:table/${var.project}-*"]
  }

  # The Anthropic API key is created and rotated by hand, out of band. CI only
  # needs to resolve its ARN to wire it into the task definition - never to
  # read the value, never to create or delete it. Reading is the task
  # execution role's job at container start, granted in the app layer.
  # Two secrets, two very different levels of access, scoped per secret rather
  # than across the whole project prefix.
  #
  # The session signing key is generated and owned by Terraform, so CI needs
  # its full lifecycle including reading the value back to detect drift.
  # Losing it is harmless: it only invalidates anonymous rate-limiting
  # cookies.
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret",
      "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds",
      "secretsmanager:TagResource", "secretsmanager:UntagResource",
      "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:${var.project}/session-secret-*"]
  }

  # The Anthropic key is created and rotated by hand and stays read-only to
  # CI: enough metadata to resolve its ARN for the task definition, never
  # GetSecretValue. Reading it is the task execution role's job at container
  # start. GetResourcePolicy is not optional - the
  # aws_secretsmanager_secret data source reads the attached resource policy
  # as one of its attributes, so a plan fails without it even though nothing
  # here uses that attribute. Both actions return metadata, not the value.
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:${var.project}/anthropic-api-key-*"]
  }

  # ListSecrets has no resource dimension, so it cannot be scoped. It returns
  # metadata only (names and ARNs, never values) and some provider versions
  # need it to resolve a secret by name.
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:TagRole",
      "iam:ListRoleTags", "iam:UpdateAssumeRolePolicy",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      # GetRolePolicy completes the inline-policy lifecycle alongside
      # Put/Delete/List. It was not needed until Milestone 6 because every
      # earlier role used managed-policy attachments; the agent's task role
      # and the execution role's secret grant are the first inline policies,
      # and Terraform reads one back after writing it.
      "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
      "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:CreateServiceLinkedRole",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN repo variable in GitHub"
  value       = aws_iam_role.deploy.arn
}

output "state_bucket" {
  value = aws_s3_bucket.state.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}
