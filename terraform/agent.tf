# Agent-layer infrastructure (Milestone 6). No agent code depends on this yet;
# it exists so the abuse controls in MILESTONE-6-PLAN.md 6.3 have somewhere to
# live before the first endpoint that can spend money.

# --- Shared counters + kill switch -------------------------------------------
# Rate-limit counters MUST be shared across tasks. desired_count is 2, so an
# in-memory bucket would silently double every limit and make the daily
# ceiling per-task rather than global.
#
# Single table, one item per counter, keyed by a composite id:
#   session#<hash>#turns#<minute>   ttl = +2m
#   ip#<hash>#turns#<hour>          ttl = +2h
#   global#spend#<utc-date>         ttl = +2d
#   flag#agent_enabled              no ttl - the kill switch
#
# The kill switch lives here rather than in an ECS environment variable
# because an env var needs a new task definition and a service deployment to
# change, which is the opposite of a kill switch. Read per request behind a
# 10s cache; flippable from the console mid-incident.
resource "aws_dynamodb_table" "agent" {
  name         = "${var.project}-agent"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # Counters are worthless once their window closes, and expiring them keeps
  # the table from growing without bound. DynamoDB deletes on a best-effort
  # schedule (up to ~48h late), so application code must still compare the
  # window in the key rather than trusting an item's existence.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    # Every item is a short-lived counter or a flag that is trivially
    # re-set by hand. Nothing here is worth restoring, and PITR bills.
    enabled = false
  }
}

# --- Anthropic API key --------------------------------------------------------
# Created and rotated by hand, out of band, so Terraform never sees the value
# and a `terraform destroy` cannot take the key with it:
#
#   read -rs K && aws secretsmanager create-secret \
#     --name pipeline-radar/anthropic-api-key \
#     --secret-string "$K" --region us-east-1 && unset K
#
# This is the pipeline-radar-prod key only. The CI key lives in a GitHub
# Actions secret and must never reach AWS - see MILESTONE-6-PLAN.md 6.3.
data "aws_secretsmanager_secret" "anthropic" {
  name = "${var.project}/anthropic-api-key"
}

# The EXECUTION role, not the task role: the ECS agent resolves secrets at
# container start and injects them, so the running container never needs
# permission to read Secrets Manager itself.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      data.aws_secretsmanager_secret.anthropic.arn,
      aws_secretsmanager_secret.session.arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.project}-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# --- Task role ----------------------------------------------------------------
# The container's own identity, distinct from the execution role. Scoped to
# item operations on the one table; it can neither read the API key nor alter
# the table's shape.
data "aws_iam_policy_document" "task" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    resources = [aws_dynamodb_table.agent.arn]
  }
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.project}-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

output "agent_table_name" {
  value       = aws_dynamodb_table.agent.name
  description = "Rate-limit counters and the kill-switch flag"
}

# --- Session signing key ------------------------------------------------------
# The cookie gate is only meaningful if every task validates against the same
# key: desired_count is 2, so a per-process secret would mean a cookie minted
# by one task is rejected by the other.
#
# Generated here rather than by hand because, unlike the Anthropic key, this
# has no value outside the deployment and rotating it costs nothing - it
# invalidates anonymous sessions, which are a rate-limiting handle, not a
# login. The trade-off is that the value lands in Terraform state; that state
# lives in a private, encrypted, versioned bucket and already contains enough
# to compromise the stack.
resource "random_password" "session" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "session" {
  name                    = "${var.project}/session-secret"
  description             = "HMAC key for anonymous agent session cookies"
  recovery_window_in_days = 0 # a regenerated key is not worth recovering
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session.result
}
