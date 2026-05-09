-- consent_templates.surface (v0.24.0). Distinguishes signing-flow templates
-- (the existing default) from portal-only informational resources (KAIR
-- pre/after/peer-resources docs introduced in v0.24.0). Existing rows
-- default to 'signature' so the consent flow keeps working unchanged.

ALTER TABLE consent_templates ADD COLUMN surface text NOT NULL DEFAULT 'signature';
