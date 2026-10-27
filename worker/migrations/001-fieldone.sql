-- Adds FieldOne account sync to an existing Dealer Dash database.
-- Apply once:  npx wrangler d1 execute dealer-dash --remote --file=migrations/001-fieldone.sql
-- (schema.sql already includes these for a fresh database)

ALTER TABLE users ADD COLUMN source TEXT;   -- 'fieldone' = managed by the nightly sync
ALTER TABLE users ADD COLUMN ext_id TEXT;   -- '<sheet>:<FieldOne id>', e.g. 'ASMs:asm_x'
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ext ON users(ext_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
