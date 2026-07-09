output "alb_dns_name" {
  description = "ALB's default hostname — always available. This is escape-pod's (discord-bot's) BACKEND_URL input until a domain exists."
  value       = aws_lb.this.dns_name
}

output "alb_https_url" {
  description = "https://<domain_name>, once one is set — null otherwise."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : null
}

output "ecr_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "rds_endpoint" {
  description = "Hostname:port — not a credential, safe to output plainly."
  value       = aws_db_instance.postgres.endpoint
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.backend.name
}
