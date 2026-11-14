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

.PHONY: clean
clean: ## Remove build output
	rm -rf dist coverage
