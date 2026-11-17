export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const DEFAULT_MODEL = "gemini-4-hydrogen";
export const QUICK_MODEL = "gemini-3.5-flash-lite";

export type GeminiImagePart = {
  media_type?: string;
  data?: string;
};

export type GeminiResult = {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  text: string;
  finishReason?: string;
};

export function resolveModel(modelTier?: string) {
  if (modelTier === "quick") {
    return Deno.env.get("GEMINI_MODEL_QUICK") || QUICK_MODEL;
  }
  return Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;
}

export function buildImageParts(images: GeminiImagePart[] = []) {
  const parts: unknown[] = [];
  for (const image of images) {
    const mediaType = String(image.media_type || "").toLowerCase();
    const data = String(image.data || "").replace(/^data:[^,]+,/, "");
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
      return { error: `Unsupported image type ${mediaType}`, code: "image_rejected", status: 400 };
    }
    if (!data) {
      return { error: "Image data is empty", code: "image_rejected", status: 400 };
    }
    if (data.length > 8_000_000) {
      return { error: "Image is too large", code: "image_rejected", status: 413 };
    }
    parts.push({ inline_data: { mime_type: mediaType, data } });
  }
  return { parts };
}

function buildThinkingConfig(model: string, json?: boolean, explicit?: string) {
  const m = model.toLowerCase();
  if (m.startsWith("gemini-4")) {
    return { thinkingLevel: explicit || (json ? "low" : "medium") };
  }
  if (m.startsWith("gemini-3")) {
    const defaultLevel = m.includes("lite") ? "minimal" : "low";
    return { thinkingLevel: explicit || defaultLevel };
  }
  return { thinkingBudget: 0 };
}

export async function generateWithRetry(params: {
  apiKey: string;
  model: string;
  system: string;
  parts: unknown[];
  json?: boolean;
  responseSchema?: unknown;
  maxTokens?: number;
  thinkingLevel?: string;
}) {
  const maxOutputTokens = Math.min(Number(params.maxTokens) || 4096, 8192);
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens,
    // Gemini 3/4 use thinkingLevel (thinking tokens share maxOutputTokens); Gemini 2.5 uses thinkingBudget.
    thinkingConfig: buildThinkingConfig(params.model, params.json, params.thinkingLevel),
  };
  if (params.json) {
    generationConfig.responseMimeType = "application/json";
    if (params.responseSchema && typeof params.responseSchema === "object") {
      generationConfig.responseSchema = params.responseSchema;
    }
  }
  const requestBody = {
    system_instruction: { parts: [{ text: params.system }] },
    contents: [{ role: "user", parts: params.parts }],
    generationConfig,
  };
  const first = await callGemini(params.apiKey, params.model, requestBody);
  return !first.ok && retryable(first) ? await callGemini(params.apiKey, params.model, requestBody) : first;
}

async function callGemini(apiKey: string, model: string, requestBody: unknown): Promise<GeminiResult> {
  const gemini = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    },
  );

  const payload = await gemini.json().catch(() => ({}));
  if (!gemini.ok) {
    const message = String(payload?.error?.message || `Gemini returned ${gemini.status}`);
    const depleted = gemini.status === 402 || /prepayment credits are depleted/i.test(message);
    const code = gemini.status === 429 ? "rate_limited" : depleted ? "billing" : "unknown";
    const error = depleted
      ? "The Gemini API key is out of credits. Add credits in Google AI Studio, or use a free-tier key."
      : message;
    return { ok: false, status: gemini.status, error, code, text: "" };
  }

  const candidate = (payload.candidates || [])[0] || {};
  const text = (candidate.content?.parts || [])
    .filter((part: { text?: string; thought?: boolean }) => part && part.text && !part.thought)
    .map((part: { text?: string }) => part.text || "")
    .join("\n")
    .trim();

  const blockReason = payload?.promptFeedback?.blockReason || "";
  const finishReason = candidate.finishReason || "";
  if (!text) {
    const reason = blockReason || finishReason || "empty response";
    return { ok: false, status: 502, error: `Model returned no text (${reason})`, code: "unknown", text: "", finishReason };
  }
  return { ok: true, status: 200, text, finishReason };
}

function retryable(result: GeminiResult) {
  if (result.code === "billing" || result.code === "rate_limited") return false;
  if (result.status === 429 || result.status === 402) return false;
  return result.status >= 500 || /no text|MAX_TOKENS|unavailable|overloaded|deadline|internal/i.test(String(result.error || ""));
}

export function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
