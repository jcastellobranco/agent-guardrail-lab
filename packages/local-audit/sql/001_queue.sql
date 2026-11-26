CREATE TABLE IF NOT EXISTS audit_queue(decision_id uuid PRIMARY KEY,event jsonb NOT NULL,attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_queue_available ON audit_queue(available_at);
CREATE TABLE IF NOT EXISTS audit_records(decision_id uuid PRIMARY KEY,tenant_id text NOT NULL,event jsonb NOT NULL,processed_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS audit_records_window ON audit_records(tenant_id,processed_at,decision_id);
CREATE TABLE IF NOT EXISTS audit_dead_letter(decision_id uuid PRIMARY KEY,event jsonb NOT NULL,attempts integer NOT NULL,failed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS telemetry_cursor(tenant_id text NOT NULL,deployment_id text NOT NULL,next_window timestamptz NOT NULL,PRIMARY KEY(tenant_id,deployment_id));
