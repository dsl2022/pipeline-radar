# One 0.25 vCPU Fargate task. The image is built and pushed by CI before
# apply runs; var.image_tag is the commit SHA.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  image = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/${var.project}-api:${var.image_tag}"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.project}-api"
  retention_in_days = 7
}

resource "aws_ecs_cluster" "main" {
  name = "${var.project}-cluster"
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # SSE connections are long-lived and pinned to whichever task accepted
  # them, so chat traffic sits on top of proxy traffic rather than
  # replacing it. 0.25 vCPU was sized for a stateless cache proxy.
  cpu                = 512
  memory             = 1024
  execution_role_arn = aws_iam_role.execution.arn

  # The container's own identity (DynamoDB counters). Distinct from the
  # execution role, which only pulls the image and resolves secrets.
  task_role_arn = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name         = "api"
    image        = local.image
    essential    = true
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]

    # Draining (deregistration_delay, 150s) happens first; this is the window
    # the container gets after SIGTERM to close any stream that survived it.
    # Defaults to 30s, which would SIGKILL mid-turn. 120s is the Fargate
    # maximum and matches the turn bound.
    stopTimeout = 120

    environment = [
      { name = "AGENT_TABLE", value = aws_dynamodb_table.agent.name },
      # Origins allowed to POST to the agent, for the cross-site check.
      { name = "APP_ORIGIN", value = "https://${aws_cloudfront_distribution.main.domain_name}" },
    ]

    # secrets, not environment: an env var shows up in
    # `aws ecs describe-task-definition` to anyone with read access. The ECS
    # agent resolves this at container start and injects it into the process.
    secrets = [
      { name = "ANTHROPIC_API_KEY", valueFrom = data.aws_secretsmanager_secret.anthropic.arn },
      { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${var.project}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  # Two tasks so a deploy or a task replacement does not take the agent
  # offline. Note this is what makes in-memory rate-limit counters wrong:
  # they must be shared (DynamoDB) - see MILESTONE-6-PLAN.md 6.3.
  desired_count = 2
  launch_type   = "FARGATE"

  # Public subnet + no NAT: the public IP is this task's outbound path.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }

  # Bad image -> auto rollback, no dead prod.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  depends_on = [aws_lb_listener.http]
}
