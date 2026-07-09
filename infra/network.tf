# Dedicated VPC, fully independent from escape-pod's (discord-bot's) —
# no shared networking, per the project's per-repo infra ownership
# decision. The two services talk to each other over the public
# internet via this stack's ALB, not private VPC networking.
#
# No NAT gateway, no private subnets — cost-minimization decision.
# Fargate tasks run in public subnets with assign_public_ip = true
# (see ecs.tf) and security groups do the actual access control (see
# security_groups.tf); RDS sits in the same public subnets but is
# unreachable from the internet because its security group only accepts
# the ECS tasks' security group, and publicly_accessible = false means
# it never gets a public IP/DNS in the first place (see rds.tf).

resource "aws_vpc" "this" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "escape-pod-backend"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

# 2 subnets across 2 AZs — required even at desired_count = 1 because
# the ALB itself refuses to provision with fewer than 2 AZs, and RDS's
# subnet group has the same >=2-AZ requirement even for a single-AZ
# instance.
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.0.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "escape-pod-backend-public-${count.index}"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "escape-pod-backend"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "escape-pod-backend-public"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
