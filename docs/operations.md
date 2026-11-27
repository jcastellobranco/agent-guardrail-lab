# Operations

## Running without Docker

```bash
corepack enable && corepack prepare pnpm@10.12.4 --activate
make setup   # pnpm install + local dev keys and an unsigned demo bundle
make dev     # builds once, then watches the compiled server
make demo    # in another terminal
```

This mode uses an unsigned local policy fixture, which the guardrail rejects when `NODE_ENV=production`. `pnpm keys` regenerates dev keys and the demo bundle; restart the API after changing them. Never commit `.dev-keys`, tokens, traces or credentials.

Standalone Python: `make inference-setup`, `make inference-test`, `make inference-train`, `make inference-serve`. See the [inference service README](../apps/inference-service/README.md).

## Control plane, sync and credentials

- Admin endpoints use a dedicated high-entropy bearer credential. Sync endpoints use a credential scoped to one tenant. The server refuses to start with short or reused credentials.
- Deletion is deactivation: tenants, agents and policies are disabled, never removed, and policy versions must strictly increase, so a deleted policy cannot come back at an older version.
- Bundle and JWT signing keys are separate. The sync agent pulls over HTTPS, verifies the Ed25519 signature over the exact serialized bytes, and rejects unknown keys, cross-tenant bundles, expired bundles and non-increasing versions. The guardrail verifies again when it loads the file.
- The last valid snapshot survives restarts on a persistent volume. A compromised filesystem can still roll back the whole volume. Freshness is based on issue time, not load time. While the control plane is unreachable, the cached snapshot is used until `MAX_POLICY_AGE_MS` or expiry, then the per-policy fail mode applies.
- `/health/ready` reports freshness. `/health/serving` reports only whether a snapshot is loaded, so a stale data plane keeps receiving traffic and answers with explicit `STALE_POLICY` decisions.

## Database migrations

Control-plane migrations use Drizzle: `pnpm --filter @lab/database migrate` with `DATABASE_URL`. Migrations are append-only and replay-safe; CI applies them twice.

The `display_name` migration shows expand/contract. The active expand step adds the column and backfills it, and the API writes both columns. The contract step (`packages/database/examples/contract_after_cutover.sql`) is deliberately not in the journal. Run it in a later release, after every reader and writer has switched and a final backfill has run.

The local audit database is initialized from `packages/local-audit/sql/001_queue.sql`. The audit worker's LISTEN connection must be direct or session-pooled, never transaction-pooled (see [ADR 0013](adr/0013-listen-notify-wakeup.md)).

### PostgreSQL tests

CI starts PostgreSQL 17, applies migrations twice, and runs every `*database*` suite (control plane, rollouts, artifacts, audit worker) with `REQUIRE_DATABASE_TESTS=1`, so a missing database fails the build instead of skipping silently. Locally:

```bash
docker run -d --rm --name lab-pg -e POSTGRES_USER=lab -e POSTGRES_PASSWORD=lab \
  -e POSTGRES_DB=lab_test -p 127.0.0.1:55432:5432 postgres:17-alpine
export DATABASE_URL=postgresql://lab:lab@127.0.0.1:55432/lab_test TEST_DATABASE_URL=$DATABASE_URL
export REQUIRE_DATABASE_TESTS=1
pnpm --filter @lab/control-plane... --filter @lab/local-audit... build
pnpm --filter @lab/database migrate
pnpm --filter @lab/control-plane exec vitest run database
pnpm --filter @lab/local-audit exec vitest run tests/worker.database.test.ts
```

### Neon branches for pull requests

The `neon.yml` workflow creates a schema-only Neon branch per PR, creates a fresh database per run (the role needs `CREATEDB`), migrates and tests, and deletes the branch when the PR closes. Use an isolated Neon project. Without the `NEON_API_KEY` and `NEON_PROJECT_ID` secrets, the workflow skips.

## Kubernetes (Helm)

The `data-plane` chart deploys one tenant's pod: guardrail, sync agent, audit worker, telemetry exporter, and an optional inference sidecar.

You provide:
- a Secret with the public verification keys (`jwt.pem`, `bundle.pem`), the `sync-token` and the `local-audit-database-url`;
- a persistent audit database initialized with `001_queue.sql`;
- optionally, artifact and model-cache PVCs. With `inference.syncArtifacts=true`, the sync agent fills the artifact PVC with signed artifacts (see [probe rollout](probe-rollout.md)).

No private signing key ever belongs in the data plane.

```bash
helm lint infrastructure/helm/data-plane
helm template lab infrastructure/helm/data-plane --set inference.enabled=true
helm upgrade --install lab infrastructure/helm/data-plane
```

Before real use, add NetworkPolicies (required for proxy-mode enforcement), separate service identities, TLS/mTLS, a secret manager, storage encryption and backups.

## Releases

Tags like `v0.6.0` build images, push them to GHCR, and sign them by digest with keyless Cosign. Use protected tags and required CI checks.

CI runs format, lint, typecheck, tests and build; Python ruff and pytest; real candidate-probe training with an FPR regression gate against the PR base (it rejects incomparable metadata and regressions above 5 percentage points); image builds; the Compose integration suite; and Helm lint and render.

## Dependency maintenance

Use Node 22 and pnpm 10.12.4. Normal installs use `pnpm install --frozen-lockfile`. After changing a manifest on purpose, run `pnpm install` and commit `pnpm-lock.yaml`.

The Python lock targets Linux x86-64, Python 3.12 and CPU PyTorch. To regenerate it in a fresh virtual environment:
1. Install `torch==2.10.0` from `https://download.pytorch.org/whl/cpu`.
2. Install `apps/inference-service/requirements.txt`.
3. Run `pip freeze > apps/inference-service/requirements.lock.txt`, then `pip check`.

It is a version lock, not a hash-verified or cross-platform one.
