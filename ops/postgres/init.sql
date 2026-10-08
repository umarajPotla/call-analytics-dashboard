-- Read-only role for Grafana's SQL dashboard. Tables are created later by the API's migrations (as postgres),
-- so grant SELECT on future tables too. Local demo credentials only.
CREATE ROLE grafana_reader LOGIN PASSWORD 'grafana_reader';
GRANT CONNECT ON DATABASE calls TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO grafana_reader;
