# Edge rate limiting. Requests blocked here never reach Fargate and never
# reach Anthropic, which makes this the cheapest layer in front of the agent -
# but also the coarsest. The application limits (MILESTONE-6-PLAN.md 6.3) are
# what enforce a per-caller policy; this sheds volume before it costs anything.
#
# CloudFront-scoped web ACLs must live in us-east-1, which this stack already
# is.

resource "aws_wafv2_web_acl" "main" {
  name        = "${var.project}-waf"
  description = "Rate limiting and managed rules for the agent endpoint"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Keyed on IP. The naive attack - a curl loop from one host - dies here.
  rule {
    name     = "agent-rate-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        # Well above the application's 20/min per IP, deliberately: this is a
        # volumetric backstop, not the policy. If it fires before the app
        # limit does, a shared corporate NAT gets blocked as one client.
        limit                 = 300
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/agent"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "agent-rate-per-ip"
      sampled_requests_enabled   = true
    }
  }

  # Keyed on the session cookie, so one client rotating through a proxy pool
  # is still bounded as long as it carries a cookie. Dropping the cookie to
  # evade this puts the caller back under the IP rule above, and under the
  # application's outright rejection of cookie-less requests.
  rule {
    name     = "agent-rate-per-session"
    priority = 2

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = 200
        evaluation_window_sec = 300
        aggregate_key_type    = "CUSTOM_KEYS"

        custom_key {
          cookie {
            name = "pr_sid"
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/api/agent"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "agent-rate-per-session"
      sampled_requests_enabled   = true
    }
  }

  # Deliberately COUNT, not BLOCK.
  #
  # The common rule set inspects request bodies for SQLi and XSS signatures,
  # and the agent's body is arbitrary user prose about drugs and trials. A
  # question containing "drop", quotes, or angle brackets is entirely normal
  # here and would be blocked as an attack - the classic false positive that
  # makes people disable WAF wholesale.
  #
  # Counting first means the CloudWatch metrics show what WOULD have been
  # blocked, against real traffic, before anything is. Promote to block once
  # the sampled requests show it is not eating legitimate questions.
  rule {
    name     = "managed-common"
    priority = 10

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "managed-common"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-waf"
    sampled_requests_enabled   = true
  }
}

output "waf_web_acl_arn" {
  value       = aws_wafv2_web_acl.main.arn
  description = "Attached to the CloudFront distribution"
}
