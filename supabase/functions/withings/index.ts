import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const KG_TO_LB = 2.20462262185;
const WITHINGS_AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
const WITHINGS_OAUTH_URL = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/measure";
const WITHINGS_NOTIFY_URL = "https://wbsapi.withings.net/notify";

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
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Vary": "Origin",
  };
}

function getWithingsConfig(req: Request) {
  const clientId = (Deno.env.get("WITHINGS_CLIENT_ID") || "").trim();
  const clientSecret = (Deno.env.get("WITHINGS_CLIENT_SECRET") || Deno.env.get("WITHINGS_CONSUMER_SECRET") || "").trim();
  const baseUrl = (Deno.env.get("SUPABASE_URL") || new URL(req.url).origin).replace(/\/$/, "");
  const fnUrl = `${baseUrl}/functions/v1/withings`;
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    callbackUrl: fnUrl,
    webhookUrl: fnUrl,
  };
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function getAuthedUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // Withings verifies webhook reachability with an HTTP HEAD request before registering a subscription.
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: cors });

  const url = new URL(req.url);
  const cfg = getWithingsConfig(req);
  const service = serviceClient();

  if (req.method === "GET") {
    if (url.searchParams.has("code") || url.searchParams.has("error")) {
      return await handleOAuthCallback(url, cfg, service);
    }
    return json({ ok: true, service: "withings", configured: cfg.configured }, 200, cors);
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    // Unauthenticated POSTs from Withings carry push notifications (form-urlencoded userid + appli).
    return await handleWebhookNotification(req, url, cfg, service, cors);
  }

  const user = await getAuthedUser(req);
  if (!user) return json({ error: "Sign in required" }, 401, cors);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = String(body.action || "status");

  try {
    if (action === "status") {
      const { data: conn } = await service
        .from("withings_connections")
        .select("withings_user_id,last_synced_at,last_meas_at,webhook_callback,last_error,scope")
        .eq("user_id", user.id)
        .maybeSingle();
      return json({
        configured: cfg.configured,
        callbackUrl: cfg.callbackUrl,
        webhookUrl: cfg.webhookUrl,
        connected: Boolean(conn),
        withingsUserId: conn?.withings_user_id || null,
        lastSyncedAt: conn?.last_synced_at || null,
        lastMeasAt: conn?.last_meas_at || null,
        webhookActive: Boolean(conn?.webhook_callback && conn.webhook_callback === cfg.webhookUrl),
        lastError: conn?.last_error || null,
        scope: conn?.scope || null,
      }, 200, cors);
    }

    if (action === "connect") {
      if (!cfg.configured) {
        return json({ error: "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are not configured on Supabase yet." }, 400, cors);
      }
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const returnTo = sanitizeReturnTo(String(body.returnTo || ""));
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

      await service.from("withings_oauth_states").delete().lt("expires_at", new Date().toISOString());
      const { error: stateErr } = await service.from("withings_oauth_states").insert({
        state,
        user_id: user.id,
        return_to: returnTo,
        expires_at: expiresAt,
      });
      if (stateErr) return json({ error: stateErr.message }, 500, cors);

      const authUrl = new URL(WITHINGS_AUTH_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", cfg.clientId);
      authUrl.searchParams.set("scope", "user.metrics");
      authUrl.searchParams.set("redirect_uri", cfg.callbackUrl);
      authUrl.searchParams.set("state", state);

      return json({ authUrl: authUrl.toString() }, 200, cors);
    }

    if (action === "sync") {
      if (!cfg.configured) return json({ error: "Withings API credentials are not configured." }, 400, cors);
      const daysBack = Math.min(365, Math.max(1, Number(body.days) || 90));
      const result = await syncForUser(service, cfg, user.id, { daysBack, ensureWebhook: true });
      return json(result, 200, cors);
    }

    if (action === "disconnect") {
      const { data: conn } = await service
        .from("withings_connections")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (conn && cfg.configured) {
        try {
          const fresh = await ensureFreshToken(service, cfg, conn);
          await withingsPost(WITHINGS_NOTIFY_URL, {
            action: "revoke",
            callbackurl: cfg.webhookUrl,
            appli: "1",
          }, fresh.access_token);
        } catch {
          // Proceed with local disconnect even if remote revoke fails.
        }
      }
      await service.from("withings_connections").delete().eq("user_id", user.id);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: `Unknown action: ${action}` }, 400, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Withings request failed";
    return json({ error: message }, 400, cors);
  }
});

async function handleOAuthCallback(
  url: URL,
  cfg: ReturnType<typeof getWithingsConfig>,
  service: ReturnType<typeof serviceClient>,
) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const oauthErr = url.searchParams.get("error") || "";

  if (!state) return htmlResponse("Withings sign-in error", "Missing OAuth state parameter.", 400);

  const { data: stateRow, error: stateErr } = await service
    .from("withings_oauth_states")
    .select("*")
    .eq("state", state)
    .maybeSingle();

  if (stateRow) {
    await service.from("withings_oauth_states").delete().eq("state", state);
  }
  if (stateErr || !stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) {
    return htmlResponse("Session expired", "Your Withings sign-in link expired. Return to Plate Log and tap Connect Withings again.", 400);
  }

  const returnTo = sanitizeReturnTo(stateRow.return_to);
  if (oauthErr || !code) {
    return redirectOrHtml(returnTo, { withings: oauthErr || "cancelled" }, "Withings sign-in was cancelled.");
  }
  if (!cfg.configured) {
    return redirectOrHtml(returnTo, { withings: "error", reason: "missing_credentials" }, "Withings API credentials are missing on Supabase.");
  }

  const tokenResp = await withingsPost(WITHINGS_OAUTH_URL, {
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.callbackUrl,
  });

  if (tokenResp.status !== 0 || !tokenResp.body?.access_token || !tokenResp.body?.refresh_token) {
    const reason = tokenResp.error || `status_${tokenResp.status}`;
    return redirectOrHtml(returnTo, { withings: "error", reason }, `Withings token exchange failed (${reason}).`);
  }

  const b = tokenResp.body as Record<string, unknown>;
  const expiresSec = Math.max(60, Number(b.expires_in) || 10800);
  const withingsUserId = String(b.userid ?? "");
  const nowIso = new Date().toISOString();

  const { error: upsertErr } = await service.from("withings_connections").upsert({
    user_id: stateRow.user_id,
    withings_user_id: withingsUserId,
    access_token: String(b.access_token),
    refresh_token: String(b.refresh_token),
    expires_at: new Date(Date.now() + expiresSec * 1000).toISOString(),
    scope: String(b.scope || "user.metrics"),
    last_error: null,
    updated_at: nowIso,
  }, { onConflict: "user_id" });

  if (upsertErr) {
    return redirectOrHtml(returnTo, { withings: "error", reason: "save_failed" }, `Couldn't save Withings connection: ${upsertErr.message}`);
  }

  try {
    await syncForUser(service, cfg, stateRow.user_id, { daysBack: 90, ensureWebhook: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "sync_failed";
    await service.from("withings_connections").update({ last_error: msg, updated_at: new Date().toISOString() }).eq("user_id", stateRow.user_id);
  }

  return redirectOrHtml(returnTo, { withings: "connected" }, "Withings connected! You can return to Plate Log.");
}

async function handleWebhookNotification(
  req: Request,
  url: URL,
  cfg: ReturnType<typeof getWithingsConfig>,
  service: ReturnType<typeof serviceClient>,
  cors: Record<string, string>,
) {
  const params = new Map<string, string>();
  for (const [k, v] of url.searchParams.entries()) params.set(k, v);
  try {
    const raw = await req.text();
    if (raw) {
      if (raw.trim().startsWith("{")) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) params.set(k, String(v ?? ""));
      } else {
        for (const [k, v] of new URLSearchParams(raw).entries()) params.set(k, v);
      }
    }
  } catch {
    // Empty body is fine when Withings sends a webhook check or query-only payload.
  }

  const wid = String(params.get("userid") || "").trim();
  if (!wid) return json({ ok: true }, 200, cors);

  const { data: conn } = await service
    .from("withings_connections")
    .select("*")
    .eq("withings_user_id", wid)
    .maybeSingle();
  if (!conn) return json({ ok: true }, 200, cors);

  const startNum = Number(params.get("startdate"));
  const endNum = Number(params.get("enddate"));
  const startdate = Number.isFinite(startNum) && startNum > 0 ? startNum - 86400 : undefined;
  const enddate = Number.isFinite(endNum) && endNum > 0 ? endNum + 86400 : undefined;

  try {
    await syncForUser(service, cfg, conn.user_id, { daysBack: 14, startdate, enddate, ensureWebhook: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "webhook sync failed";
    await service.from("withings_connections").update({ last_error: msg, updated_at: new Date().toISOString() }).eq("user_id", conn.user_id);
  }
  return json({ ok: true }, 200, cors);
}

async function syncForUser(
  service: ReturnType<typeof serviceClient>,
  cfg: ReturnType<typeof getWithingsConfig>,
  userId: string,
  opts: { daysBack: number; startdate?: number; enddate?: number; ensureWebhook?: boolean },
) {
  const { data: initialConn, error: connErr } = await service
    .from("withings_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (connErr) throw new Error(connErr.message);
  if (!initialConn) throw new Error("Withings account is not connected.");

  let conn = await ensureFreshToken(service, cfg, initialConn);
  if (opts.ensureWebhook && conn.webhook_callback !== cfg.webhookUrl) {
    conn = await ensureWebhookSubscription(service, cfg, conn);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const startdate = opts.startdate ?? (nowSec - opts.daysBack * 86400);
  const enddate = opts.enddate ?? (nowSec + 86400);

  const allGroups: Array<Record<string, unknown>> = [];
  let timezone = "UTC";
  let offset: number | undefined = undefined;

  for (let page = 0; page < 12; page++) {
    const params: Record<string, string> = {
      action: "getmeas",
      meastypes: "1,6",
      category: "1",
      startdate: String(Math.floor(startdate)),
      enddate: String(Math.ceil(enddate)),
    };
    if (offset != null) params.offset = String(offset);

    let measResp = await withingsPost(WITHINGS_MEASURE_URL, params, conn.access_token);
    if (measResp.status === 401 || measResp.status === 277) {
      conn = await refreshConnectionToken(service, cfg, conn);
      measResp = await withingsPost(WITHINGS_MEASURE_URL, params, conn.access_token);
    }
    if (measResp.status !== 0) {
      throw new Error(measResp.error || `Withings getmeas failed (status ${measResp.status})`);
    }
    const body = (measResp.body || {}) as Record<string, unknown>;
    if (typeof body.timezone === "string" && body.timezone) timezone = body.timezone;
    if (Array.isArray(body.measuregrps)) {
      allGroups.push(...(body.measuregrps as Array<Record<string, unknown>>));
    }
    if (body.more && typeof body.offset === "number") {
      offset = body.offset;
    } else {
      break;
    }
  }

  const byDate = parseMeasureGroups(allGroups, timezone);
  const dates = Object.keys(byDate).sort();
  let syncedDays = 0;
  let latestMeasSec = 0;
  let latestDate: string | null = null;
  let latestWeight: number | null = null;
  let latestBodyFat: number | null = null;

  for (const date of dates) {
    const entry = byDate[date];
    const patch: Record<string, unknown> = {};
    if (entry.weight != null) patch.weight = entry.weight;
    if (entry.body_fat != null) patch.body_fat = entry.body_fat;
    if (!Object.keys(patch).length) continue;

    const { error: patchErr } = await service.rpc("patch_day_fields", {
      p_date: date,
      p_patch: patch,
      p_user_id: userId,
    });
    if (patchErr) throw new Error(patchErr.message);
    syncedDays++;
    if (entry.ts >= latestMeasSec) latestMeasSec = entry.ts;
    latestDate = date;
    if (entry.weight != null) latestWeight = entry.weight;
    if (entry.body_fat != null) latestBodyFat = entry.body_fat;
  }

  const nowIso = new Date().toISOString();
  await service.from("withings_connections").update({
    last_synced_at: nowIso,
    ...(latestMeasSec > 0 ? { last_meas_at: new Date(latestMeasSec * 1000).toISOString() } : {}),
    last_error: null,
    updated_at: nowIso,
  }).eq("user_id", userId);

  return {
    ok: true,
    syncedDays,
    latestDate,
    latestWeight,
    latestBodyFat,
    webhookActive: Boolean(conn.webhook_callback === cfg.webhookUrl),
  };
}

function parseMeasureGroups(groups: Array<Record<string, unknown>>, timezone: string) {
  const sorted = [...groups].sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  const byDate: Record<string, { weight?: number; body_fat?: number; ts: number }> = {};

  for (const grp of sorted) {
    if (Number(grp.category ?? 1) !== 1) continue;
    const sec = Number(grp.date || 0);
    if (!Number.isFinite(sec) || sec <= 0) continue;
    const dateStr = formatDateInTz(sec * 1000, timezone);
    const measures = Array.isArray(grp.measures) ? grp.measures as Array<Record<string, unknown>> : [];
    let weight: number | undefined;
    let bodyFat: number | undefined;

    for (const m of measures) {
      const type = Number(m.type);
      const rawVal = Number(m.value);
      const unit = Number(m.unit);
      if (!Number.isFinite(rawVal) || !Number.isFinite(unit)) continue;
      const actual = rawVal * Math.pow(10, unit);
      if (type === 1) {
        const lb = Math.round(actual * KG_TO_LB * 10) / 10;
        if (lb >= 40 && lb <= 700) weight = lb;
      } else if (type === 6) {
        const pct = Math.round(actual * 10) / 10;
        if (pct >= 3 && pct <= 70) bodyFat = pct;
      }
    }

    if (weight == null && bodyFat == null) continue;
    const prev = byDate[dateStr] || { ts: 0 };
    byDate[dateStr] = {
      weight: weight ?? prev.weight,
      body_fat: bodyFat ?? prev.body_fat,
      ts: Math.max(prev.ts, sec),
    };
  }
  return byDate;
}

function formatDateInTz(ms: number, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

async function ensureFreshToken(
  service: ReturnType<typeof serviceClient>,
  cfg: ReturnType<typeof getWithingsConfig>,
  conn: Record<string, unknown>,
) {
  const expiresAt = new Date(String(conn.expires_at || 0)).getTime();
  // Refresh proactively if within 15 minutes of expiry.
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 15 * 60_000) {
    return conn;
  }
  return await refreshConnectionToken(service, cfg, conn);
}

async function refreshConnectionToken(
  service: ReturnType<typeof serviceClient>,
  cfg: ReturnType<typeof getWithingsConfig>,
  conn: Record<string, unknown>,
) {
  const resp = await withingsPost(WITHINGS_OAUTH_URL, {
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: String(conn.refresh_token || ""),
  });

  if (resp.status !== 0 || !resp.body?.access_token || !resp.body?.refresh_token) {
    const msg = `Withings token refresh failed (status ${resp.status}). Reconnect Withings in Targets.`;
    await service.from("withings_connections").update({ last_error: msg, updated_at: new Date().toISOString() }).eq("user_id", conn.user_id);
    throw new Error(msg);
  }

  const b = resp.body as Record<string, unknown>;
  const expiresSec = Math.max(60, Number(b.expires_in) || 10800);
  const next = {
    access_token: String(b.access_token),
    refresh_token: String(b.refresh_token),
    expires_at: new Date(Date.now() + expiresSec * 1000).toISOString(),
    scope: String(b.scope || conn.scope || "user.metrics"),
    last_error: null,
    updated_at: new Date().toISOString(),
  };

  await service.from("withings_connections").update(next).eq("user_id", conn.user_id);
  return { ...conn, ...next };
}

async function ensureWebhookSubscription(
  service: ReturnType<typeof serviceClient>,
  cfg: ReturnType<typeof getWithingsConfig>,
  conn: Record<string, unknown>,
) {
  try {
    const resp = await withingsPost(WITHINGS_NOTIFY_URL, {
      action: "subscribe",
      callbackurl: cfg.webhookUrl,
      appli: "1",
      comment: "PlateLog",
    }, String(conn.access_token));
    if (resp.status === 0) {
      const next = { webhook_appli: 1, webhook_callback: cfg.webhookUrl, updated_at: new Date().toISOString() };
      await service.from("withings_connections").update(next).eq("user_id", conn.user_id);
      return { ...conn, ...next };
    }
  } catch {
    // Subscription failure is non-fatal; manual sync still works cleanly.
  }
  return conn;
}

async function withingsPost(endpoint: string, form: Record<string, string>, accessToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(form),
  });
  return await res.json().catch(() => ({ status: res.status || 500, error: "Invalid JSON from Withings" }));
}

function sanitizeReturnTo(raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.toString();
  } catch {
    // Ignore invalid return URLs.
  }
  return "";
}

function redirectOrHtml(returnTo: string, params: Record<string, string>, fallbackMsg: string) {
  if (returnTo) {
    const u = new URL(returnTo);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: u.toString() } });
  }
  return htmlResponse("Withings", fallbackMsg, 200);
}

function htmlResponse(title: string, message: string, status = 200) {
  const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] || c));
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:440px;margin:64px auto;padding:0 20px;line-height:1.5"><h2>${escHtml(title)}</h2><p>${escHtml(message)}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
