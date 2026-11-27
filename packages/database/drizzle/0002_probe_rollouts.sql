CREATE TABLE probe_rollouts (
  tenant_id text NOT NULL REFERENCES tenants(id),
  probe_id text NOT NULL,
  stable_version text NOT NULL,
  canary_version text NOT NULL,
  flag_threshold double precision NOT NULL,
  block_threshold double precision NOT NULL,
  percent integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
  max_block_rate_increase double precision NOT NULL CHECK (max_block_rate_increase BETWEEN 0 AND 1),
  min_samples integer NOT NULL CHECK (min_samples > 0),
  status text NOT NULL CHECK (status IN ('active', 'rolled_back', 'promoted', 'aborted')),
  reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, probe_id),
  CHECK (stable_version <> canary_version),
  CHECK (flag_threshold >= 0 AND flag_threshold < block_threshold AND block_threshold <= 1)
);
