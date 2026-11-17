# Plate Log

A private, mobile-first calorie, weight, and fiber tracker. Built as a zero-build PWA (`public/`) backed by Supabase (Postgres, Auth, Storage, Realtime, and Edge Functions) and Google Gemini.

The third macro in this log is **fiber**, not fat. Weights are stored in pounds.

## Hosted setup (GitHub-driven)

This repo is set up to build, test, deploy, and release directly from GitHub:

1. **Frontend (Cloudflare Pages recommended, or Netlify):**
   - Connect `addyp47/PlateLog` in Cloudflare Pages with **Framework preset:** `None`, **Build command:** *(empty)*, **Build output directory:** `public`.
   - Every push to `main` deploys automatically; pull requests get preview URLs.
   - Install on iPhone via **Safari → Share → Add to Home Screen** (gives full-screen standalone PWA mode, app icon, offline shell cache, and camera access).
2. **Backend (your own Supabase project):**
   - Create a project in Supabase (`us-east-1`, free plan).
   - **Authentication → Providers → Email:** enable Email, and turn **Confirm email** on, while turning **Allow new users to sign up** **OFF** after creating your single account (via Dashboard → Authentication → Users → Add user, or `scripts/import.mjs`).
   - **Authentication → URL configuration:** set Site URL and Redirect URLs to your hosted origin (e.g. `https://platelog.pages.dev`).
   - Set Supabase secrets:
     ```bash
     supabase secrets set GEMINI_API_KEY=...
     supabase secrets set GEMINI_MODEL=gemini-3.5-flash
     supabase secrets set GEMINI_MODEL_QUICK=gemini-3.5-flash-lite
     supabase secrets set ALLOWED_EMAILS=you@example.com
     supabase secrets set ALLOWED_ORIGINS=https://platelog.pages.dev,http://127.0.0.1:43123
     ```
   - Update `public/config.js` with your Supabase URL and public anon key (safe to publish).
3. **Auto-deploy Supabase from GitHub (optional):**
   - In GitHub Repo **Settings → Secrets and variables → Actions**:
     - Variable `SUPABASE_DEPLOY_ENABLED` = `true`
     - Secret `SUPABASE_ACCESS_TOKEN` = your Supabase personal access token
     - Secret `SUPABASE_PROJECT_REF` = your Supabase project ref
   - Pushes to `main` will automatically run `npm test`, `supabase db push`, and deploy `sample` and `api` Edge Functions.

## Release tracking

Releases follow [Semantic Versioning](https://semver.org/) in `package.json`, `public/sw.js`, `public/index.html`, and `CHANGELOG.md`:

```bash
# 1. Update version in package.json, public/sw.js (CACHE_NAME), public/index.html, and CHANGELOG.md
# 2. Verify locally:
npm test
# 3. Commit, tag, and push:
git commit -am "Release v0.2.0"
git tag v0.2.0
git push origin main --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which verifies tests & version parity, zips `public/`, and publishes a GitHub Release with auto-generated release notes.

## Run locally

Requirements: Docker, the [Supabase CLI](https://supabase.com/docs/guides/cli), and Node 20+.

```bash
supabase start
python3 -m http.server 43123 -d public
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123). Load synthetic sample data with:

```bash
PLATELOG_USER_EMAIL=dev@platelog.test PLATELOG_USER_PASSWORD=platelog-dev \
  node scripts/import.mjs examples/export.example.json --replace
```

## External API & iOS Shortcuts

Base URL: `$SUPABASE_URL/functions/v1/api`

Create a `pl_` key on the **Targets** tab (`External API & iOS Shortcuts`). Pass `Authorization: Bearer pl_...`.

```bash
# Estimate + log food from text or photo (returns totals and remaining targets)
curl -s -X POST "$SUPABASE_URL/functions/v1/api/log" \
  -H "Authorization: Bearer $PLATELOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"200g chicken breast and 1 cup white rice"}'

# Log exact macros directly
curl -s -X POST "$SUPABASE_URL/functions/v1/api/entries" \
  -H "Authorization: Bearer $PLATELOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-11-17","name":"Greek yogurt","kcal":180,"protein":20,"fiber":0}'

# Log morning weight (or Apple Health weight automation)
curl -s -X POST "$SUPABASE_URL/functions/v1/api/weight" \
  -H "Authorization: Bearer $PLATELOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-11-17","weight":172.4}'

# Mark a day complete
curl -s -X POST "$SUPABASE_URL/functions/v1/api/complete" \
  -H "Authorization: Bearer $PLATELOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-11-17","complete":true}'

# Summary + trend weight + adaptive maintenance
curl -s "$SUPABASE_URL/functions/v1/api/summary?today=2026-11-17" \
  -H "Authorization: Bearer $PLATELOG_API_KEY"
```

## Data layout

One row per document in `public.docs` (`user_id`, `collection`, `doc_id`, `data jsonb`). Collections are `settings`, `days`, `foods`, `combos`, `checkins`, and `coach_notes`.
Day mutations via the external API use atomic Postgres RPCs (`append_day_food` and `patch_day_fields`) so concurrent writes never clobber each other.
