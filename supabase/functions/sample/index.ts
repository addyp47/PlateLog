import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildImageParts,
  generateWithRetry,
  parseJson,
  resolveModel,
  type GeminiImagePart,
} from "../_shared/gemini.ts";

// Simple per-instance sliding-window limiter to prevent accidental loops burning credits.
const recentHits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_REQ_PER_MIN = 25;

function corsHeaders(req: Request) {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = !allowed.length
    ? "*"
    : allowed.includes(origin)
    ? origin
    : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function isUserAllowed(user: { id: string; email?: string | null }) {
  const allowedIds = (Deno.env.get("ALLOWED_USER_IDS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedEmails = (Deno.env.get("ALLOWED_EMAILS") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowedIds.length && !allowedIds.includes(user.id)) return false;
  if (allowedEmails.length && !allowedEmails.includes((user.email || "").toLowerCase())) return false;
  return true;
}

function checkRateLimit(userId: string) {
  const now = Date.now();
  const hits = (recentHits.get(userId) || []).filter((ts) => now - ts < WINDOW_MS);
  if (hits.length >= MAX_REQ_PER_MIN) return false;
  hits.push(now);
  recentHits.set(userId, hits);
  return true;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json({ error: "Sign in required" }, 401, cors);
  if (!isUserAllowed(userData.user)) {
    return json({ error: "This account is not authorized for AI estimates.", code: "not_granted" }, 403, cors);
  }
  if (!checkRateLimit(userData.user.id)) {
    return json({ error: "Too many estimates in one minute. Wait a moment and try again.", code: "rate_limited" }, 429, cors);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "GEMINI_API_KEY is not set on the sample function", code: "unknown" }, 500, cors);

  let body: {
    prompt?: string;
    system?: string;
    images?: GeminiImagePart[];
    json?: boolean;
    responseSchema?: unknown;
    max_tokens?: number;
    modelTier?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, cors);
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ error: "prompt is required" }, 400, cors);

  const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
  const imgResult = buildImageParts(images);
  if ("error" in imgResult) {
    return json({ error: imgResult.error, code: imgResult.code }, imgResult.status, cors);
  }
  const parts = [...imgResult.parts, { text: prompt }];

  const system = body.system
    || (body.json
      ? "Reply with one JSON object and no markdown."
      : "You help estimate meals for a personal food log.");

  const model = resolveModel(body.modelTier);
  const result = await generateWithRetry({
    apiKey,
    model,
    system,
    parts,
    json: !!body.json,
    responseSchema: body.responseSchema,
    maxTokens: body.max_tokens,
  });

  if (!result.ok) {
    console.error("sample gemini error", {
      status: result.status,
      code: result.code,
      finishReason: result.finishReason,
      error: String(result.error || "").slice(0, 200),
    });
    return json({ error: result.error, code: result.code, ...(result.text ? { text: result.text } : {}) }, 502, cors);
  }

  if (body.json) {
    const parsed = parseJson(result.text);
    if (parsed == null) {
      console.error("sample invalid_json", { finishReason: result.finishReason, textLen: result.text.length });
      return json({ error: "Model did not return JSON", code: "invalid_json", text: result.text }, 502, cors);
    }
    return json({ text: result.text, json: parsed }, 200, cors);
  }
  return json({ text: result.text, json: null }, 200, cors);
});

function json(body: unknown, status = 200, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
