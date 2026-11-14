NPM  ?= npm
NPX  ?= npx
PORT ?= 8084

DEV_SALT ?= air-tools-gateway-dev-salt

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@echo "air-tools-gateway — make <target>"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Overridable: PORT=$(PORT)"

.PHONY: node-check
node-check:
	@command -v node >/dev/null 2>&1 || { echo "node not found: install Node 22 LTS (brew install node@22)."; exit 1; }
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
