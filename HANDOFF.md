# PlateLog handoff (as of Nov 17, 2026)

## What it is
PlateLog is Addison's personal calorie, weight, and fiber tracker. It started as a claude.ai artifact (Version 10). Its third macro is **fiber, not fat**, and weights are stored in pounds. It has three tabs: Today, Progress, and Targets. You log meals by typing a description or snapping a photo, and AI estimates the calories, protein, and fiber. There is also an AI coach check-in that can include a body photo. Earlier in the build, the artifact's `window.claude` calls were replaced with a Supabase adapter.

## Live setup
- **Frontend:** static files in `public/`, hosted on Netlify at https://platelog-addy.netlify.app (site id `7027a38a-8a87-445d-9756-06610d010614`). There is no build step. The site is on the assistant's Netlify account, so a new owner should redeploy the files to their own host.
- **Backend:** Supabase project "platelog", ref `ozpusacaqzjbyxxpprtk` (us-east-1, free plan). It was created with the assistant's sign-up email (fah2m3a1@mail.grokbot.com), not Addison's own Supabase account.
  - **Auth:** email magic link. The Site URL and redirect URLs are set to the Netlify origin.
  - **Postgres:** table `docs` holds one row per artifact document (the day logs, targets, and so on as JSON). Table `api_keys` holds hashed personal `pl_` keys. Both use row level security keyed to `auth.uid()`, and `docs` is published to realtime.
  - **Storage:** private bucket `checkins`, with a folder per user id.
  - **Edge function `sample`** (verify_jwt on) is the AI proxy that the page calls. It uses Gemini.
  - **Edge function `api`** (verify_jwt off) authenticates with a personal `Authorization: Bearer pl_...` key. It lets an outside agent log meals and weight and read summaries.
- **AI:** Google Gemini API. The key is stored only as the Supabase secret `GEMINI_API_KEY`, and the Google project is on prepay billing with $5 loaded.
  - `GEMINI_MODEL` defaults to `gemini-3.5-flash`. It handles photos and check-ins.
  - `GEMINI_MODEL_QUICK` defaults to `gemini-3.5-flash-lite`. It handles quick text estimates.
  - Calls use the `x-goog-api-key` header, a default output budget of 4096 tokens (cap 8192), and thinking turned off. They retry once on an empty response, MAX_TOKENS, or a 5xx error.
  - Errors are mapped: a 429 returns `rate_limited`, a 402 or depleted credit returns `billing`, an undecodable image returns `image_rejected`, and an oversized file returns 413.
  - Gemini 2.5 Flash is deprecated and will be routed to 3.5 Flash-Lite on Dec 1, 2026. Don't pin to it.

## Repo layout
- `public/index.html` is the artifact UI. Fixes made on top of it:
  - Added the mobile viewport and apple-mobile-web-app meta tags.
  - Inputs are 16px on small screens, so iOS doesn't zoom in on focus.
  - Added `[hidden]{display:none!important}`, because a `display:grid` rule was overriding `hidden` and kept the tabs from switching.
  - Replaced the Claude wording with neutral text, such as "AI reads it" and "Get a coach check-in". The button's element id is still `askClaude`.
  - The coach prompt hard-codes Addison's stats: 6'1", cutting from 179.5 lb, plus his training style. Update these if they change.
- `public/adapter.js` is the Supabase adapter (auth, storage, and calls to `sample`). Before uploading, it downscales photos to a 1280px JPEG, which also handles HEIC from iPhones. It shows friendly error messages.
- `public/config.js` holds the Supabase URL and anon key. The anon key is safe to publish. `config.example.js` is the template.
- `public/vendor/supabase.mjs` is a vendored copy of supabase-js.
- `supabase/migrations/20261117000000_init.sql` is the full schema, RLS policies, and storage bucket.
- `supabase/functions/sample` is the Gemini proxy, and `supabase/functions/api` is the personal-key API. `_shared/analytics.js` is shared math, and `shared/analytics.js` is the same thing for the client.
- `scripts/import.mjs` imports an artifact export JSON into a user's docs (`--replace` wipes them first). `scripts/export-shape.mjs` and `analytics.test.mjs` are helpers and tests.
- `examples/export.example.json` holds synthetic data only. Addison's real export is personal, so never commit it.
- `README.md` explains how to run locally and deploy to a hosted project.

## Deploy commands
```bash
# frontend
netlify deploy --prod --dir public --site <SITE_ID> --no-build
# backend
supabase link --project-ref <REF>
supabase db push
supabase secrets set GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.5-flash GEMINI_MODEL_QUICK=gemini-3.5-flash-lite
supabase functions deploy sample --use-api
supabase functions deploy api --use-api
```

## Moving it to a new owner or project
1. Create a Supabase project and run the migration.
2. Set the secrets and deploy both functions.
3. Enable email auth, and set the Site URL and redirect URLs to the new frontend origin.
4. Put the new URL and anon key in `public/config.js`, then deploy `public/` to any static host.
5. Bring over the data, using either of these:
   - Run `scripts/import.mjs` with Addison's original export JSON.
   - Dump the `docs` table from the current project (`supabase db dump --data-only -t public.docs`). Ask the current maintainer for that dump, because the current project's database password and service-role key are not shared in this document.
6. Create a new `pl_` key through the app or the `api_keys` table for any agent that logs on Addison's behalf.

## Decisions and preferences
- **Web app over a native app:** Addison uses it from Firefox on iOS and can add it to the home screen. A Capacitor native wrap is planned only if Apple Health or Whoop integration is wanted. That needs the $99/yr Apple developer account and TestFlight. Addison owns a Whoop band but doesn't wear it right now, and logs lifts in Apple Notes.
- **Gemini over Anthropic** for cost reasons. Addison's Claude Pro ends Dec 8, 2026.
- Addison reports bugs as "BUG N: ...". He wants a mobile-first design and is open to further design polish.

## Open items
- Optional: a model picker on the Targets page. Models can already be changed through the Supabase secrets.
- Revoke the unused full-access Supabase access token "platelog-deploy" (expires Dec 16).
- Ideas: logging via the `api` key from an agent, and a weekly recap routine.
