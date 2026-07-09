# All resources here are conditional on var.domain_name being set — see
# variables.tf. Until then, the backend is reachable only over plain
# HTTP at the ALB's default *.elb.amazonaws.com hostname (alb.tf's
# always-on HTTP listener). That's an accepted tradeoff for this
# service specifically (bearer-token auth is the existing trust model),
# unlike escape-pod (discord-bot), where Discord flatly requires a real
# domain + CA-signed HTTPS before its endpoint can be registered at all.

resource "aws_acm_certificate" "this" {
  count = var.domain_name != "" ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# for_each (not count) because domain_validation_options is a genuinely
# keyed collection — in principle more than one validation record if the
# cert ever covers additional SANs.
resource "aws_route53_record" "acm_validation" {
  for_each = var.domain_name != "" ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "this" {
  count = var.domain_name != "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
