# S3 backend config — cannot reference variables (evaluated before any
# variables are available), so these values are pasted in by hand from
# bootstrap/'s outputs after running `tofu apply` there once. See README.md.
terraform {
  backend "s3" {
    bucket         = "escape-pod-backend-tfstate-REPLACE_WITH_ACCOUNT_ID"
    key            = "backend/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "escape-pod-backend-tfstate-lock"
    encrypt        = true
  }
}
