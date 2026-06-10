# 4D Call Chain — common build tasks.
# Run `make` (or `make help`) to list targets.

VERSION  := $(shell node -p "require('./packages/vscode-client/package.json').version")
VSIX     := packages/vscode-client/vscode-4d-callchain-$(VERSION).vsix
VSIX_FULL := packages/vscode-client/vscode-4d-callchain-$(VERSION)-full.vsix

.DEFAULT_GOAL := help
.PHONY: help install core bundle vsix vsix-full package install-ext build watch test clean \
	bump bump-patch bump-minor bump-major

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install npm dependencies (first-time setup)
	npm install

core: ## Build the deps the .vsix bundle needs (parser wasm + @4d/core)
	npm run build:parser
	npm run build -w @4d/core

bundle: ## Bundle the extension only (esbuild) — dist/extension.js + wasm
	npm run esbuild -w vscode-4d-callchain

vsix: core ## Build the Call-Chain-only .vsix deliverable (cedes 4D syntax to 4D.4d-analyzer)
	npm run package -w vscode-4d-callchain
	@echo "→ $(VSIX)"

vsix-full: core ## Build the standalone .vsix that bundles its own 4D grammar/themes (no analyzer dep)
	npm run package:full -w vscode-4d-callchain
	@echo "→ $(VSIX_FULL)"

package: vsix ## Alias for `vsix`

install-ext: vsix ## Build the .vsix and install it into VS Code
	code --install-extension $(VSIX)

build: ## Full workspace build (all packages, incl. both LSP servers)
	npm run build

watch: ## Rebuild the extension bundle on change (esbuild watch)
	npm run watch -w vscode-4d-callchain

test: ## Run the test suite
	npm test

clean: ## Remove build output and the packaged .vsix
	rm -rf packages/vscode-client/dist
	rm -f packages/vscode-client/*.vsix

bump: ## Bump version in every file that records it (PART=major|minor|patch, default patch)
	node scripts/bump-version.mjs $(PART)

bump-patch: ## Bump the patch version (0.1.18 -> 0.1.19)
	node scripts/bump-version.mjs patch

bump-minor: ## Bump the minor version (0.1.18 -> 0.2.0)
	node scripts/bump-version.mjs minor

bump-major: ## Bump the major version (0.1.18 -> 1.0.0)
	node scripts/bump-version.mjs major
