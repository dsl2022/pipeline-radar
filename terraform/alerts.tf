# Alerting (MILESTONE-6-PLAN.md 8): one SNS topic, one Slack forwarder, and
# only the alarms that would page a single operator. Everything else is
# dashboard-only by design - a paging hierarchy for an audience of one is
# ceremony, and every additional alarm trains that operator to ignore alarms.
#
# The Slack webhook is created by hand, out of band (like the Anthropic key):
#   read -rs W && aws secretsmanager create-secret \
#     --name pipeline-radar/slack-webhook \
#     --secret-string "$W" --region us-east-1 && unset W
# Until it exists, alarms still evaluate and the forwarder logs-and-drops.

data "aws_partition" "current" {}

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

data "archive_file" "slack_forwarder" {
  type        = "zip"
  source_file = "${path.module}/lambda/slack-forwarder.mjs"
  output_path = "${path.module}/lambda/slack-forwarder.zip"
}

resource "aws_iam_role" "alerts_forwarder" {
  name = "${var.project}-alerts-forwarder"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

data "aws_iam_policy_document" "alerts_forwarder" {
  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${data.aws_partition.current.partition}:logs:*:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project}-*"]
  }
  # The webhook value is read at invoke time, never stored in Terraform state.
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:${var.project}/slack-webhook-*"]
  }
}

resource "aws_iam_role_policy" "alerts_forwarder" {
  name   = "${var.project}-alerts-forwarder"
  role   = aws_iam_role.alerts_forwarder.id
  policy = data.aws_iam_policy_document.alerts_forwarder.json
}

resource "aws_lambda_function" "slack_forwarder" {
  function_name    = "${var.project}-slack-forwarder"
  role             = aws_iam_role.alerts_forwarder.arn
  runtime          = "nodejs22.x"
  handler          = "slack-forwarder.handler"
  filename         = data.archive_file.slack_forwarder.output_path
  source_code_hash = data.archive_file.slack_forwarder.output_base64sha256
  timeout          = 15

  environment {
    variables = { WEBHOOK_SECRET_NAME = "${var.project}/slack-webhook" }
  }
}

resource "aws_lambda_permission" "sns_invoke" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_forwarder.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "slack" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_forwarder.arn
}

# --- The alarms that page -----------------------------------------------------
# The daily app-layer ceiling is $10 (MILESTONE-6-PLAN.md 6.3). cost_usd is
# an estimate from token counts (metrics.ts) - the authoritative number is
# the Anthropic Console - but it is the number available at alarm speed.
# Cost is summed across outcome dimensions with metric math because EMF emits
# each turn under its own Outcome value.

locals {
  cost_query = {
    ok    = { Outcome = "ok" }
    error = { Outcome = "error" }
  }
}

resource "aws_cloudwatch_metric_alarm" "budget_80" {
  alarm_name          = "${var.project}-agent-budget-80pct"
  alarm_description   = "Agent spend estimate crossed 80% of the $10 daily app-layer ceiling"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 8
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "estimated cost (USD, 1d)"
    return_data = true
  }
  dynamic "metric_query" {
    for_each = local.cost_query
    content {
      id = "c_${metric_query.key}"
      metric {
        namespace   = "PipelineRadar/Agent"
        metric_name = "cost_usd"
        dimensions  = metric_query.value
        period      = 86400
        stat        = "Sum"
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "budget_100" {
  alarm_name          = "${var.project}-agent-budget-100pct"
  alarm_description   = "Agent spend estimate crossed the $10 daily app-layer ceiling - the 503 gate should be engaging"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 10
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "estimated cost (USD, 1d)"
    return_data = true
  }
  dynamic "metric_query" {
    for_each = local.cost_query
    content {
      id = "c_${metric_query.key}"
      metric {
        namespace   = "PipelineRadar/Agent"
        metric_name = "cost_usd"
        dimensions  = metric_query.value
        period      = 86400
        stat        = "Sum"
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "${var.project}-agent-error-rate"
  alarm_description   = "More than 10% of agent turns failing, sustained 5 minutes"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  metric_query {
    id = "rate"
    # IF, not MAX([series, scalar]): CloudWatch metric math refuses a mixed
    # array as an operand ("Unsupported operand type(s) for MAX"), learned
    # from a live apply. The IF form guards the zero-turn window natively.
    expression  = "IF((errors + oks) > 0, 100 * errors / (errors + oks), 0)"
    label       = "error rate %"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "PipelineRadar/Agent"
      metric_name = "turns"
      dimensions  = { Outcome = "error" }
      period      = 300
      stat        = "Sum"
    }
  }
  metric_query {
    id = "oks"
    metric {
      namespace   = "PipelineRadar/Agent"
      metric_name = "turns"
      dimensions  = { Outcome = "ok" }
      period      = 300
      stat        = "Sum"
    }
  }
}

# Anthropic 401/403 means the key was revoked or rotated wrong - the demo is
# down until a human acts. Filtered from the structured turn_error log; the
# error string carries the upstream status, never any user text.
resource "aws_cloudwatch_log_metric_filter" "anthropic_auth" {
  name           = "${var.project}-anthropic-auth-failure"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.evt = \"agent.turn_error\" && ($.err = \"*401*\" || $.err = \"*403*\") }"

  metric_transformation {
    name          = "anthropic_auth_failures"
    namespace     = "PipelineRadar/Agent"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "anthropic_auth" {
  alarm_name          = "${var.project}-anthropic-auth-failure"
  alarm_description   = "Agent turns failing with upstream 401/403 - API key revoked or rotated wrong"
  namespace           = "PipelineRadar/Agent"
  metric_name         = "anthropic_auth_failures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- Dashboard-only signals ---------------------------------------------------
# Everything the plan keeps off the pager: rate-limit pressure, citation
# health, cache health, latency. One screen, no notifications.

resource "aws_cloudwatch_dashboard" "agent" {
  dashboard_name = "${var.project}-agent"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 8, height = 6,
        properties = {
          title = "Turns by outcome", region = var.region, stat = "Sum", period = 300,
          metrics = [
            ["PipelineRadar/Agent", "turns", "Outcome", "ok"],
            ["PipelineRadar/Agent", "turns", "Outcome", "error"],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 0, width = 8, height = 6,
        properties = {
          title   = "Estimated cost (USD)", region = var.region, stat = "Sum", period = 3600,
          metrics = [["PipelineRadar/Agent", "cost_usd", "Outcome", "ok"]]
        }
      },
      {
        type = "metric", x = 16, y = 0, width = 8, height = 6,
        properties = {
          title = "Rate-limit blocks by scope", region = var.region, stat = "Sum", period = 300,
          metrics = [
            ["PipelineRadar/Agent", "ratelimit_blocked", "Scope", "session-minute"],
            ["PipelineRadar/Agent", "ratelimit_blocked", "Scope", "session-hour"],
            ["PipelineRadar/Agent", "ratelimit_blocked", "Scope", "ip-minute"],
            ["PipelineRadar/Agent", "ratelimit_blocked", "Scope", "ip-hour"],
            ["PipelineRadar/Agent", "ratelimit_blocked", "Scope", "global-daily"],
            ["PipelineRadar/Agent", "ratelimit_blocked", "Scope", "kill-switch"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 8, height = 6,
        properties = {
          title   = "Unverified citations (grounding failures)", region = var.region, stat = "Sum", period = 3600,
          metrics = [["PipelineRadar/Agent", "citations_unverified", "Outcome", "ok"]]
        }
      },
      {
        type = "metric", x = 8, y = 6, width = 8, height = 6,
        properties = {
          title = "Cache health (read vs creation tokens)", region = var.region, stat = "Sum", period = 3600,
          metrics = [
            ["PipelineRadar/Agent", "cache_read_tokens", "Outcome", "ok"],
            ["PipelineRadar/Agent", "cache_creation_tokens", "Outcome", "ok"],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 6, width = 8, height = 6,
        properties = {
          title   = "Time to first token (ms)", region = var.region, stat = "Average", period = 300,
          metrics = [["PipelineRadar/Agent", "ttft_ms", "Outcome", "ok"]]
        }
      },
    ]
  })
}
