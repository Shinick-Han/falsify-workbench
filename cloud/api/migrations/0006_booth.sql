-- Booth submissions (contract docs/booth-contract-20261120.md).
-- No IP address, user agent or token is stored. owner_id is the hosted owner and is never returned.
CREATE TABLE booth_submissions (
  id TEXT PRIMARY KEY,                 -- uuid
  seq INTEGER NOT NULL UNIQUE,         -- 1, 2, 3 ...
  receipt TEXT NOT NULL UNIQUE,        -- 'F-' || printf('%04d', seq)
  claim_hash TEXT NOT NULL,            -- sha256hex('booth-claim:v1:' || receipt || ':' || normalizedKey)
  owner_id TEXT NOT NULL,              -- submitting owner; never returned by any route
  job_id TEXT NOT NULL UNIQUE,         -- guest RED applyOnly job
  artifact_id TEXT NOT NULL,           -- that job's edited.pdf artifact
  course TEXT NOT NULL CHECK (course IN ('quick', 'deep')),
  nickname TEXT,
  declared TEXT NOT NULL,              -- JSON array, see 5.3
  paper TEXT,                          -- JSON object or NULL
  consent_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'reviewing', 'judged', 'invalid', 'withdrawn')),
  outcome TEXT CHECK (outcome IN ('missed', 'caught', 'partial', 'invalid')),
  operator_note TEXT,
  public_note TEXT,
  prize_message TEXT,
  ai_summary TEXT,                     -- operator JSON, <= 16 KiB, never shown to visitors
  published_at TEXT,
  created_at TEXT NOT NULL,            -- ISO 8601 UTC
  updated_at TEXT NOT NULL
);
CREATE INDEX booth_submissions_owner ON booth_submissions (owner_id, created_at);
CREATE INDEX booth_submissions_status ON booth_submissions (status, seq);
CREATE TABLE booth_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
