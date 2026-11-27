-- Deliberately not in the active migration journal. Deploy readers using display_name,
-- drain old writers, backfill again, enforce NOT NULL, then deploy contract release.
UPDATE tenants SET display_name=name WHERE display_name IS NULL;
ALTER TABLE tenants ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE tenants DROP COLUMN name;
