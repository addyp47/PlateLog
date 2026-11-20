# Changelog

All notable changes to Plate Log are tracked in this file and via GitHub Releases (`v*` tags).

## [0.4.4] - 2026-11-20

### Added
- **SnapCalorie / Apple Health Nutrition Sync (`supabase/functions/api/index.ts`, `supabase/migrations/20261120000000_upsert_day_food_by_name.sql`):**
  - Added idempotent `POST /functions/v1/api/nutrition` so an iPhone Shortcut can send a day's Dietary Energy, protein, carbs, fat, and optional fiber totals from Apple Health (written by SnapCalorie).
  - Replays replace that day's single `SnapCalorie (Apple Health)` food entry and leave manual entries untouched. Accepts a single day or a `days` / `entries` array (up to 366) for backfill, plus string numbers and common date formats.

## [0.4.3] - 2026-11-18

### Fixed
- **Allow Any Decimal Values Across All Numeric Inputs (`public/index.html`):**
  - Switched all `<input type="number">` fields (servings, grams, calories, macros, weight, body fat %, waist, targets, My Foods, and photo item grams) to `step="any"` and added `novalidate` on `#foodForm` so decimals like `1.2`, `0.33`, or `14.7` never trigger browser `"Please enter a valid value"` errors.

## [0.4.2] - 2026-11-18

### Improved
- **Barcode Servings Picker (`public/index.html`):**
  - Scanning a barcode (both Open Food Facts lookups and previously saved barcodes) now opens an interactive **Servings** picker (`½`, `1`, `1½`, `2`, `3`, or any custom decimal) instead of auto-filling calories and assuming 1 serving.
  - Macros update live as you pick or type servings, and products with both per-serving and per-100 g nutrition include a one-tap **Servings / Grams** toggle if you weigh the portion on a scale.

## [0.4.1] - 2026-11-18

### Fixed
- **Eliminated False "not a food" Rejections (`public/index.html`, `supabase/functions/api/index.ts`):**
  - Removed the `error` gatekeeper field from `TEXT_ESTIMATE_SCHEMA` and `QUICK_LOG_SCHEMA` and added explicit `required` macro fields so Gemini always returns a best-effort nutrition estimate instead of refusing valid entries like `roasted potatoes (245g)`.
  - Defensively unwrapped `{ json, grounding }` responses (preventing stale-cache mismatches from looking like non-food errors), parsed numeric strings safely (`parseNum` / `parseLooseNumber`), and ensured valid meal/label photo estimates are never discarded due to stray `error` text.
- **Withings Morning Weigh-In Priority (`supabase/functions/withings/index.ts`):**
  - Kept the first (earliest) weigh-in of the day when multiple scale measurements occur on the same date, and widened the webhook sync lookback window to 48 hours so later-day weigh-ins never overwrite a morning weigh-in.

## [0.4.0] - 2026-11-18

### Added
- **Withings Smart Scale OAuth2 & Webhook Auto-Sync (`supabase/functions/withings/index.ts`, `supabase/migrations/20261118000000_withings.sql`, `supabase/config.toml`, `public/adapter.js`):**
  - Added direct Withings account linking in **Targets → Withings Smart Scale** with server-side `service_role`-only token storage, proactive/reactive refresh-token rotation, initial 90-day backfill (`weight` + `body_fat`), on-demand **Sync 90 d** / **Backfill 365 d** actions, and automatic `notify` (`appli=1`) webhook push updates whenever you step on the scale.
- **Body Fat % & Lean Mass Tracking (`public/analytics.js`, `shared/analytics.js`, `supabase/functions/_shared/analytics.js`, `public/index.html`, `supabase/functions/api/index.ts`):**
  - Added gap-adjusted EMA `trendBodyFat`, 21-day `bodyFatRatePerWeek`, and derived `leanMass` / `fatMass` estimates computed from smoothed weight × body fat %.
  - Added **Body fat (%)** input + Trend BF% / Est. Lean lb stat chip on **Today**, a **Body Fat & Lean Mass** trend chart card (`#bfCard`) + 21-day body fat trend insights on **Progress**, and body composition metrics in **Coach Check-in** prompts.
  - Added `body_fat` validation (auto-normalizing Apple Health `0..1` decimal ratios like `0.182` to `18.2%`) across `POST /functions/v1/api/weight`, `POST /functions/v1/api/health`, and `GET /functions/v1/api/summary`.

## [0.3.1] - 2026-11-17

### Added
- **Live Restaurant Nutrition Lookup via Google Search (`supabase/functions/_shared/gemini.ts`, `supabase/functions/sample/index.ts`, `supabase/functions/api/index.ts`, `public/adapter.js`, `public/index.html`):**
  - Checking **Restaurant / takeout** on text or meal photo estimates (and passing `"restaurant": true` to `POST /functions/v1/api/log`) now enables Gemini Google Search grounding (`tools: [{ google_search: {} }]`) so Gemini looks up published restaurant and menu nutrition online rather than guessing from memory.
  - Surfaces web source titles/search confirmation directly in the estimate status line and returns `grounding` metadata on `/api/log` and `sample` responses, with automatic fallback if a configured model rejects combined search + structured JSON.

## [0.3.0] - 2026-11-17

### Added
- **Full Macro Tracking (`kcal`, `protein`, `carbs`, `fat`, `fiber`):**
  - Updated all 5 macro bars, composer/edit/scale/leftovers/combos/My Foods forms, Gemini text/meal/label schemas, Open Food Facts barcode lookup, 7-day averages on **Progress**, Coach prompts, and `/functions/v1/api/log` + `/entries` + `/summary` endpoints. Legacy logged foods without carbs or fat continue to render and sum cleanly.
- **Active Calories (`energy_out`) & Customizable Step Goal:**
  - Added **Active kcal** input alongside weight and steps on **Today**, a 28-day **Active calories** bar chart (`#activeCard`) + 7-day active burn summary and step insights on **Progress**, configurable **Daily steps** target in **Targets** (`8000` default), and combined `/health` Apple Shortcut examples.

### Improved
- **Conflict-Safe Day Sync & In-App Update Prompt:**
  - Replaced full-day `set()` overwrites on the client with field-level `patch_day_fields` RPC updates (`db.patchDay` in `public/adapter.js`) + offline patch coalescing so concurrent logs (e.g., iPhone food logging + Apple Health Shortcuts step sync) never clobber each other.
  - Added an in-app **New version available → Reload** banner when the service worker installs an update.
  - Unified frontend, Edge Functions, and tests on a single canonical `public/analytics.js` module and removed unused legacy Lift UI scaffolding.
- **CI & Auto-Deploy (`ci.yml`, `deploy.yml`):**
  - Added syntax verification for `public/analytics.js`, `public/vendor/barcode.mjs`, and Supabase Edge Functions in CI, and defaulted `SUPABASE_PROJECT_REF` in `deploy.yml` for one-step automatic Edge Function & DB migration deployments.

## [0.2.7] - 2026-11-17

### Fixed
- **False "not a food" Estimate Rejections (`public/index.html`, `supabase/functions/api/index.ts`):**
  - Made structured `error` schema fields `nullable: true` across `TEXT_ESTIMATE_SCHEMA`, `MEAL_SCHEMA`, `LABEL_SCHEMA`, `DISH_SCHEMA`, and `QUICK_LOG_SCHEMA`, and added `modelErr()` / `modelErrorText()` helpers so sentinel strings like `"none"`, `"null"`, or `"N/A"` returned by Gemini JSON schemas no longer trigger false rejections.
  - Updated text and photo food estimation prompts to explicitly treat drinks, milk, shakes, condiments, and supplements as valid consumable entries, and switched text estimates in `estimateEntry` and `/api/log` to `modelTier: "default"` (`gemini-4-hydrogen`).

## [0.2.6] - 2026-11-17

### Added
- **Apple Health Steps & Activity Sync (`supabase/functions/api/index.ts`, `shared/analytics.js`, `public/index.html`):**
  - Added `POST /functions/v1/api/steps` and `POST /functions/v1/api/health` (supports single-day or batch `entries`, optional `weight` and `energy_out`, plus comma-formatted numbers and ISO timestamps from Apple Shortcuts).
  - Added a **Steps** input next to Scale weight on the **Today** tab, a 7-day average + 28-day **Steps** bar chart on **Progress**, step context in **Coach Check-in** prompts, and copyable **Apple Health Steps & Weight Automation** setup in **Targets → External API & iOS Shortcuts**.

## [0.2.5] - 2026-11-17

### Added
- **Universal Camera Barcode Scanner (`public/vendor/barcode.mjs` + `public/index.html`):** Added a pure-JS ZXing 1D barcode decoder fallback (UPC-A, UPC-E, EAN-13, EAN-8, Code 128, horizontal & vertical) so live camera scanning works on iOS Safari, Home Screen PWAs, and browsers without `BarcodeDetector`, plus a **Scan from photo** camera fallback and collapsed manual digit entry.

### Improved
- **Dark Mode & System Preference Sync (`public/index.html`):** Default cleanly to system appearance (`auto`), sync `<meta name="theme-color">` and native `color-scheme` / `accent-color` across light/dark transitions, and add a quick **Auto / Dark / Light** pill toggle in the header alongside **Targets → Account & App**.

## [0.2.4] - 2026-11-17

### Fixed
- **Service Worker Asset Sync (`public/sw.js`):** Serve `/adapter.js` network-first alongside `/index.html` and `/config.js` so PWA updates never mix new HTML with an older cached adapter module.
- **Backup Import Guard & Object Profile Formatting (`public/index.html`):** Throw a clear refresh prompt if `window.platelog.importBackup` isn't loaded yet instead of silently reporting `0` imported documents, and format object-shaped `settings.profile` records (`height_in`, `start_weight_lb`, `start_date`) cleanly instead of rendering `[object Object]`.

## [0.2.3] - 2026-11-17

### Changed
- **Password-First Sign-In (`public/adapter.js`):** Made Email + Password the primary sign-in form (supports iOS Face ID / Keychain autofill and avoids Supabase's 2/hr built-in email limit), with the 6-digit email code flow tucked below as a secondary option and a clearer rate-limit message.

## [0.2.2] - 2026-11-17

### Added
- **In-App Backup Import & Export:** Added **Import backup JSON** and **Export JSON** buttons under **Targets → Account & App** (`public/index.html` + `public/adapter.js`) so you can restore a Plate Log backup directly from your browser or iPhone without needing a service-role key or CLI.

### Fixed
- **CLI Import (`scripts/import.mjs`):** Avoid sending `sb_secret_` keys in the `Authorization: Bearer` header so 2026 secret keys work seamlessly alongside legacy `service_role` JWTs.

## [0.2.1] - 2026-11-17

### Changed
- **Gemini 4 Hydrogen Support (`supabase/functions/_shared/gemini.ts`):** Updated `DEFAULT_MODEL` to `gemini-4-hydrogen` and replaced hardcoded `thinkingBudget: 0` with model-aware `thinkingLevel` (`low` for Gemini 4 JSON extraction, `medium` for Coach check-ins, `minimal` for `gemini-3.5-flash-lite`, `thinkingBudget: 0` for legacy Gemini 2.5).
- **Supabase Publishable Key & 2026 Project Support:**
  - Upgraded vendored `@supabase/supabase-js` (`public/vendor/supabase.mjs`) from `2.49.1` to `2.119.0` for native `sb_publishable_` key handling.
  - Updated `public/config.js` to the new Supabase project URL and publishable key.
  - Set `verify_jwt = false` for `[functions.sample]` in `supabase/config.toml` (the function verifies user sessions directly via `supabase.auth.getUser()`), preventing legacy-HS256 gateway rejections on 2026 signing keys.

## [0.2.0] - 2026-11-17

### Added
- **PWA & Offline Support:** Added `public/manifest.webmanifest`, PNG app icons (`192`, `512`, `apple-touch-icon`), and `public/sw.js` service worker, plus local snapshot caching and an offline write queue in `public/adapter.js`.
- **iOS-Friendly Auth:** Added in-app 6-digit Email OTP verification alongside password sign-in so Safari Home Screen PWAs never hit cross-browser PKCE redirect failures.
- **Mobile UI Overhaul (`public/index.html`):**
  - Bottom tab bar on mobile (`<= 640px`) for thumb-friendly navigation.
  - Unified food entry composer with separate Camera (`capture="environment"`), Photos, and Barcode Scanner (`BarcodeDetector` + Open Food Facts lookup) controls.
  - Tap-to-edit logged foods (macros, quick scale `0.5×`/`1.5×`/`2×`, duplicate) and one-tap **Copy yesterday**.
  - **"Finish yesterday"** reminder banner when yesterday has food logged without being marked complete.
  - Interactive touch-scrubbing weight and calorie charts.
  - Adaptive TDEE target suggestion card with one-tap **Apply to Targets**.
  - Editable Coach Profile in Targets, optional body-photo attachment on Coach Check-in, and persisted `coach_notes` history.
  - Account & App card in Targets with theme selector (`Auto / Light / Dark`), full-history loader, version badge, and sign out.
- **Backend & iOS Shortcuts API:**
  - Migration `20261117000001_atomic_and_coach.sql` adding `coach_notes` collection, rolling day index, and atomic `append_day_food` / `patch_day_fields` RPCs.
  - New `POST /functions/v1/api/log` endpoint (Gemini estimation + atomic save + remaining macros) and `GET /functions/v1/api/foods` for Apple Shortcuts.
  - Shared Gemini client (`_shared/gemini.ts`) with structured JSON `responseSchema` support.
- **Release & CI/CD Workflows:** Added `.github/workflows/ci.yml`, `deploy.yml`, and `release.yml`.

### Security & Fixes
- Disabled open signups by default (`supabase/config.toml` and `adapter.js` UI).
- Added optional `ALLOWED_USER_IDS` / `ALLOWED_EMAILS`, `ALLOWED_ORIGINS` CORS restriction, and per-minute rate limiting in `sample/index.ts`.
- Compressed and converted monthly check-in photos (`assets.upload`) to JPEG so iPhone HEIC files render everywhere and stay compact.
- Scoped Realtime updates and suppressed local-write echo reloads in `public/adapter.js`.

## [0.1.0] - 2026-11-17
- Initial Supabase + Netlify port from Plate Log Version 10 artifact.
