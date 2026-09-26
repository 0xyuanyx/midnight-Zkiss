ALTER TABLE ai_jobs ADD COLUMN model_version text;
ALTER TABLE ai_jobs ADD COLUMN service_cleaned_at timestamptz;
