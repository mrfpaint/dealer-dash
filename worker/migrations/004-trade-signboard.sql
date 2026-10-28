-- National head's second round of changes (Oct 2026).
-- Apply once:  npx wrangler d1 execute dealer-dash --remote --file=migrations/004-trade-signboard.sql
-- (schema.sql and seed.sql already include these for a fresh database)

ALTER TABLE visits ADD COLUMN bank_name TEXT;
ALTER TABLE visits ADD COLUMN signboards TEXT NOT NULL DEFAULT '[]'; -- JSON array: GLB | NLB | ACP

-- MRF Paints is listed first wherever brands appear.
INSERT OR IGNORE INTO brands (name, sort) VALUES ('MRF Paints', 0);
