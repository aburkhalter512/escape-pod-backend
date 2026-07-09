# --- non-secret, sensible defaults ---

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-west-2"
}

variable "domain_name" {
  description = <<-EOT
    Custom domain for the backend's ALB (e.g. "api.example.com"). Leave
    empty (the default) until a domain is actually registered — when
    empty, this config skips creating the ACM cert, Route53 record, and
    HTTPS listener entirely, and the ALB serves HTTP only. Re-apply with
    this set once a domain + route53_zone_id exist to add HTTPS with no
    other resource changes.
  EOT
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Hosted zone ID to create the domain_name record in. Required only when domain_name is set; this config does not create the zone itself (the domain's registrar NS records must already be delegated to it)."
  type        = string
  default     = ""
}

variable "ptp_base_url" {
  description = "Protect the Pod base URL. Not secret."
  type        = string
  default     = "https://www.protectthepod.com"
}

variable "container_image" {
  description = "Full ECR image URI+tag to deploy, e.g. \"<account>.dkr.ecr.<region>.amazonaws.com/escape-pod-backend:latest\". No default — the ECR repo this config creates starts empty; build and push an image before the ECS service can run one. This is the one variable a future CI pipeline would update per deploy, without touching anything else."
  type        = string
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of running tasks."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the ECS task's log group."
  type        = number
  default     = 14
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage, in GB."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Postgres database name."
  type        = string
  default     = "draft_pod"
}

variable "db_username" {
  description = "Postgres master username. Not secret by itself (the password is what's sensitive), but kept as a variable alongside it for symmetry."
  type        = string
  default     = "postgres"
}

# --- secrets: no defaults, supplied via TF_VAR_* env vars or a gitignored
# *.auto.tfvars at apply time, never hardcoded or committed ---

variable "db_password" {
  description = "RDS master password."
  type        = string
  sensitive   = true
}

variable "token_encryption_key" {
  description = "AES-256-GCM key (32-byte hex) for encrypting PTP tokens at rest. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  type        = string
  sensitive   = true
}

variable "bot_api_key" {
  description = "Shared secret discord-bot authenticates with. Must match the backend_api_key value supplied to escape-pod's (discord-bot's) infra apply."
  type        = string
  sensitive   = true
}
