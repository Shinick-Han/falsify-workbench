-- Open guest sessions (CONTRACT-W17). Only the SHA-256 of the bearer is stored.
-- guest_id is the uuid in the hosted owner id gst:<uuid>. Times are unix milliseconds.
-- revoked_at is set by an operator update; there is no public revoke route.
CREATE TABLE guest_sessions (
  token_hash TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX guest_sessions_expires ON guest_sessions (expires_at);
