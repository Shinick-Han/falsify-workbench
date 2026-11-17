-- Hosted AI execution index (contract docs/hosted-ai-contract-20261117.md).
-- This is a durable index only: it stores upload metadata and job snapshots, never the uploaded
-- bytes, the review prompt, provider keys or provider response text. Owner IDs are the stable
-- hosted identities composed in ai-identity.mjs (usr:<author uuid> or atl:<sha256(cloudId:accountId)>);
-- they are deliberately not foreign keys to authors, because a Confluence owner has no author row.
CREATE TABLE ai_uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('application/pdf', 'application/octet-stream', 'text/plain')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  -- Runtime-side content-addressed upload id. The gateway id above is the public handle.
  runtime_upload_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per owner and content hash: a repeated upload reuses the first row.
CREATE UNIQUE INDEX ai_uploads_owner_sha ON ai_uploads (owner_id, sha256);
CREATE INDEX ai_uploads_owner_created ON ai_uploads (owner_id, created_at);

CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('red', 'blue')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted')),
  -- Sanitized snapshot without the result body and without the prompt.
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- The idempotency key is scoped to one owner; a replay never invokes the runtime again.
CREATE UNIQUE INDEX ai_jobs_owner_idempotency ON ai_jobs (owner_id, idempotency_key);
CREATE INDEX ai_jobs_owner_state ON ai_jobs (owner_id, state);
CREATE INDEX ai_jobs_owner_created ON ai_jobs (owner_id, created_at);
CREATE INDEX ai_jobs_upload ON ai_jobs (upload_id);
