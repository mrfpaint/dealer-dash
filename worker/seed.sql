-- Dealer Dash — brand master data. Safe to re-run (INSERT OR IGNORE).
-- Apply with:  npx wrangler d1 execute dealer-dash --remote --file=seed.sql
-- After the first load, the sales head edits these from the app (Brands page).

INSERT OR IGNORE INTO brands (name, sort) VALUES
  ('MRF Paints', 0), ('Asian Paints', 10), ('Berger Paints', 20), ('Nerolac', 30), ('Akzo Nobel (Dulux)', 40),
  ('JSW Paints', 50), ('Opus', 60), ('Nippon Paint', 70), ('Indigo Paints', 75),('Sirca', 80), ('ICA', 90),
  ('Shalimar Paints', 100), ('Sheenlac', 110), ('Jotun', 120), ('Local brand', 130), ('Others', 140);

-- Given by the sales head. "Super PC Dealer" was marked "needs verification" in the brief.
INSERT OR IGNORE INTO brand_options (brand_id, kind, name, sort, verified) VALUES
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'special',   'PC Dealer',         1, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'special',   'Super PC Dealer',   2, 0),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'special',   'Premium PC Member', 3, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Colour World',      1, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Colour Idea',       2, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Ezy Colour',        3, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Ezy Colour Prime',  4, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Colour NXT',        5, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Colour NXT Prime',  6, 1),
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),  'exclusive', 'Beautiful Homes',   7, 1),
  ((SELECT id FROM brands WHERE name = 'Berger Paints'), 'special',   'Gold Card Dealer',  1, 1),
  ((SELECT id FROM brands WHERE name = 'Berger Paints'), 'special',   'Super Gold Card',   2, 1);

-- Drafted from public sources (Oct 2026), verified = 0 until the sales head confirms.
-- No public source names dealer loyalty tiers for these brands, so reps pick
-- "Other" and type the tier they hear; recurring ones can be added later.
INSERT OR IGNORE INTO brand_options (brand_id, kind, name, sort, verified) VALUES
  ((SELECT id FROM brands WHERE name = 'Asian Paints'),       'exclusive', 'Colour Cube',                  8, 0),
  ((SELECT id FROM brands WHERE name = 'Berger Paints'),      'exclusive', 'Colour Bank',                  1, 0),
  ((SELECT id FROM brands WHERE name = 'Berger Paints'),      'exclusive', 'Berger Experience Zone',       2, 0),
  ((SELECT id FROM brands WHERE name = 'Nerolac'),            'exclusive', 'Nerolac Impression Shoppe',    1, 0),
  ((SELECT id FROM brands WHERE name = 'Akzo Nobel (Dulux)'), 'exclusive', 'Dulux Decoration Centre',      1, 0),
  ((SELECT id FROM brands WHERE name = 'JSW Paints'),         'exclusive', 'Colourvista Senses',           1, 0),
  ((SELECT id FROM brands WHERE name = 'Opus'),               'exclusive', 'Birla Opus Paint Studio',      1, 0),
  ((SELECT id FROM brands WHERE name = 'Opus'),               'exclusive', 'Birla Opus Franchise Gallery', 2, 0),
  ((SELECT id FROM brands WHERE name = 'Nippon Paint'),       'exclusive', 'NEO Homes',                    1, 0),
  ((SELECT id FROM brands WHERE name = 'Nippon Paint'),       'exclusive', 'Nspire Store',                 2, 0),
  ((SELECT id FROM brands WHERE name = 'Nippon Paint'),       'exclusive', 'PROStore',                     3, 0),
  ((SELECT id FROM brands WHERE name = 'Nippon Paint'),       'exclusive', 'Paint House',                  4, 0),
  ((SELECT id FROM brands WHERE name = 'Jotun'),              'exclusive', 'Multicolor Centre',            1, 0),
  ((SELECT id FROM brands WHERE name = 'Jotun'),              'exclusive', 'Jotun Colour Centre (JCCI)',   2, 0);
