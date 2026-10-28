-- Tinting machine table and Indigo Paints (Oct 2026).
-- Apply once:  npx wrangler d1 execute dealer-dash --remote --file=migrations/005-tinting-machines.sql
-- (schema.sql and seed.sql already include these for a fresh database)

-- [{company, company_other, water, dual, brand, brand_other}]: one row per paint company's machines
ALTER TABLE visits ADD COLUMN tinting_machines TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO brands (name, sort) VALUES ('Indigo Paints', 75);
