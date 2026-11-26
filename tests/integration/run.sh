#!/usr/bin/env bash
set -euo pipefail
export INFERENCE_URL=http://inference-mock:8001 MAX_POLICY_AGE_MS=15000 SYNC_INTERVAL_MS=2000 LATENCY_BUDGET_MS=100
# Isolate test volumes from the developer stack.
export COMPOSE_PROJECT_NAME=guardrail-integration
cleanup(){ status=$?; if [[ $status -ne 0 ]]; then docker compose --profile test logs --tail=100 || true; fi; docker compose --profile test down -v || true; exit "$status"; }
trap cleanup EXIT
docker compose --profile test up -d --build
docker compose --profile test up -d --wait guardrail-api
node tests/integration/compose.mjs
