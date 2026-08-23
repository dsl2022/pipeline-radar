# The ALB listens on plain HTTP, but its security group only admits traffic
# from CloudFront's origin-facing managed prefix list - so the only route to
# it is through the distribution.

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb"
  description = "ALB - reachable only from CloudFront origin-facing ranges"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "CloudFront origin-facing only"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [var.cloudfront_prefix_list_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "task" {
  name        = "${var.project}-task"
  description = "Fargate task - only the ALB may reach the container port"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "ALB to container"
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "main" {
  name               = "${var.project}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # Default is 60s, which would drop a chat stream mid-turn: the agent's
  # per-turn budget is 120s. Sized above that with margin.
  idle_timeout = 240
}

resource "aws_lb_target_group" "api" {
  name        = "${var.project}-api"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # Must exceed the maximum chat turn (120s), not merely beat the old 10s
  # default. During a deploy the target drains for exactly this long before
  # ECS stops the container; anything under the turn bound cuts an in-flight
  # SSE stream at that mark. 120 + 30s margin.
  deregistration_delay = 150

  health_check {
    path                = "/healthz"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
