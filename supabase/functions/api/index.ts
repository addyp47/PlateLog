import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { addDays, analyze, dayTotals, todayStr } from "../_shared/analytics.js";
import {
  buildImageParts,
  generateWithRetry,
  parseJson,
  resolveModel,
} from "../_shared/gemini.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const QUICK_LOG_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    kcal: { type: "NUMBER" },
    protein: { type: "NUMBER" },
    fiber: { type: "NUMBER" },
    assumptions: { type: "STRING" },
    error: { type: "STRING", nullable: true },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const path = normalizePath(url.pathname);
  if (req.method === "GET" && (path === "/" || path === "/health")) return json({ ok: true, service: "platelog" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing bearer token" }, 401);

  const service = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const keyHash = await sha256Hex(token);
  const { data: keyRow, error: keyError } = await service.from("api_keys").select("id,user_id").eq("key_hash", keyHash).maybeSingle();
  if (keyError) return json({ error: keyError.message }, 500);
  if (!keyRow) return json({ error: "Invalid API key" }, 401);
  service.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyRow.id).then(() => {});

  try {
    const userId = keyRow.user_id as string;
    if (req.method === "POST" && path === "/entries") return json(await addEntry(service, userId, await req.json()));
    if (req.method === "POST" && path === "/log") return json(await estimateAndLog(service, userId, await req.json()));
    if (req.method === "POST" && path === "/weight") return json(await setWeight(service, userId, await req.json()));
    if (req.method === "POST" && path === "/steps") return json(await setSteps(service, userId, await req.json()));
    if (req.method === "POST" && path === "/health") return json(await syncHealth(service, userId, await req.json()));
    if (req.method === "POST" && path === "/complete") return json(await setComplete(service, userId, await req.json()));
    if (req.method === "GET" && path === "/days") return json(await readDays(service, userId, url));
    if (req.method === "GET" && path === "/foods") return json(await readFoods(service, userId));
    if (req.method === "GET" && path === "/summary") return json(await readSummary(service, userId, url));
    return json({ error: `No route ${req.method} ${path}` }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return json({ error: error instanceof Error ? error.message : "Bad request" }, status);
  }
});

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizePath(pathname: string) {
  let path = pathname.replace(/\/+$/, "") || "/";
  const at = path.lastIndexOf("/api");
  if (at >= 0) path = path.slice(at + "/api".length) || "/";
  return path || "/";
}

async function addEntry(service: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const date = assertDate(body.date || todayStr());
  const food = foodFromBody(body);
  if (!food.n) throw new HttpError(400, "name is required");
  const saved = await appendDayFood(service, userId, date, food);
  return { ok: true, food, day: saved };
}

async function estimateAndLog(service: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new HttpError(500, "GEMINI_API_KEY is not set");

  const text = String(body.text || body.description || "").trim();
  const date = assertDate(body.date || todayStr());
  const rest = body.restaurant === true;
  const imageData = typeof body.image_base64 === "string" ? body.image_base64 : "";
  const imageMediaType = String(body.image_media_type || "image/jpeg").toLowerCase();

  if (!text && !imageData) {
    throw new HttpError(400, "Provide text or image_base64");
  }

  const [{ data: foodRows }, { data: settingsRow }] = await Promise.all([
    service.from("docs").select("data").eq("user_id", userId).eq("collection", "foods"),
    service.from("docs").select("data").eq("user_id", userId).eq("collection", "settings").eq("doc_id", "main").maybeSingle(),
  ]);

  const savedFoods = (foodRows || []).map((r) => r.data).filter((f) => f && f.n);
  const myFoodsBlock = savedFoods.length
    ? `\nThe person's saved foods (use exact numbers if matched):\n` +
      savedFoods
        .slice(0, 60)
        .map((f) => `- ${f.n}: ${f.kcal} kcal, ${f.p} g protein, ${f.f} g fiber${f.u === "g" ? " per 100 g" : ""}`)
        .join("\n")
    : "";

  const dishes = Array.isArray(settingsRow?.data?.dishes) ? settingsRow.data.dishes.filter((d: { n?: string; in?: number }) => d?.n && +d?.in > 0) : [];
  const dishBlock = dishes.length
    ? ` Known dishes for scale: ${dishes.map((d: { n: string; in: number }) => `${d.n} (${d.in} in)`).join(", ")}.`
    : "";

  const prompt = `Estimate the nutrition of this consumable entry (food, drink, milk, shake, condiment, or supplement).${text ? ` Entry: ${JSON.stringify(text)}.` : " Estimate the meal or drink shown in the photo."}${myFoodsBlock}${dishBlock}${
    rest ? " Restaurant/takeout meal: match chain nutrition if known, otherwise assume restaurant portions with extra oil/butter." : ""
  }
Third macro is FIBER (g), not fat. Assume common US brands and typical single adult portions when amounts aren't specified.
Reply with JSON: {"name": short label, "kcal": number, "protein": number, "fiber": number, "assumptions": short string, "error": null}. Drinks, coffee, milk, and shakes count as food — only set "error":"not food" for gibberish or non-consumables.`;

  const images = imageData ? [{ media_type: imageMediaType, data: imageData }] : [];
  const imgResult = buildImageParts(images);
  if ("error" in imgResult) throw new HttpError(imgResult.status, imgResult.error);

  const model = resolveModel("default");
  const result = await generateWithRetry({
    apiKey,
    model,
    system: "Reply with one JSON object and no markdown.",
    parts: [...imgResult.parts, { text: prompt }],
    json: true,
    responseSchema: QUICK_LOG_SCHEMA,
  });

  if (!result.ok) throw new HttpError(502, result.error || "Gemini estimate failed");
  const parsed = parseJson(result.text) as Record<string, unknown> | null;
  const parsedErr = modelErrorText(parsed?.error);
  if (!parsed || parsedErr || !Number.isFinite(Number(parsed.kcal))) {
    throw new HttpError(422, parsedErr || "Could not estimate food");
  }

  const food = foodFromBody({
    name: String(parsed.name || text || "Logged meal").slice(0, 90),
    kcal: Math.round(Number(parsed.kcal)),
    protein: Math.round((Number(parsed.protein) || 0) * 10) / 10,
    fiber: Math.round((Number(parsed.fiber) || 0) * 10) / 10,
    rest,
  });

  const savedDay = await appendDayFood(service, userId, date, food);
  const totals = dayTotals(savedDay);
  const targets = settingsRow?.data?.targets || { kcal: 2700, protein: 150, fiber: 35 };

  return {
    ok: true,
    date,
    added: food,
    assumptions: String(parsed.assumptions || ""),
    totals,
    remaining: {
      kcal: Math.round((targets.kcal || 0) - totals.kcal),
      protein: Math.round(((targets.protein || 0) - totals.protein) * 10) / 10,
      fiber: Math.round(((targets.fiber || 0) - totals.fiber) * 10) / 10,
    },
  };
}

async function setWeight(service: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const date = assertDate(body.date || todayStr());
  const weight = finite(body.weight, NaN);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 700) throw new HttpError(400, "weight must be a positive number");
  const patch: Record<string, unknown> = { weight: Math.round(weight * 10) / 10 };
  if (body.energy_out === null) patch.energy_out = null;
  else if (body.energy_out != null && body.energy_out !== "") patch.energy_out = finite(body.energy_out, NaN);
  if (body.steps === null) patch.steps = null;
  else if (body.steps != null && body.steps !== "") {
    const steps = finite(body.steps, NaN);
    if (!Number.isFinite(steps) || steps < 0 || steps > 200000) throw new HttpError(400, "steps must be between 0 and 200000");
    patch.steps = Math.round(steps);
  }
  return { ok: true, day: await patchDayFields(service, userId, date, patch) };
}

async function setSteps(service: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const date = assertDate(body.date || todayStr());
  const patch: Record<string, unknown> = {};
  if (body.steps === null) {
    patch.steps = null;
  } else {
    const rawSteps = body.steps ?? body.count ?? body.value;
    const steps = finite(rawSteps, NaN);
    if (!Number.isFinite(steps) || steps < 0 || steps > 200000) throw new HttpError(400, "steps must be between 0 and 200000");
    patch.steps = Math.round(steps);
  }
  if (body.energy_out === null) patch.energy_out = null;
  else if (body.energy_out != null && body.energy_out !== "") {
    const eout = finite(body.energy_out, NaN);
    if (!Number.isFinite(eout) || eout < 0 || eout > 20000) throw new HttpError(400, "energy_out must be a non-negative number");
    patch.energy_out = Math.round(eout);
  }
  return { ok: true, day: await patchDayFields(service, userId, date, patch) };
}

function healthPatchFromEntry(entry: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (entry.steps === null) patch.steps = null;
  else if (entry.steps != null && entry.steps !== "") {
    const steps = finite(entry.steps, NaN);
    if (!Number.isFinite(steps) || steps < 0 || steps > 200000) throw new HttpError(400, "steps must be between 0 and 200000");
    patch.steps = Math.round(steps);
  }
  if (entry.weight === null) patch.weight = null;
  else if (entry.weight != null && entry.weight !== "") {
    const weight = finite(entry.weight, NaN);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 700) throw new HttpError(400, "weight must be a positive number");
    patch.weight = Math.round(weight * 10) / 10;
  }
  const rawOut = entry.energy_out ?? entry.active_kcal;
  if (rawOut === null) patch.energy_out = null;
  else if (rawOut != null && rawOut !== "") {
    const eout = finite(rawOut, NaN);
    if (!Number.isFinite(eout) || eout < 0 || eout > 20000) throw new HttpError(400, "energy_out must be a non-negative number");
    patch.energy_out = Math.round(eout);
  }
  return patch;
}

async function syncHealth(service: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  if (Array.isArray(body.entries)) {
    const list = body.entries.slice(0, 90);
    if (!list.length) throw new HttpError(400, "entries must not be empty");
    const updated: Record<string, unknown>[] = [];
    for (const item of list) {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const date = assertDate(entry.date || todayStr());
      const patch = healthPatchFromEntry(entry);
      if (!Object.keys(patch).length) continue;
      updated.push(await patchDayFields(service, userId, date, patch));
    }
    if (!updated.length) throw new HttpError(400, "Provide at least one of steps, weight, or energy_out");
    return { ok: true, count: updated.length, days: updated };
  }
  const date = assertDate(body.date || todayStr());
  const patch = healthPatchFromEntry(body);
  if (!Object.keys(patch).length) throw new HttpError(400, "Provide at least one of steps, weight, or energy_out");
  return { ok: true, day: await patchDayFields(service, userId, date, patch) };
}

async function setComplete(service: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const date = assertDate(body.date || todayStr());
  return { ok: true, day: await patchDayFields(service, userId, date, { complete: body.complete !== false }) };
}

async function readDays(service: ReturnType<typeof createClient>, userId: string, url: URL) {
  const from = assertDate(url.searchParams.get("from"));
  const to = assertDate(url.searchParams.get("to"));
  if (from > to) throw new HttpError(400, "from is after to");
  const { data, error } = await service.from("docs").select("doc_id,data,energy_out").eq("user_id", userId).eq("collection", "days").gte("doc_id", from).lte("doc_id", to).order("doc_id");
  if (error) throw new HttpError(500, error.message);
  return { days: (data || []).map((row) => ({ date: row.doc_id, ...(row.data || {}), energy_out: row.data?.energy_out ?? row.energy_out ?? null })) };
}

async function readFoods(service: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await service.from("docs").select("doc_id,data").eq("user_id", userId).eq("collection", "foods").order("doc_id");
  if (error) throw new HttpError(500, error.message);
  return { foods: (data || []).map((row) => ({ id: row.doc_id, ...(row.data || {}) })) };
}

async function readSummary(service: ReturnType<typeof createClient>, userId: string, url: URL) {
  const today = url.searchParams.get("today") || todayStr();
  assertDate(today);
  // 180-day window gives accurate EMA seed + 21-day slope without scanning unbounded history.
  const lookbackFrom = addDays(today, -180);
  const [{ data: dayRows, error: dayError }, { data: settingsRow, error: settingsError }] = await Promise.all([
    service.from("docs").select("doc_id,data").eq("user_id", userId).eq("collection", "days").gte("doc_id", lookbackFrom).lte("doc_id", today),
    service.from("docs").select("data").eq("user_id", userId).eq("collection", "settings").eq("doc_id", "main").maybeSingle(),
  ]);
  if (dayError) throw new HttpError(500, dayError.message);
  if (settingsError) throw new HttpError(500, settingsError.message);
  const days: Record<string, unknown> = {};
  for (const row of dayRows || []) days[row.doc_id] = row.data || {};
  const stats = analyze(days, today);
  const targets = settingsRow?.data?.targets || null;
  const todayDoc = days[today] as Record<string, unknown> | undefined;
  const todayStats = dayTotals(todayDoc);
  return {
    today,
    units: "lb",
    targets,
    todayTotals: todayStats,
    todaySteps: typeof todayDoc?.steps === "number" ? todayDoc.steps : null,
    trendWeight: stats.trendWeight,
    trendDate: stats.trendDate,
    scaleWeight: stats.scaleWeight,
    ratePerWeek: stats.ratePerWeek,
    rateDetail: stats.rateDetail,
    maintenance: stats.maintenance,
    energyOutAvg: stats.energyOutAvg,
    energyOutDays: stats.energyOutDays,
    stepsAvg7: stats.stepsAvg7,
    stepsAvg: stats.stepsAvg,
    stepsDays: stats.stepsDays,
  };
}

function foodFromBody(body: Record<string, unknown>) {
  const food: Record<string, unknown> = {
    n: String(body.name || body.n || "").trim(),
    kcal: finite(body.kcal, 0),
    p: finite(body.protein ?? body.p, 0),
    f: finite(body.fiber ?? body.f, 0),
  };
  if (body.fat != null && body.fat !== "") food.fat = finite(body.fat, 0);
  if (body.grams != null && body.grams !== "") food.g = finite(body.grams, 0);
  if (body.rest === true) food.rest = true;
  if (body.left === true) food.left = true;
  if (Array.isArray(body.items)) {
    food.items = body.items.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        n: String(row.name || row.n || "").trim(),
        g: row.grams == null && row.g == null ? null : finite(row.grams ?? row.g, 0),
        kcal: finite(row.kcal, 0),
        p: finite(row.protein ?? row.p, 0),
        f: finite(row.fiber ?? row.f, 0),
      };
    });
  }
  return food;
}

async function appendDayFood(service: ReturnType<typeof createClient>, userId: string, date: string, food: Record<string, unknown>) {
  const { data, error } = await service.rpc("append_day_food", {
    p_date: date,
    p_food: food,
    p_user_id: userId,
  });
  if (!error && data) return data as Record<string, unknown>;
  // Fallback if migration 000001 has not been applied yet.
  const day = await loadDay(service, userId, date);
  const foods = Array.isArray(day.foods) ? [...day.foods, food] : [food];
  return await saveDay(service, userId, date, { ...day, foods });
}

async function patchDayFields(service: ReturnType<typeof createClient>, userId: string, date: string, patch: Record<string, unknown>) {
  const { data, error } = await service.rpc("patch_day_fields", {
    p_date: date,
    p_patch: patch,
    p_user_id: userId,
  });
  if (!error && data) return data as Record<string, unknown>;
  const day = await loadDay(service, userId, date);
  return await saveDay(service, userId, date, { ...day, ...patch });
}

async function loadDay(service: ReturnType<typeof createClient>, userId: string, date: string) {
  const { data, error } = await service.from("docs").select("data").eq("user_id", userId).eq("collection", "days").eq("doc_id", date).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  const body = data?.data || {};
  return {
    date,
    foods: Array.isArray(body.foods) ? body.foods : [],
    lifts: body.lifts && typeof body.lifts === "object" ? body.lifts : {},
    weight: typeof body.weight === "number" ? body.weight : null,
    complete: body.complete === true,
    energy_out: typeof body.energy_out === "number" ? body.energy_out : null,
    ...body,
  };
}

async function saveDay(service: ReturnType<typeof createClient>, userId: string, date: string, data: Record<string, unknown>) {
  const payload = { ...data, date };
  const { error } = await service.from("docs").upsert({
    user_id: userId,
    collection: "days",
    doc_id: date,
    data: payload,
  }, { onConflict: "user_id,collection,doc_id" });
  if (error) throw new HttpError(500, error.message);
  return payload;
}

function assertDate(value: unknown) {
  const raw = String(value || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  return date;
}

function finite(value: unknown, fallback: number) {
  const cleaned = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  const n = typeof cleaned === "number" ? cleaned : cleaned === "" ? NaN : Number(cleaned);
  if (!Number.isFinite(n)) {
    if (Number.isNaN(fallback)) throw new HttpError(400, "Expected a number");
    return fallback;
  }
  return n;
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function modelErrorText(value: unknown) {
  const s = value == null ? "" : String(value).trim();
  return !s || /^(none|null|n\/a|na|no|no error|false|ok|-)$/i.test(s) ? "" : s;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
