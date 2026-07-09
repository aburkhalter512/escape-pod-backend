# backend infrastructure

OpenTofu (Terraform-compatible) configuration for running escape-pod-backend
on AWS: a VPC (no NAT gateway — cost-minimization decision, see
`network.tf`), an ECS Fargate service behind an ALB, RDS Postgres
(single-AZ `db.t4g.micro`), an ECR repo, and SSM Parameter Store for
secrets. Fully independent from escape-pod's (discord-bot's) own
`infra/` — no shared VPC, no shared ECS cluster, no cross-repo Terraform
state. The two services talk to each other over the public internet via
this stack's ALB URL, the same bearer-token trust model (`BOT_API_KEY`)
they already use locally.

Nothing here has been applied yet — this is infrastructure-as-code
waiting for AWS credentials and a decision on the remaining manual steps
below.

## Prerequisites

- The [OpenTofu CLI](https://opentofu.org) (`brew install opentofu`) —
  not the same binary as `terraform`, don't mix the two against the same
  state.
- AWS credentials configured (`aws configure`, or an SSO profile) with
  permission to create the resources below.
- An image already built and pushed to the ECR repo this config creates
  — see "First apply" below for the chicken-and-egg here.

## First-time setup (two steps, in order)

### 1. Bootstrap the state backend (once, manually, local state)

```bash
cd bootstrap
tofu init
tofu apply
```

This creates an S3 bucket (versioned, encrypted, public access blocked)
and a DynamoDB table for state locking. Copy the two output values into
`../backend.tf`'s `backend "s3" {}` block (`bucket` and
`dynamodb_table`), replacing the placeholder values there.

Don't rename these later without also running `tofu init -migrate-state`
or `-reconfigure` on the main config — that's a manual, deliberate
operation, not something to do casually.

### 2. Initialize and apply the main config

```bash
cd ..   # back to infra/
tofu init
```

Supply the required variables — either export `TF_VAR_*` env vars, or
create a gitignored `terraform.auto.tfvars`:

```hcl
container_image      = "<account-id>.dkr.ecr.us-west-2.amazonaws.com/escape-pod-backend:latest"
db_password           = "..."   # generate a strong random value
token_encryption_key   = "..."  # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
bot_api_key             = "..."  # shared secret — must match discord-bot's backend_api_key
```

`container_image` has no default because the ECR repo this config
creates starts empty. **First apply will succeed at creating all the
infrastructure, but the ECS service won't have a healthy running task
until an image actually exists at that URI** — that's expected, not a
bug. Build and push one after the first apply creates the ECR repo:

```bash
docker build -t <account-id>.dkr.ecr.us-west-2.amazonaws.com/escape-pod-backend:latest ..
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-west-2.amazonaws.com
docker push <account-id>.dkr.ecr.us-west-2.amazonaws.com/escape-pod-backend:latest
```

Then:

```bash
tofu plan
tofu apply
```

## Adding HTTPS later

Once a domain is registered and its hosted zone exists in Route53 (this
config does not create the zone itself — only records within one that
already exists and is delegated), set `domain_name` and
`route53_zone_id` and re-apply. This adds the ACM cert (DNS-validated),
the Route53 A record, and the HTTPS listener — no other resources
change. Until then, the backend is reachable only over plain HTTP at the
ALB's default `*.elb.amazonaws.com` hostname (`alb_dns_name` output).

## Feeding this into discord-bot's infra

After applying, `tofu output alb_dns_name` (or `alb_https_url` once a
domain exists) is what gets supplied as `TF_VAR_backend_url` when
applying escape-pod's (discord-bot's) own `infra/` — **this stack must
be applied first**. There's no automatic wiring between the two repos'
Terraform state by design (see the project's per-repo infra ownership
decision); it's a manual copy-paste step. The `bot_api_key` value
supplied here must also match the `backend_api_key` value supplied to
discord-bot's apply — generate the shared secret once, use it in both
places.
