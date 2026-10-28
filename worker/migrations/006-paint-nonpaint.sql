-- Turnover split into paint and non-paint products (Oct 2026).
-- Apply once:  npx wrangler d1 execute dealer-dash --remote --file=migrations/006-paint-nonpaint.sql
-- (schema.sql already includes these for a fresh database)

ALTER TABLE visits ADD COLUMN turnover_paint REAL;
ALTER TABLE visits ADD COLUMN turnover_nonpaint REAL;

-- Until now the form only asked about paint, so the old total was the paint turnover.
UPDATE visits SET turnover_paint = turnover_total WHERE turnover_total IS NOT NULL;
