CREATE TABLE probe_artifacts (
  probe_id text NOT NULL,
  version text NOT NULL,
  payload text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (probe_id, version)
);
