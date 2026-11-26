CREATE TABLE tenants (id text PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true, bundle_version integer NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE agents (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, active boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,id));
--> statement-breakpoint
CREATE TABLE policies (tenant_id text NOT NULL REFERENCES tenants(id), agent_id text NOT NULL, version integer NOT NULL CHECK(version>0), active boolean NOT NULL DEFAULT true, body jsonb NOT NULL, PRIMARY KEY(tenant_id,agent_id), FOREIGN KEY(tenant_id,agent_id) REFERENCES agents(tenant_id,id));
--> statement-breakpoint
CREATE TABLE revocations (tenant_id text NOT NULL REFERENCES tenants(id), jti text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,jti));
--> statement-breakpoint
CREATE TABLE telemetry (tenant_id text NOT NULL REFERENCES tenants(id), deployment_id text NOT NULL, window_start timestamptz NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,deployment_id,window_start));
