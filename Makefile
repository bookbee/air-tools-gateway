NPM     ?= npm
NPX     ?= npx
COMPOSE ?= docker compose
PORT    ?= 8084
BASE_URL ?= http://localhost:$(PORT)

DEV_SALT ?= air-tools-gateway-dev-salt
# Host runs read .env when present (make env), else the committed dev defaults.
ENV_FILE := $(if $(wildcard .env),.env,.env.example)
# The host port always wins over the env file's container port (Node's --env-file never
# overrides a variable that is already set).
HOST_ENV := AIR_TOOLS_GATEWAY__HTTP__PORT=$(PORT)

INFRA_DIR ?= ../air-infrastructure-service
NETWORK   := air-net

# Container runs only: `shared` (default) joins the platform's air-net and refuses to start
# without it; `none` runs on this project's own network.
INFRA ?= shared
ifeq ($(INFRA),shared)
COMPOSE_FILES := -f docker-compose.yml
UP_DEPS := infra-check
else ifeq ($(INFRA),none)
COMPOSE_FILES := -f docker-compose.yml -f docker-compose.standalone.yml
UP_DEPS :=
else
$(error INFRA must be `shared` or `none`, got `$(INFRA)`)
endif

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@echo "air-tools-gateway — make <target>"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Overridable: PORT=$(PORT) BASE_URL=$(BASE_URL) INFRA=$(INFRA) (shared|none)"

.PHONY: node-check
node-check:
	@command -v node >/dev/null 2>&1 || { echo "node not found: install Node 22 LTS (see README)."; exit 1; }
	@node -e 'const m=+process.versions.node.split(".")[0]; if (m<22) { console.error("Node 22+ required, found " + process.version); process.exit(1); }'

# ---- setup -----------------------------------------------------------------
.PHONY: install
install: node-check ## Install dependencies (npm ci when a lockfile exists)
	@if [ -f package-lock.json ]; then $(NPM) ci; else $(NPM) install; fi

.PHONY: env
env: ## Create .env from .env.example, if absent
	@if [ -f .env ]; then \
		echo ".env already exists — leaving it alone."; \
	else \
		cp .env.example .env; \
		echo "Wrote .env."; \
	fi

.PHONY: key
key: node-check ## Print a raw key and its digest: make key RAW=<raw> [SALT=<salt>] (no RAW generates one)
	@$(NPX) tsx scripts/hash-key.ts $(if $(RAW),--raw "$(RAW)") --salt "$(or $(SALT),$(DEV_SALT))"

# ---- run on the host ---------------------------------------------------------
.PHONY: dev
dev: node-check ## Watch mode on the host, :$(PORT) (reads .env, else .env.example)
	$(HOST_ENV) $(NPX) tsx watch --env-file=$(ENV_FILE) src/main.ts

.PHONY: build
build: node-check ## Compile TypeScript to dist/
	$(NPM) run build

.PHONY: run
run: build ## Run the compiled service on the host, :$(PORT)
	$(HOST_ENV) node --env-file=$(ENV_FILE) dist/src/main.js

.PHONY: run-sit
run-sit: node-check ## SIT: host, fixture mode, dev keys, :$(PORT) (restart to reset the fixture)
	$(HOST_ENV) AIR_TOOLS_GATEWAY__BACKEND__MODE=fixture AIR_TOOLS_GATEWAY__BACKEND__FIXTURE_DIR=fixtures \
		$(NPX) tsx --env-file=.env.example src/main.ts

# ---- quality ---------------------------------------------------------------
.PHONY: lint
lint: node-check ## eslint and prettier --check
	$(NPM) run lint

.PHONY: format
format: node-check ## prettier --write and eslint --fix
	$(NPM) run format

.PHONY: typecheck
typecheck: node-check ## tsc --noEmit over src, scripts and test
	$(NPM) run typecheck

.PHONY: test
test: node-check ## Run the vitest suite
	$(NPM) test

.PHONY: check
check: lint typecheck test ## lint, typecheck and test: must pass before work is done

# Redis-backed stores against a throwaway Redis (never the shared one on air-net): starts
# redis:7-alpine on a random loopback port, runs the whole suite with it, removes it.
REDIS_IMAGE ?= redis:7-alpine
TEST_REDIS  := airtg-test-redis-$(shell echo $$PPID)

.PHONY: test-redis
test-redis: node-check ## Run the tests with the Redis suites too, against a throwaway container
	@docker run -d --rm --name $(TEST_REDIS) -p 127.0.0.1::6379 $(REDIS_IMAGE) >/dev/null
	@port=$$(docker port $(TEST_REDIS) 6379/tcp | head -1 | sed 's/.*://'); \
	for i in $$(seq 1 30); do docker exec $(TEST_REDIS) redis-cli ping >/dev/null 2>&1 && break; sleep 0.2; done; \
	AIR_TOOLS_GATEWAY_TEST_REDIS_URL=redis://127.0.0.1:$$port/0 $(NPM) test; \
	status=$$?; docker rm -f $(TEST_REDIS) >/dev/null; exit $$status

# No host Node? Run the same checks in node:22-slim; node_modules lives in a Docker volume
# so Linux binaries never land in the working tree.
NODE_IMAGE ?= node:22-slim
DOCKER_NODE = docker run --rm -v "$(CURDIR)":/app -v airtg_node_modules:/app/node_modules -w /app $(NODE_IMAGE)

.PHONY: docker-check
docker-check: ## make check inside a Node 22 container (no host Node needed)
	$(DOCKER_NODE) sh -c 'npm ci --no-audit --no-fund && npm run lint && npm run typecheck && npm test'

# ---- container ---------------------------------------------------------------
.PHONY: infra-check
infra-check: ## Fail early if air-infra's shared network is not up
	@docker network inspect $(NETWORK) >/dev/null 2>&1 || { \
		echo "air-infra is not up: network '$(NETWORK)' does not exist."; \
		echo; \
		echo "    cd $(INFRA_DIR) && make up"; \
		echo; \
		echo "Or run this service on its own network:"; \
		echo; \
		echo "    make up INFRA=none"; \
		echo; \
		exit 1; }

.PHONY: up
up: $(UP_DEPS) ## Build and start in docker on air-net, :$(PORT) (INFRA=none: own network)
	$(COMPOSE) $(COMPOSE_FILES) up -d --build
	@$(MAKE) --no-print-directory status

.PHONY: status
status: ## Report the running service's liveness and readiness
	@printf 'air-tools-gateway: $(BASE_URL) (on air-net as http://air-tools-gateway:8080)\n'
	@for i in $$(seq 1 30); do curl -sf -m 1 -o /dev/null $(BASE_URL)/v1/health && break; sleep 1; done
	@code=$$(curl -s -o /dev/null -w '%{http_code}' $(BASE_URL)/v1/ready 2>/dev/null); \
	if [ "$$code" = "200" ]; then \
		printf 'ready:   yes\n'; \
	elif [ "$$code" = "503" ]; then \
		printf 'ready:   NO (503): curl -s $(BASE_URL)/v1/ready, then make logs\n'; \
	else \
		printf 'ready:   could not probe (curl said "%s"): try make logs\n' "$$code"; \
	fi

.PHONY: down
down: ## Stop and remove the container
	$(COMPOSE) $(COMPOSE_FILES) down --remove-orphans

.PHONY: logs
logs: ## Tail container logs
	$(COMPOSE) $(COMPOSE_FILES) logs -f air-tools-gateway

.PHONY: smoke
smoke: ## Walk the whole flow against BASE_URL (default :$(PORT)); cancels 55120, so restart to rerun
	BASE_URL=$(BASE_URL) bash sit/smoke.sh

.PHONY: load
load: node-check ## Load test BASE_URL: contention invariants and latency (N=, READS=, CONCURRENCY=, P95_MS=); restart to rerun
	BASE_URL=$(BASE_URL) $(if $(N),N=$(N)) $(if $(READS),READS=$(READS)) $(if $(CONCURRENCY),CONCURRENCY=$(CONCURRENCY)) $(if $(P95_MS),P95_MS=$(P95_MS)) \
		$(NPX) tsx scripts/load.ts

.PHONY: sit-joint
sit-joint: infra-check node-check ## Joint SIT on air-net: up, reach by name, smoke, orchestrator sit-tools, load, restart replay
	PORT=$(PORT) bash sit/joint.sh

# ---- image and deployment (UAT and production) ------------------------------
# This repository owns its Dockerfile and image. The Helm chart, the Terraform
# and the deployment scripts for every core service live in
# air-infrastructure-service (gke/), where DevOps keeps them. The targets below
# build and push the image here, then hand over to that repository, checked out
# next to this one (INFRA_DIR). Its docs/03-gke-runbook.md is the runbook.
#
#   DEPLOY_ENV        uat | prod
#   IMAGE_REPOSITORY  <region>-docker.pkg.dev/<project>/air/air-tools-gateway
#   IMAGE_TAG         defaults to this checkout's short commit
#   IMAGE_DIGEST      what CI should deploy: a digest can't be re-pointed
#   KUBE_CONTEXT      required by deploy / deploy-smoke; never defaulted, so a
#                     deploy can't land on whatever cluster happens to be current
#   GCP_PROJECT       the environment's project (Secret Manager)
#   KEYS_FILE         deploy-smoke only, optional: an env file of raw API keys,
#                     to add one authenticated call to the readiness checks
DEPLOY_ENV ?= uat
SERVICE    := air-tools-gateway
IMAGE_TAG  ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || echo dev)
INFRA_MAKE  = $(MAKE) --no-print-directory -C $(INFRA_DIR) SERVICE=$(SERVICE) DEPLOY_ENV=$(DEPLOY_ENV) \
	KUBE_CONTEXT="$(KUBE_CONTEXT)" GCP_PROJECT="$(GCP_PROJECT)" KEYS_FILE="$(KEYS_FILE)" \
	IMAGE_REPOSITORY="$(IMAGE_REPOSITORY)" IMAGE_DIGEST="$(IMAGE_DIGEST)" \
	IMAGE_TAG="$(if $(IMAGE_DIGEST),,$(IMAGE_TAG))"

.PHONY: require-infra-repo
require-infra-repo:
	@test -f $(INFRA_DIR)/gke/scripts/release.sh || { \
		echo "air-infrastructure-service is not at $(INFRA_DIR): the charts and deploy scripts live there."; \
		echo "Check it out next to this repository, or pass INFRA_DIR=<path>."; exit 1; }

.PHONY: require-image-repository
require-image-repository:
	@test -n "$(IMAGE_REPOSITORY)" || { echo "set IMAGE_REPOSITORY, e.g. <region>-docker.pkg.dev/<project>/air/$(SERVICE)"; exit 1; }

.PHONY: image
image: ## Build the image locally as $(SERVICE):$(IMAGE_TAG)
	docker build -t $(SERVICE):$(IMAGE_TAG) .

.PHONY: image-push
image-push: require-image-repository ## Build for linux/amd64 and push IMAGE_REPOSITORY:IMAGE_TAG (gcloud auth configure-docker first)
	docker build --platform linux/amd64 -t $(IMAGE_REPOSITORY):$(IMAGE_TAG) .
	docker push $(IMAGE_REPOSITORY):$(IMAGE_TAG)

.PHONY: deploy-render
deploy-render: require-infra-repo ## Print the manifests DEPLOY_ENV would get (SAMPLE=1 fills the project placeholders)
	@$(INFRA_MAKE) SAMPLE="$(SAMPLE)" gke-render

.PHONY: deploy
deploy: require-infra-repo ## Deploy this service to DEPLOY_ENV (uat|prod) in KUBE_CONTEXT: helm upgrade --install
	@$(INFRA_MAKE) gke-deploy

.PHONY: deploy-smoke
deploy-smoke: require-infra-repo ## Smoke-test this service in KUBE_CONTEXT: rollout, health, readiness (KEYS_FILE adds a real call)
	@$(INFRA_MAKE) gke-smoke

.PHONY: clean
clean: ## Remove build output
	rm -rf dist coverage
