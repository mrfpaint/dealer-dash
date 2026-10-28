-- Dealer Dash — D1 schema
-- Apply with:  npx wrangler d1 execute dealer-dash --remote --file=schema.sql
-- (use --local instead of --remote for the local dev database)

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- employee code or mobile
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,                        -- st | bdo | asm | rsm | sh | nh | nsh | admin (as in FieldOne)
  manager_id  TEXT REFERENCES users(id),            -- who this person reports to
  region      TEXT,
  pass_salt   TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT,                                 -- 'fieldone' = managed by the nightly sync
  ext_id      TEXT                                  -- '<sheet>:<FieldOne id>'
);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ext ON users(ext_id);

-- Small key/value store (last FieldOne sync result).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sort        INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1
);

-- Special-dealer tiers and exclusive-outlet formats for each brand.
-- verified = 0 marks a drafted name the sales head has not confirmed yet.
CREATE TABLE IF NOT EXISTS brand_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id    INTEGER NOT NULL REFERENCES brands(id),
  kind        TEXT NOT NULL CHECK (kind IN ('special','exclusive')),
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 100,
  verified    INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (brand_id, kind, name)
);

CREATE TABLE IF NOT EXISTS visits (
  id              TEXT PRIMARY KEY,           -- generated on the phone, so offline re-sends are idempotent
  user_id         TEXT NOT NULL REFERENCES users(id),
  rep_name        TEXT NOT NULL,
  visit_date      TEXT NOT NULL,              -- YYYY-MM-DD
  created_at      TEXT NOT NULL,              -- when filled on the phone (ISO)
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),

  shop_name       TEXT NOT NULL,
  owner_name      TEXT,
  address         TEXT,
  area            TEXT,
  town            TEXT,
  district        TEXT,
  state           TEXT,
  pincode         TEXT,
  mobile1         TEXT,
  mobile2         TEXT,
  landline        TEXT,

  -- [{brand, dealer_type: Regular|Special|Exclusive, tier}]
  brands_json     TEXT NOT NULL DEFAULT '[]',

  turnover_total  REAL,                       -- ₹ lakhs per year
  turnover_wood   REAL,
  turnover_metal  REAL,
  turnover_wall   REAL,
  turnover_waterproofing REAL,
  turnover_industrial REAL,
  turnover_others REAL,
  paint_volume    REAL,                       -- litres per year

  mix_retail      REAL,                       -- customer type, % of sales ("Direct consumer")
  mix_contractor  REAL,
  mix_architect   REAL,                       -- architects / projects
  mix_industrial  REAL,                       -- industrial / OEM supply

  sec_contractors INTEGER,                    -- contractors / painters associated
  sec_architects  INTEGER,                    -- architects associated

  has_tinting     INTEGER,                    -- 1 yes / 0 no / NULL not asked
  tinting_type    TEXT,                       -- Water based | Dual mode | Both
  tinting_brands  TEXT NOT NULL DEFAULT '[]', -- JSON array
  tinting_brand_other TEXT,
  -- [{company, company_other, water, dual, brand, brand_other}]: one row per paint company's machines;
  -- tinting_type / tinting_brands above are worked out from these rows
  tinting_machines TEXT NOT NULL DEFAULT '[]',

  cd_dealer       INTEGER,
  cd_percent      REAL,
  credit_days     INTEGER,
  purchase_from   TEXT,                       -- Direct company | Wholesaler | Both
  payment_modes   TEXT NOT NULL DEFAULT '[]', -- JSON array
  payment_other   TEXT,
  bank_name       TEXT,
  signboards      TEXT NOT NULL DEFAULT '[]', -- JSON array: GLB | NLB | ACP

  lat             REAL,
  lng             REAL,
  gps_accuracy    REAL,
  photo_shop      INTEGER NOT NULL DEFAULT 0, -- 1 when a photo is stored
  photo_card      INTEGER NOT NULL DEFAULT 0,

  interest        TEXT,                       -- Hot | Warm | Cold
  remarks         TEXT,
  followup_date   TEXT,

  -- set by managers / sales head while shortlisting
  status          TEXT NOT NULL DEFAULT 'New', -- New | Shortlisted | In talks | Converted | Not suitable
  status_note     TEXT,
  status_by       TEXT,
  status_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_user   ON visits(user_id);
CREATE INDEX IF NOT EXISTS idx_visits_date   ON visits(visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_state  ON visits(state, district);
CREATE INDEX IF NOT EXISTS idx_visits_mobile ON visits(mobile1);

-- Only used when no R2 bucket is bound.
CREATE TABLE IF NOT EXISTS photos (
  key         TEXT PRIMARY KEY,               -- <visitId>/<shop|card>
  type        TEXT NOT NULL,
  data        BLOB NOT NULL
);
