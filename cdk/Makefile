.PHONY: init synth diff deploy destroy help

DOMAIN ?=
REGION ?=
HOST_PREFIX ?= litellm
MAX_AZS ?=

help:
	@echo "Usage:"
	@echo "  make init    DOMAIN=your.domain.com [REGION=us-east-1] [HOST_PREFIX=litellm] [MAX_AZS=2]"
	@echo "  make synth   — synthesize CloudFormation (runs init first)"
	@echo "  make diff    — show what would change (runs init first)"
	@echo "  make deploy  — full deploy (init + bootstrap + deploy)"
	@echo "  make destroy — tear down all stacks (via deploy.sh, with confirmation)"

init:
	@test -n "$(DOMAIN)" || (echo "Error: DOMAIN is required. Example: make init DOMAIN=example.com REGION=us-east-1"; exit 1)
	npx ts-node scripts/init-env.ts --domain $(DOMAIN) $(if $(REGION),--region $(REGION)) $(if $(filter-out litellm,$(HOST_PREFIX)),--host-prefix $(HOST_PREFIX)) $(if $(MAX_AZS),--max-azs $(MAX_AZS))
	cp cdk.context.local.json cdk.context.json

synth: init
	npx cdk synth

diff: init
	npx cdk diff

deploy:
	@test -n "$(DOMAIN)" || (echo "Error: DOMAIN is required. Example: make deploy DOMAIN=example.com REGION=ap-southeast-1"; exit 1)
	bash scripts/deploy.sh deploy-all --domain $(DOMAIN) $(if $(REGION),--region $(REGION)) $(if $(filter-out litellm,$(HOST_PREFIX)),--host-prefix $(HOST_PREFIX)) $(if $(MAX_AZS),--max-azs $(MAX_AZS))

destroy:
	bash scripts/deploy.sh destroy $(if $(REGION),--region $(REGION))
