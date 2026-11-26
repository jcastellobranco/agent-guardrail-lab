ALTER TABLE tenants ADD COLUMN display_name text;
--> statement-breakpoint
UPDATE tenants SET display_name=name WHERE display_name IS NULL;
