ALTER TABLE dragon_config_versions ADD COLUMN origin text NOT NULL DEFAULT 'LEGACY';
ALTER TABLE dragon_config_versions ADD COLUMN validation_mode text NOT NULL DEFAULT 'RESEARCH_REQUIRED';
ALTER TABLE dragon_config_versions ADD COLUMN replaces_id text;
ALTER TABLE dragon_config_versions ADD COLUMN provenance_digest text;
