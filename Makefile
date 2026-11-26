.PHONY: setup dev test lint typecheck build demo
setup:
	pnpm install
	pnpm keys
dev:
	pnpm dev
test:
	pnpm test
lint:
	pnpm lint
typecheck:
	pnpm typecheck
build:
	pnpm build
demo:
	pnpm demo

.PHONY: inference-setup inference-test inference-train inference-serve demo-probes
inference-setup:
	cd apps/inference-service && python3 -m venv .venv && .venv/bin/python -m pip install --upgrade pip && .venv/bin/python -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cpu && .venv/bin/python -m pip install -r requirements.txt
inference-test:
	cd apps/inference-service && .venv/bin/python -m pytest -q
inference-train:
	cd apps/inference-service && .venv/bin/python -m inference_lab.train
inference-serve:
	cd apps/inference-service && .venv/bin/python -m uvicorn inference_lab.api:app --host 127.0.0.1 --port 8001 --workers 1
demo-probes:
	pnpm demo:probes

.PHONY: up down compose-demo integration benchmark
up:
	docker compose up -d --build
down:
	docker compose down
compose-demo:
	node scripts/compose-demo.mjs demo
integration:
	bash tests/integration/run.sh
benchmark:
	node tests/load/benchmark.mjs
