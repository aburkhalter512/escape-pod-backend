# SSM Parameter Store (SecureString), not Secrets Manager — standard-tier
# parameters are free; Secrets Manager charges $0.40/secret/month for
# rotation/cross-account features this design doesn't use. Both are
# natively supported by aws_ecs_task_definition's `secrets` block, so
# nothing is given up by choosing the free option. Encrypted with the
# AWS-managed alias/aws/ssm key by default, at no extra cost.
#
# Referenced by the task definition's `secrets` block (valueFrom = ARN)
# in ecs.tf — never in the plaintext `environment` block, never logged.

resource "aws_ssm_parameter" "database_url" {
  name  = "/escape-pod-backend/DATABASE_URL"
  type  = "SecureString"
  value = "postgresql://${var.db_username}:${urlencode(var.db_password)}@${aws_db_instance.postgres.address}:5432/${var.db_name}"
}

resource "aws_ssm_parameter" "token_encryption_key" {
  name  = "/escape-pod-backend/TOKEN_ENCRYPTION_KEY"
  type  = "SecureString"
  value = var.token_encryption_key
}

resource "aws_ssm_parameter" "bot_api_key" {
  name  = "/escape-pod-backend/BOT_API_KEY"
  type  = "SecureString"
  value = var.bot_api_key
}
