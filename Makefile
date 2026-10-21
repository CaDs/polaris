# Polaris: the day-to-day commands. `make` or `make help` lists them.
# Node 26+, git and a running Docker are the requirements (`make doctor` checks).

-include .env
export

PORT ?= 3000
WEB_PORT ?= 5173
E2E_PORT ?= 3200

.PHONY: help setup doctor dev start build test e2e e2e/headed typecheck check db/reset clean

help: ## Show this help
	@awk 'BEGIN { FS = " ## " } /^## group:/ { g = $$0; sub(/^## group: */, "", g); printf "\n\033[1;33m%s\033[0m\n", toupper(g); next } / ## / && /^[a-zA-Z0-9\/]+:/ { t = $$1; sub(/:.*/, "", t); printf "  \033[36m%-16s\033[0m %s\n", t, $$2 }' $(MAKEFILE_LIST)

## group: setup

setup: ## First-time setup: npm ci, a .env with fresh secrets (an existing .env is kept)
	npm ci
	@if [ ! -f .env ]; then \
	  sed -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$$(openssl rand -hex 32)|" \
	      -e "s|^POLARIS_SECRET_KEY=.*|POLARIS_SECRET_KEY=$$(openssl rand -hex 32)|" .env.example > .env; \
	  echo "wrote .env with new secrets (keep POLARIS_SECRET_KEY: it encrypts stored provider keys)"; \
	else echo ".env exists, kept"; fi
	@$(MAKE) --no-print-directory doctor

doctor: ## Check Node 26+, git, Docker running, Ollama reachable
	@node -e 'const [m]=process.versions.node.split("."); if (m<26) { console.error("Node 26+ required, found", process.version); process.exit(1) } console.log("node", process.version)'
	@git --version
	@docker info >/dev/null 2>&1 && echo "docker running" || echo "docker NOT running: start Docker Desktop (runs need the sandbox)"
	@curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && echo "ollama reachable on :11434" || echo "ollama not reachable (fine if you use Anthropic/OpenAI)"

## group: run

dev: ## API on :3000 with reload + Vite dashboard on :5173 (PORT/WEB_PORT override)
	BETTER_AUTH_URL=http://localhost:$(PORT) WEB_ORIGIN=http://localhost:$(WEB_PORT) npm run dev

build: ## Build the dashboard into dist/
	npm run build

start: build ## Single process: build, then serve everything on :3000
	BETTER_AUTH_URL=http://localhost:$(PORT) WEB_ORIGIN=http://localhost:$(PORT) npm start

## group: check

typecheck: ## tsc over server, web and tests
	npm run typecheck

test: ## Unit and API tests (in-memory DB, host sandbox)
	npm test

e2e: ## Playwright end to end, headless, real Docker sandbox, fake model
	E2E_PORT=$(E2E_PORT) npm run e2e

e2e/headed: ## Same, with a visible browser in slow motion
	E2E_PORT=$(E2E_PORT) npm run e2e:headed

check: typecheck test ## typecheck + unit tests

## group: data

db/reset: ## Delete the local database and run data (asks first)
	@read -p "Delete $${DB_PATH:-polaris.db} and $${POLARIS_DATA_DIR:-data}/? [y/N] " a && [ "$$a" = y ] || exit 1
	rm -rf "$${DB_PATH:-polaris.db}" "$${POLARIS_DATA_DIR:-data}"

clean: ## Remove build output and test artifacts
	rm -rf dist test-results playwright-report
