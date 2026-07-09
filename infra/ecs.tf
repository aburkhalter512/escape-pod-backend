resource "aws_ecs_cluster" "this" {
  name = "escape-pod-backend"
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/escape-pod-backend"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "escape-pod-backend"
  requires_compatibilities = ["FARGATE"]
  # Fargate only supports awsvpc networking (no bridge/host) — each task
  # gets its own ENI, which is also why the ALB target group below must
  # use target_type = "ip" rather than "instance".
  network_mode = "awsvpc"
  cpu          = var.task_cpu
  memory       = var.task_memory

  execution_role_arn = aws_iam_role.ecs_execution.arn
  # No task_role_arn — see iam.tf.

  container_definitions = jsonencode([
    {
      name  = "backend"
      image = var.container_image

      portMappings = [
        { containerPort = 3001, protocol = "tcp" }
      ]

      environment = [
        { name = "PORT", value = "3001" },
        { name = "PTP_BASE_URL", value = var.ptp_base_url },
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
        { name = "TOKEN_ENCRYPTION_KEY", valueFrom = aws_ssm_parameter.token_encryption_key.arn },
        { name = "BOT_API_KEY", valueFrom = aws_ssm_parameter.bot_api_key.arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "backend"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "backend" {
  name            = "escape-pod-backend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets = aws_subnet.public[*].id
    # Mandatory here: with no NAT gateway, a Fargate task needs a public
    # IP to reach ECR/CloudWatch/SSM at all — otherwise the image pull
    # hangs and the task never reaches RUNNING.
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 3001
  }

  health_check_grace_period_seconds = 30

  depends_on = [aws_lb_listener.http]
}
