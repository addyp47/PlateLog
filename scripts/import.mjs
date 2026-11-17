#!/usr/bin/env node
// Load a PlateLog artifact export into Supabase.
//
//   node scripts/import.mjs path/to/export.json --replace
//
// Env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   PLATELOG_USER_EMAIL          (created if missing)
//   PLATELOG_USER_PASSWORD       (only used when creating the user; default platelog-dev)

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { analyze } from "../shared/analytics.js";
import { COLLECTIONS, documentsFromExport } from "./export-shape.mjs";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const replace = args.includes("--replace");
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("Usage: node scripts/import.mjs <export.json> [--replace] [--dry-run]");
  process.exit(1);
}

const root = JSON.parse(readFileSync(file, "utf8"));
const docs = documentsFromExport(root);
const counts = Object.fromEntries(COLLECTIONS.map((name) => [name, docs.filter((doc) => doc.collection === name).length]));
console.log(`Parsed ${file}`);
console.log(counts);

const settings = docs.find((doc) => doc.collection === "settings" && doc.doc_id === "main") || docs.find((doc) => doc.collection === "settings");
const days = Object.fromEntries(docs.filter((doc) => doc.collection === "days").map((doc) => [doc.doc_id, doc.data]));
const last = Object.keys(days).sort().at(-1);
if (Object.keys(days).length) {
  const summary = analyze(days, last);
  console.log("Preview from the file (same math as the Progress tab, through the last logged day):");
  console.log(JSON.stringify({
    units: summary.units,
    trendWeight: summary.trendWeight,
    trendDate: summary.trendDate,
    scaleWeight: summary.scaleWeight,
    ratePerWeek: summary.ratePerWeek,
    maintenance: summary.maintenance,
    energyOutAvg: summary.energyOutAvg,
    targets: settings?.data?.targets || null,
  }, null, 2));
}

if (dryRun) process.exit(0);

const env = loadEnv();
const email = process.env.PLATELOG_USER_EMAIL || "dev@platelog.test";
const userId = await ensureUser(env, email);
console.log(`Importing into ${email} (${userId})`);

if (replace) {
  const del = await rest(env, "DELETE", `/rest/v1/docs?user_id=eq.${userId}`, null);
  if (!del.ok) throw new Error(`Could not clear existing docs: ${del.status} ${del.text}`);
  console.log("Cleared existing documents for this user.");
}

const rows = docs.map((doc) => ({
  user_id: userId,
  collection: doc.collection,
  doc_id: doc.doc_id,
  data: doc.data,
}));

for (let i = 0; i < rows.length; i += 200) {
  const chunk = rows.slice(i, i + 200);
  const res = await rest(env, "POST", "/rest/v1/docs?on_conflict=user_id,collection,doc_id", chunk, {
    Prefer: "resolution=merge-duplicates",
  });
  if (!res.ok) throw new Error(`Upsert failed: ${res.status} ${res.text}`);
}

const readBack = await rest(env, "GET", `/rest/v1/docs?user_id=eq.${userId}&select=collection,doc_id,data,energy_out&order=doc_id.asc`);
if (!readBack.ok) throw new Error(`Read-back failed: ${readBack.status} ${readBack.text}`);
const stored = JSON.parse(readBack.text);
const storedDays = Object.fromEntries(stored.filter((row) => row.collection === "days").map((row) => [row.doc_id, row.data]));
const again = analyze(storedDays, last);
console.log(`Stored ${stored.length} documents (${Object.keys(storedDays).length} days).`);
console.log("Read back from Postgres:");
console.log(JSON.stringify({
  trendWeight: again.trendWeight,
  ratePerWeek: again.ratePerWeek,
  maintenance: again.maintenance,
  units: again.units,
}, null, 2));

function loadEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return { url: url.replace(/\/$/, ""), key };
  try {
    const raw = execSync("supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = Object.fromEntries(
      raw.split("\n").filter((line) => line.includes("=")).map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1).replace(/^"|"$/g, "")];
      }),
    );
    const foundUrl = parsed.API_URL || parsed.SUPABASE_URL;
    const foundKey = parsed.SERVICE_ROLE_KEY || parsed.SUPABASE_SERVICE_ROLE_KEY;
    if (foundUrl && foundKey) return { url: foundUrl.replace(/\/$/, ""), key: foundKey };
  } catch {
    // status is unavailable when the stack is not running
  }
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or start the local Supabase stack.");
}

async function ensureUser(env, email) {
  let page = 1;
  for (;;) {
    const res = await auth(env, "GET", `/auth/v1/admin/users?page=${page}&per_page=200`);
    if (!res.ok) throw new Error(`Could not list users: ${res.status} ${res.text}`);
    const body = JSON.parse(res.text);
    const users = body.users || [];
    const found = users.find((user) => (user.email || "").toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (users.length < 200) break;
    page += 1;
  }
  const password = process.env.PLATELOG_USER_PASSWORD || "platelog-dev";
  const created = await auth(env, "POST", "/auth/v1/admin/users", {
    email,
    password,
    email_confirm: true,
  });
  if (!created.ok) throw new Error(`Could not create ${email}: ${created.status} ${created.text}`);
  const user = JSON.parse(created.text);
  console.log(`Created ${email}. Local password is the PLATELOG_USER_PASSWORD value (default platelog-dev).`);
  return user.id;
}

function auth(env, method, path, body) {
  return request(env, method, path, body, true);
}

function rest(env, method, path, body, extra) {
  return request(env, method, path, body, false, extra);
}

async function request(env, method, path, body, isAuth, extra = {}) {
  const headers = {
    apikey: env.key,
    Authorization: `Bearer ${env.key}`,
    ...extra,
  };
  if (body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(`${env.url}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
