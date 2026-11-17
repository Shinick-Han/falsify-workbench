-- Owner-paid hosted AI policy (contract docs/hosted-ai-contract-20261117.md).
-- Provider usage is recorded once, when a job is first observed terminal, so the pre-flight token
-- budget can sum the current window. These columns are recorded usage only: no estimated tokens are
-- reserved for in-flight jobs, and the budget is a policy gate, not an exact provider balance.
ALTER TABLE ai_jobs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_jobs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_jobs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_jobs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
-- First terminal observation; NULL until a terminal snapshot was read. Window comparisons use it.
ALTER TABLE ai_jobs ADD COLUMN usage_recorded_at TEXT;

CREATE INDEX ai_jobs_owner_usage_recorded ON ai_jobs (owner_id, usage_recorded_at);
