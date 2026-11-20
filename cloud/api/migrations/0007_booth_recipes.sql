-- Booth defect recipes (recipe contract v1 section 2). Drafts with no personal data and no IP.
-- Rows live 6 hours. The write path deletes expired rows before it inserts.
CREATE TABLE booth_recipes (
  code TEXT PRIMARY KEY,               -- 'R-' plus 6 Crockford base32 characters, uppercase
  recipe TEXT NOT NULL,                -- normalized falsify.booth.recipe.v1 JSON with source 'agent'
  created_at TEXT NOT NULL,            -- ISO 8601 UTC
  expires_at TEXT NOT NULL             -- ISO 8601 UTC, created_at plus 6 hours
);
CREATE INDEX booth_recipes_expires ON booth_recipes (expires_at);
-- How the defect was planted. NULL on rows from before this migration reads as 'manual'.
ALTER TABLE booth_submissions ADD COLUMN assist TEXT CHECK (assist IN ('manual', 'my-ai', 'agent'));
-- Recipe code the visitor loaded (assist 'agent' only). The recipe itself may already be gone.
ALTER TABLE booth_submissions ADD COLUMN recipe_code TEXT;
