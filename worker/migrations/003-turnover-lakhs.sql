-- National head's changes to the Turnover section (Oct 2026).
-- Apply once:  npx wrangler d1 execute dealer-dash --remote --file=migrations/003-turnover-lakhs.sql
-- (schema.sql already includes these for a fresh database)

-- Turnover is now entered in ₹ lakhs per year (was ₹ crore): convert existing values.
UPDATE visits SET
  turnover_total  = turnover_total  * 100,
  turnover_wood   = turnover_wood   * 100,
  turnover_metal  = turnover_metal  * 100,
  turnover_wall   = turnover_wall   * 100,
  turnover_others = turnover_others * 100;

ALTER TABLE visits ADD COLUMN turnover_waterproofing REAL;
ALTER TABLE visits ADD COLUMN turnover_industrial REAL;
ALTER TABLE visits ADD COLUMN paint_volume REAL;      -- litres per year

-- Customer type: % of the dealer's sales
ALTER TABLE visits ADD COLUMN mix_retail REAL;
ALTER TABLE visits ADD COLUMN mix_contractor REAL;
ALTER TABLE visits ADD COLUMN mix_architect REAL;     -- architects / projects
ALTER TABLE visits ADD COLUMN mix_industrial REAL;    -- industrial / OEM supply

-- Secondary: people associated with the dealer
ALTER TABLE visits ADD COLUMN sec_contractors INTEGER; -- contractors / painters
ALTER TABLE visits ADD COLUMN sec_architects INTEGER;
