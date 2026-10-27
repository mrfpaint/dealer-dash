-- Switches users to FieldOne's roles (st, bdo, asm, rsm, sh, nh, nsh, admin).
-- Apply once:  npx wrangler d1 execute dealer-dash --remote --file=migrations/002-fieldone-roles.sql
-- The old table had CHECK (role IN ('rep','manager','head','admin')), which SQLite
-- cannot alter, so the table is rebuilt; roles are now validated in worker.js.
-- Rows are copied out, the table is recreated under the same name and refilled:
-- re-inserting the parent rows is what clears SQLite's deferred foreign-key count
-- (a CREATE users_new + RENAME rebuild leaves it non-zero and D1 rolls back).

PRAGMA defer_foreign_keys = true;

CREATE TABLE users_bak AS SELECT * FROM users;
DROP TABLE users;

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  manager_id  TEXT REFERENCES users(id),
  region      TEXT,
  pass_salt   TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT,
  ext_id      TEXT
);

INSERT INTO users (id, login, name, role, manager_id, region, pass_salt, pass_hash, active, created_at, source, ext_id)
SELECT id, login, name,
  CASE
    WHEN role = 'admin' THEN 'admin'
    WHEN ext_id LIKE 'STs:%'  THEN 'st'
    WHEN ext_id LIKE 'BDOs:%' THEN 'bdo'
    WHEN ext_id LIKE 'ASMs:%' THEN 'asm'
    WHEN ext_id LIKE 'RSMs:%' AND LOWER(TRIM(region)) IN ('all india', 'all') THEN 'nsh'
    WHEN ext_id LIKE 'RSMs:%' AND LOWER(TRIM(region)) = 'south' THEN 'sh'
    WHEN ext_id LIKE 'RSMs:%' AND LOWER(TRIM(region)) = 'north' THEN 'nh'
    WHEN ext_id LIKE 'RSMs:%' THEN 'rsm'
    WHEN role = 'head' THEN 'nsh'
    WHEN role = 'manager' THEN 'asm'
    ELSE 'st'
  END,
  manager_id, region, pass_salt, pass_hash, active, created_at, source, ext_id
FROM users_bak;

DROP TABLE users_bak;
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ext ON users(ext_id);

-- Zone reporting lines, as FieldOne draws them (the nightly sync keeps them up to date).
UPDATE users SET manager_id = (SELECT id FROM users WHERE role = 'nsh' AND active = 1 LIMIT 1)
  WHERE role IN ('sh', 'nh');
UPDATE users SET manager_id = (SELECT id FROM users WHERE role = 'sh' AND active = 1 LIMIT 1)
  WHERE role = 'rsm' AND LOWER(TRIM(region)) LIKE 'south%';
UPDATE users SET manager_id = (SELECT id FROM users WHERE role = 'nh' AND active = 1 LIMIT 1)
  WHERE role = 'rsm' AND (LOWER(TRIM(region)) LIKE 'north%' OR LOWER(TRIM(region)) LIKE 'east%' OR LOWER(TRIM(region)) LIKE 'west%');
