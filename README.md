# Dealer Universe Mapping — MRF Paints

Field app for the sales team to scout competitor paint dealers who could become MRF dealers.
Reps fill in a visit form at the shop (works offline). Area managers see their team's visits,
and the sales head filters, shortlists and exports all of them.

**App:** https://mrfpaint.github.io/dealer-dash/

**Stack:** the PWA (repo root: `index.html`, `app.js`, `styles.css`, `sw.js`) is served by GitHub Pages.
It calls the API on a Cloudflare Worker (`worker/worker.js`, https://dealer-dash.jofran81.workers.dev).
Data is in D1 (`dealer-dash`) and photos are in R2 (`dealer-dash-photos`). No build step.

## Who sees what

| Role | Can do |
|---|---|
| Field rep | Fill in visits and see and edit their own |
| Area manager | Above, plus a dashboard of everyone reporting to them (directly or through others) and setting shortlist status |
| Sales head | Dashboard of everything, status, and editing brands and classifications |
| Admin | Everything, plus adding and disabling users and resetting passwords (users cannot change their own) |

## Accounts come from FieldOne

Staff log in with their **FieldOne username and password**. The Worker reads the STs, BDOs, ASMs and RSMs
tables straight from FieldOne's D1 database (`fieldone`, bound as `FIELDONE_DB`; Dealer Universe Mapping only reads it)
every night at 02:00 IST, and whenever an admin presses **Sync from FieldOne now** on the Users page:

| FieldOne | Dealer Universe Mapping role | Reports to | Sees visits of |
|---|---|---|---|
| ST / BDO | ST / BDO | their ASM | own |
| ASM | ASM | their RSM | own + their STs and BDOs |
| RSM | RSM | SH (South-* regions) or NH (North-*, East-*, West-*) | own + their ASMs' teams |
| RSM row with region South / North | SH / NH | NSH | their zone |
| RSM row with region All India | NSH | — | everything |

Admin accounts are Dealer Universe Mapping's own (not synced). The login screen is FieldOne's: pick the role, then sign
in on that role's card. Each card accepts only its own kind of account.

- Only active rows with a username and password are imported. A blank status counts as active, as it does in FieldOne.
- Passwords ignore upper/lower case, the same as FieldOne.
- New staff are added, and changed passwords, names or managers are updated. People who leave or are marked
  Inactive in FieldOne are disabled; their past visits are kept.
- Synced accounts are read-only in Dealer Universe Mapping. Change them in FieldOne.
- Accounts created by hand on the Users page (admin, ISCs, outsiders) are never touched. If a FieldOne
  username is already used by a hand-made account, that person is skipped and listed on the Users page.
- Safety brake: if FieldOne suddenly returns far fewer active staff than Dealer Universe Mapping has, the sync stops
  without disabling anyone.
- Synced passwords are stored as an HMAC keyed by `TOKEN_SECRET`. Hand-made accounts use PBKDF2.

## What a visit records

- **Auto-filled:** date, rep, GPS location.
- **Shop and dealer details:** shop name, dealer name, 2 mobiles, landline, address, area, town, district, state and pincode. The pincode looks up the district and state.
- **Brands sold:** each brand is marked Regular, Special dealer or Exclusive outlet, with a classification or outlet type, plus an "Other (type it)" option.
- **Turnover in ₹ crore:** wood, metal, wall and others, with an auto total.
- **Tinting machine:** water based, dual mode or both, plus the machine brand (COROB, AGS, Idex, Santint, Fast & Fluid, others).
- **Trade terms:** CD or non-CD dealer and CD %, credit days, buys direct or from a wholesaler, and payment mode.
- **Photos:** shop front and visiting card, compressed on the phone to about 100–200 KB.
- **Outcome:** interest (Hot/Warm/Cold), follow-up date and remarks.

The form warns if the mobile number was already recorded by any rep.

## Brand classifications

`seed.sql` loads 14 brands. The Asian Paints and Berger tiers come from the sales head's brief.
Exclusive-outlet names for other brands were drafted from public sources and loaded as **Unverified**.
The sales head reviews them under **Brands** (Confirm, Rename or Hide). No public source names the
special-dealer tiers of other brands, so reps choose "Other" and type the tier the dealer mentions.

## Deploy

The Worker is already deployed (D1, R2 and TOKEN_SECRET are set up). To set it up from scratch on another account:

```bash
cd worker
npx wrangler d1 create dealer-dash          # paste the database_id into wrangler.toml
npx wrangler r2 bucket create dealer-dash-photos   # without R2, delete the [[r2_buckets]] block
npx wrangler d1 execute dealer-dash --remote --file=schema.sql
npx wrangler d1 execute dealer-dash --remote --file=seed.sql
npx wrangler secret put TOKEN_SECRET       # paste a long random string (changing it later invalidates sessions and synced passwords until the next sync)
npx wrangler deploy
```

The app is GitHub Pages on this repo (Settings → Pages → Deploy from branch → `main` / root).
If the Worker URL changes, update `API_BASE` in `app.js`. If the Pages address changes, update
`ALLOWED_ORIGINS` in `worker/wrangler.toml`.

First run: open the app. The first screen asks you to create the **admin** account. Then add users
under **Users**, set "Reports to" so managers see their team, and share the link.
On phones: Chrome menu → **Add to Home screen** (or Safari Share → Add to Home Screen).

## Updating

- **App** (`index.html`, `app.js`, `styles.css`): commit and push to `main`. Pages republishes in about a minute.
  Bump `VERSION` in `sw.js` with every app change so installed phones pick up the new copy.
- **API** (`worker/`): run `npx wrangler deploy` from `worker/`.

## Local testing

```bash
cd worker
npx wrangler d1 execute dealer-dash --local --file=schema.sql
npx wrangler d1 execute dealer-dash --local --file=seed.sql
npx wrangler dev --port 8795
```

In a second terminal, from the repo root, serve the app on port 8796 (already allowed by
`ALLOWED_ORIGINS`, and on localhost `app.js` calls the API on 8795):

```bash
npx http-server . -p 8796 -c-1
```

`worker/.dev.vars` holds a local `TOKEN_SECRET` (git-ignored). The local database was seeded during
development with test logins (local only, not in production): `admin` / `admin123` and `rep1` / `test123`.
To start fresh, delete `worker/.wrangler/state`.

## Notes

- Free-plan sizing: D1 gives 5 GB and 100k writes a day, which is far beyond what a field team needs.
- Passwords use PBKDF2 hashing (50k iterations, set as `PBKDF2_ITER` in `worker.js`). If logins hit the
  Workers CPU limit on the free plan, lower it. Existing users then need a password reset.
- Pincode lookup uses the public India Post API (`api.postalpincode.in`) via the Worker. If it's
  down, reps type the district and state by hand.
- Sessions last 30 days so reps aren't logged out mid-trip while offline.
