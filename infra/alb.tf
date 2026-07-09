resource "aws_lb" "this" {
  name               = "escape-pod-backend"
  internal           = false
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "backend" {
  name     = "escape-pod-backend"
  port     = 3001
  protocol = "HTTP"
  vpc_id   = aws_vpc.this.id
  # Mandatory for Fargate — target_type = "instance" is invalid since
  # there's no EC2 host to register, only per-task ENIs.
  target_type = "ip"

  health_check {
    path                = "/healthz"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# Always created — the bearer-token auth on every route (except
# /healthz) is the same trust model this already relies on locally, so
# HTTP-only is an accepted tradeoff until a domain exists for HTTPS.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

# Conditional — only created once var.domain_name is set (see dns_acm.tf).
resource "aws_lb_listener" "https" {
  count = var.domain_name != "" ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}
