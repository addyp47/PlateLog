import { createClient } from "./vendor/supabase.mjs";
import { PLATELOG_CONFIG } from "./config.js";

const COLLECTIONS = new Set(["settings", "days", "foods", "combos", "checkins", "coach_notes"]);
const DEFAULT_DAYS_WINDOW = 150;

export const supabase = createClient(PLATELOG_CONFIG.supabaseUrl, PLATELOG_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" },
});

const hubs = new Map();
const localWriteTimes = new Map();
const syncListeners = new Set();

let realtimeStarted = false;
let session = null;
let loadFullDaysHistory = false;
let flushingQueue = false;

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function hub(key) {
  if (!hubs.has(key)) hubs.set(key, new Set());
  return hubs.get(key);
}

function notify(key) {
  const subs = hubs.get(key);
  if (!subs) return;
  for (const emit of subs) emit();
}

function dateCutoff(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isNetworkError(err) {
  if (!navigator.onLine) return true;
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("load failed") || msg.includes("timeout");
}

function cacheKey(userId, col) {
  return `platelog.cache.v1.${userId}.${col}`;
}

function queueKey(userId) {
  return `platelog.queue.v1.${userId}`;
}

function readCache(userId, col) {
  try {
    const raw = localStorage.getItem(cacheKey(userId, col));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(userId, col, rows) {
  try {
    localStorage.setItem(cacheKey(userId, col), JSON.stringify(rows));
  } catch {
    // Ignore quota errors on localStorage cache
  }
}

function readQueue(userId) {
  try {
    const raw = localStorage.getItem(queueKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeQueue(userId, items) {
  try {
    localStorage.setItem(queueKey(userId), JSON.stringify(items));
  } catch {
    // Ignore quota errors
  }
  emitSyncStatus(userId);
}

function enqueueOp(userId, op) {
  const q = readQueue(userId).filter((x) => !(x.collection === op.collection && x.id === op.id));
  q.push({ ...op, ts: Date.now() });
  writeQueue(userId, q);
}

function emitSyncStatus(userId) {
  const pending = userId ? readQueue(userId).length : 0;
  const status = { online: navigator.onLine, pending };
  for (const cb of syncListeners) cb(status);
}

export function onSyncStatus(cb) {
  syncListeners.add(cb);
  emitSyncStatus(session?.user?.id || null);
  return () => syncListeners.delete(cb);
}

async function flushQueue() {
  if (flushingQueue || !navigator.onLine || !session?.user?.id) return;
  const userId = session.user.id;
  const queue = readQueue(userId);
  if (!queue.length) return;
  flushingQueue = true;
  try {
    const remaining = [];
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i];
      try {
        if (op.type === "set") {
          const { error } = await supabase.from("docs").upsert({
            user_id: userId,
            collection: op.collection,
            doc_id: op.id,
            data: op.value || {},
          }, { onConflict: "user_id,collection,doc_id" });
          if (error) throw error;
        } else if (op.type === "delete") {
          const { error } = await supabase.from("docs").delete().eq("user_id", userId).eq("collection", op.collection).eq("doc_id", op.id);
          if (error) throw error;
        }
        markLocalWrite(op.collection, op.id);
        notify(`doc:${op.collection}/${op.id}`);
        notify(`col:${op.collection}`);
      } catch (err) {
        if (isNetworkError(err)) {
          remaining.push(...queue.slice(i));
          break;
        }
      }
    }
    writeQueue(userId, remaining);
  } finally {
    flushingQueue = false;
  }
}

window.addEventListener("online", () => {
  emitSyncStatus(session?.user?.id || null);
  flushQueue();
});
window.addEventListener("offline", () => emitSyncStatus(session?.user?.id || null));

function markLocalWrite(collection, id) {
  const now = Date.now();
  localWriteTimes.set(`col:${collection}`, now);
  if (id) localWriteTimes.set(`doc:${collection}/${id}`, now);
}

function wasWrittenLocally(collection, id) {
  const now = Date.now();
  const colTs = localWriteTimes.get(`col:${collection}`) || 0;
  const docTs = id ? (localWriteTimes.get(`doc:${collection}/${id}`) || 0) : 0;
  return now - Math.max(colTs, docTs) < 1600;
}

async function requireUser() {
  await authReady;
  if (session?.user) return session.user;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw coded("not_granted", "Sign in required");
  return data.user;
}

function startRealtime(userId) {
  if (realtimeStarted) return;
  realtimeStarted = true;
  supabase
    .channel(`platelog-${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "docs", filter: `user_id=eq.${userId}` },
      (payload) => {
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        const collection = row?.collection;
        const docId = row?.doc_id;
        if (!collection) {
          for (const key of hubs.keys()) notify(key);
          return;
        }
        if (wasWrittenLocally(collection, docId)) return;
        if (docId) notify(`doc:${collection}/${docId}`);
        notify(`col:${collection}`);
      },
    )
    .subscribe();
}

async function signedPhoto(path) {
  if (!path || typeof path !== "string" || !path.includes("/")) return null;
  const { data, error } = await supabase.storage.from("checkins").createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data.signedUrl;
}

async function presentData(collection, data) {
  const body = data ? { ...data } : {};
  if (collection === "checkins" && body.photoId) {
    const url = await signedPhoto(body.photoId);
    if (url) body.photoUrl = url;
  }
  return body;
}

function mergeQueuedIntoRows(userId, collection, rows) {
  const q = readQueue(userId).filter((op) => op.collection === collection);
  if (!q.length) return rows;
  const map = new Map(rows.map((r) => [r.doc_id, r]));
  for (const op of q) {
    if (op.type === "delete") map.delete(op.id);
    else if (op.type === "set") map.set(op.id, { doc_id: op.id, data: op.value || {} });
  }
  return [...map.values()].sort((a, b) => (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0));
}

class DocRef {
  constructor(path) {
    const slash = String(path).indexOf("/");
    if (slash <= 0) throw new Error("Document path must look like collection/id");
    this.collection = path.slice(0, slash);
    this.id = path.slice(slash + 1);
    if (!COLLECTIONS.has(this.collection)) throw new Error(`Unknown collection ${this.collection}`);
  }

  async get() {
    const user = await requireUser();
    const pending = readQueue(user.id).find((op) => op.collection === this.collection && op.id === this.id);
    if (pending) {
      if (pending.type === "delete") return { id: this.id, exists: false, data: () => undefined };
      return { id: this.id, exists: true, data: () => pending.value || {} };
    }
    try {
      const { data, error } = await supabase.from("docs").select("data").eq("user_id", user.id).eq("collection", this.collection).eq("doc_id", this.id).maybeSingle();
      if (error) throw error;
      if (!data) return { id: this.id, exists: false, data: () => undefined };
      return { id: this.id, exists: true, data: () => data.data || {} };
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = readCache(user.id, this.collection) || [];
        const hit = cached.find((r) => r.doc_id === this.id);
        if (hit) return { id: this.id, exists: true, data: () => hit.data || {} };
      }
      throw err;
    }
  }

  async set(value) {
    const user = await requireUser();
    const payload = value || {};
    markLocalWrite(this.collection, this.id);

    // Update local cache optimistically so UI and offline reads stay consistent.
    const cached = readCache(user.id, this.collection) || [];
    const nextCache = cached.filter((r) => r.doc_id !== this.id).concat([{ doc_id: this.id, data: payload }]);
    writeCache(user.id, this.collection, nextCache);

    if (!navigator.onLine) {
      enqueueOp(user.id, { type: "set", collection: this.collection, id: this.id, value: payload });
      notify(`doc:${this.collection}/${this.id}`);
      notify(`col:${this.collection}`);
      return;
    }

    try {
      const { error } = await supabase.from("docs").upsert({
        user_id: user.id,
        collection: this.collection,
        doc_id: this.id,
        data: payload,
      }, { onConflict: "user_id,collection,doc_id" });
      if (error) throw error;
      // Remove any older queued op for this doc if direct write succeeded.
      const q = readQueue(user.id).filter((op) => !(op.collection === this.collection && op.id === this.id));
      if (q.length !== readQueue(user.id).length) writeQueue(user.id, q);
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOp(user.id, { type: "set", collection: this.collection, id: this.id, value: payload });
      } else {
        throw err;
      }
    }
    notify(`doc:${this.collection}/${this.id}`);
    notify(`col:${this.collection}`);
  }

  async update(partial) {
    const current = await this.get();
    if (!current.exists) throw coded("invalid_argument", "Document does not exist");
    await this.set({ ...current.data(), ...partial });
  }

  async delete() {
    const user = await requireUser();
    markLocalWrite(this.collection, this.id);
    const cached = readCache(user.id, this.collection) || [];
    writeCache(user.id, this.collection, cached.filter((r) => r.doc_id !== this.id));

    if (!navigator.onLine) {
      enqueueOp(user.id, { type: "delete", collection: this.collection, id: this.id });
      notify(`doc:${this.collection}/${this.id}`);
      notify(`col:${this.collection}`);
      return;
    }

    try {
      const { error } = await supabase.from("docs").delete().eq("user_id", user.id).eq("collection", this.collection).eq("doc_id", this.id);
      if (error) throw error;
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOp(user.id, { type: "delete", collection: this.collection, id: this.id });
      } else {
        throw err;
      }
    }
    notify(`doc:${this.collection}/${this.id}`);
    notify(`col:${this.collection}`);
  }

  onSnapshot(onNext, onError) {
    const key = `doc:${this.collection}/${this.id}`;
    const emit = async () => {
      try {
        onNext(await this.get());
      } catch (error) {
        if (onError) onError(error);
      }
    };
    hub(key).add(emit);
    emit();
    return () => hub(key).delete(emit);
  }
}

class CollectionRef {
  constructor(name) {
    if (!COLLECTIONS.has(name)) throw new Error(`Unknown collection ${name}`);
    this.name = name;
  }

  async getFromCache() {
    const user = await requireUser();
    const cached = readCache(user.id, this.name);
    if (!cached) return null;
    const merged = mergeQueuedIntoRows(user.id, this.name, cached);
    const docs = merged.map((row) => ({ id: row.doc_id, data: () => row.data || {} }));
    return { empty: docs.length === 0, size: docs.length, docs, metadata: { fromCache: true } };
  }

  async get() {
    const user = await requireUser();
    let query = supabase
      .from("docs")
      .select("doc_id,data")
      .eq("user_id", user.id)
      .eq("collection", this.name);
    if (this.name === "days" && !loadFullDaysHistory) {
      query = query.gte("doc_id", dateCutoff(DEFAULT_DAYS_WINDOW));
    }
    try {
      const { data, error } = await query.order("doc_id");
      if (error) throw error;
      const rows = data || [];
      writeCache(user.id, this.name, rows);
      const merged = mergeQueuedIntoRows(user.id, this.name, rows);
      const docs = [];
      for (const row of merged) {
        const body = await presentData(this.name, row.data || {});
        docs.push({ id: row.doc_id, data: () => body });
      }
      return { empty: docs.length === 0, size: docs.length, docs, metadata: { fromCache: false } };
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await this.getFromCache();
        if (cached) return cached;
      }
      throw err;
    }
  }

  async add(value) {
    const id = crypto.randomUUID();
    await new DocRef(`${this.name}/${id}`).set(value || {});
    return { id };
  }

  onSnapshot(onNext, onError) {
    const key = `col:${this.name}`;
    let firstEmit = true;
    const emit = async () => {
      if (firstEmit) {
        firstEmit = false;
        const cached = await this.getFromCache().catch(() => null);
        if (cached) onNext(cached);
      }
      try {
        onNext(await this.get());
      } catch (error) {
        if (onError) onError(error);
      }
    };
    hub(key).add(emit);
    emit();
    return () => hub(key).delete(emit);
  }
}

export const db = {
  doc(path) {
    return new DocRef(path);
  },
  collection(name) {
    return new CollectionRef(name);
  },
};

export async function loadAllDays() {
  loadFullDaysHistory = true;
  notify("col:days");
}

function bodyOf(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item)) return {};
  const keys = Object.keys(item);
  const wrapper = item.data && typeof item.data === "object" && !Array.isArray(item.data)
    && keys.every((key) => key === "id" || key === "data" || key === "path" || key === "exists");
  return wrapper ? { ...item.data } : { ...item };
}

export function parseBackupDocs(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Backup file must be a JSON object.");
  }
  const docs = [];
  if (root.settings && typeof root.settings === "object" && !Array.isArray(root.settings)) {
    const rawSettings = root.settings;
    const settingsObj = rawSettings.main && typeof rawSettings.main === "object" && !Array.isArray(rawSettings.main)
      ? rawSettings
      : ["units", "unit", "kcal", "targets", "protein", "fiber"].some((k) => k in rawSettings)
      ? { main: rawSettings }
      : rawSettings;
    for (const [doc_id, item] of Object.entries(settingsObj)) {
      docs.push({ collection: "settings", doc_id, data: bodyOf(item) });
    }
  }
  for (const col of ["days", "foods", "combos", "checkins", "coach_notes"]) {
    const value = root[col];
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const doc_id = String(item?.id || item?.date || index);
        if (col === "days" && !/^\d{4}-\d{2}-\d{2}$/.test(doc_id)) {
          throw new Error(`Day id "${doc_id}" is not YYYY-MM-DD.`);
        }
        docs.push({ collection: col, doc_id, data: bodyOf(item) });
      });
    } else if (typeof value === "object") {
      for (const [doc_id, item] of Object.entries(value)) {
        if (col === "days" && !/^\d{4}-\d{2}-\d{2}$/.test(doc_id)) {
          throw new Error(`Day id "${doc_id}" is not YYYY-MM-DD.`);
        }
        docs.push({ collection: col, doc_id, data: bodyOf(item) });
      }
    } else {
      throw new Error(`${col} must be an object or array.`);
    }
  }
  if (!docs.length) throw new Error("Backup file has no documents to import.");
  return docs;
}

export async function importBackup(root, { replace = false } = {}) {
  const user = await requireUser();
  const docs = parseBackupDocs(root);
  if (replace) {
    const { error } = await supabase.from("docs").delete().eq("user_id", user.id);
    if (error) throw error;
    for (const col of COLLECTIONS) writeCache(user.id, col, []);
  }
  const rows = docs.map((d) => ({
    user_id: user.id,
    collection: d.collection,
    doc_id: d.doc_id,
    data: d.data,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase.from("docs").upsert(chunk, { onConflict: "user_id,collection,doc_id" });
    if (error) throw error;
  }
  writeQueue(user.id, []);
  const cutoff = dateCutoff(DEFAULT_DAYS_WINDOW);
  if (docs.some((d) => d.collection === "days" && d.doc_id < cutoff)) {
    loadFullDaysHistory = true;
  }
  const counts = Object.fromEntries([...COLLECTIONS].map((c) => [c, 0]));
  for (const d of docs) {
    counts[d.collection] = (counts[d.collection] || 0) + 1;
    markLocalWrite(d.collection, d.doc_id);
  }
  notify("doc:settings/main");
  for (const col of COLLECTIONS) notify(`col:${col}`);
  return { total: docs.length, counts };
}

export async function exportBackup() {
  const user = await requireUser();
  const { data, error } = await supabase
    .from("docs")
    .select("collection,doc_id,data")
    .eq("user_id", user.id)
    .order("doc_id");
  if (error) throw error;
  const out = {
    exported: new Date().toISOString(),
    source: "platelog-pwa",
    settings: {},
    days: {},
    foods: {},
    combos: {},
    checkins: {},
    coach_notes: {},
  };
  for (const row of data || []) {
    if (!out[row.collection]) out[row.collection] = {};
    out[row.collection][row.doc_id] = row.data || {};
  }
  return out;
}

async function callSample(prompt, opts, asJson) {
  await authReady;
  const images = [];
  for (const file of opts.images || []) images.push(await normalizeImage(file, 960, 0.8));
  const body = {
    prompt,
    images,
    json: asJson,
    modelTier: opts.modelTier || "default",
  };
  if (opts.system) body.system = opts.system;
  if (opts.responseSchema) body.responseSchema = opts.responseSchema;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const { data, error } = await supabase.functions.invoke("sample", { body });
  if (error || data?.error) throw await sampleError(error, data);
  return data || {};
}

async function sample(prompt, opts = {}) {
  const data = await callSample(prompt, opts, false);
  if (opts.onText && data.text) opts.onText({ text: data.text });
  return { text: data.text || "" };
}

sample.json = async function sampleJson(prompt, opts = {}) {
  const data = await callSample(prompt, opts, true);
  if (data.json == null) throw coded("invalid_json", "The estimate came back garbled.");
  return data.json;
};

sample.limits = async function limits() {
  return {
    images: {
      mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
      maxCount: 3,
    },
  };
};

async function sampleError(error, data) {
  if (data?.code) return coded(data.code, data.error || data.code);
  let body = null;
  try {
    if (error?.context && typeof error.context.json === "function") body = await error.context.json();
  } catch {
    body = null;
  }
  if (body?.code) return coded(body.code, body.error || body.code);
  return coded("unknown", body?.error || error?.message || "Couldn't reach the estimate function");
}

async function normalizeImage(image, maxDim = 960, quality = 0.8) {
  if (image && image.media_type && image.data) {
    return { media_type: image.media_type, data: String(image.data).replace(/^data:[^,]+,/, "") };
  }
  if (!(image instanceof Blob)) throw coded("image_rejected", "That file couldn't be read.");
  let blob;
  try {
    blob = await shrinkImage(image, maxDim, quality);
  } catch {
    throw coded("image_rejected", "That photo couldn't be read. Try a JPEG or PNG, or take the picture in this app.");
  }
  if (!blob || blob.size < 32) throw coded("image_rejected", "That file couldn't be read.");
  const dataUrl = await blobToDataUrl(blob);
  const data = String(dataUrl).split(",")[1] || "";
  if (!data) throw coded("image_rejected", "That file couldn't be read.");
  return { media_type: "image/jpeg", data };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function shrinkImage(file, maxDim = 1280, quality = 0.82) {
  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("encode");
    return blob;
  } finally {
    bitmap.close?.();
  }
}

async function decodeImage(file) {
  const attempts = [];
  if (typeof createImageBitmap === "function") {
    attempts.push(() => createImageBitmap(file));
  }
  attempts.push(() => decodeWithImg(file));
  let last = null;
  for (const attempt of attempts) {
    try {
      const bitmap = await attempt();
      if (bitmap && bitmap.width && bitmap.height) return bitmap;
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("decode");
}

function decodeWithImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

export const assets = {
  async upload(file) {
    const user = await requireUser();
    // Always downscale + convert HEIC to JPEG so check-in photos stay small and render everywhere.
    let uploadBlob = file;
    try {
      uploadBlob = await shrinkImage(file, 1400, 0.84);
    } catch {
      throw coded("image_rejected", "That photo couldn't be read. Try a JPEG or PNG.");
    }
    const path = `${user.id}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage.from("checkins").upload(path, uploadBlob, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (error) {
      const err = coded(error.message?.includes("quota") ? "quota_exceeded" : "unknown", error.message || "Upload failed");
      throw err;
    }
    const url = await signedPhoto(path);
    return { id: path, url };
  },
  async fetchBase64(path) {
    if (!path) return null;
    const { data, error } = await supabase.storage.from("checkins").download(path);
    if (error || !data) return null;
    return normalizeImage(data, 1024, 0.82);
  },
};

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listKeys() {
  const user = await requireUser();
  const { data, error } = await supabase.from("api_keys").select("id,prefix,created_at,last_used_at").eq("user_id", user.id).order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createKey() {
  const user = await requireUser();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `pl_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const { error } = await supabase.from("api_keys").insert({
    user_id: user.id,
    key_hash: await sha256Hex(token),
    prefix: token.slice(0, 10),
    label: "personal",
  });
  if (error) throw error;
  return token;
}

export async function revokeKey(id) {
  const user = await requireUser();
  const { error } = await supabase.from("api_keys").delete().eq("user_id", user.id).eq("id", id);
  if (error) throw error;
}

function allowSignupUi() {
  const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  const qs = new URLSearchParams(location.search);
  return local || qs.get("signup") === "1";
}

function showAuth(message) {
  let root = document.getElementById("platelog-auth");
  if (!root) {
    root = document.createElement("div");
    root.id = "platelog-auth";
    const showSignup = allowSignupUi();
    root.innerHTML = `
      <style>
        #platelog-auth { position: fixed; inset: 0; z-index: 40; background: var(--bg, #f3f5f8); display: grid; place-items: center; padding: 24px; }
        #platelog-auth .card { width: min(420px, 100%); display: grid; gap: 12px; }
        #platelog-auth h2 { margin: 0; }
        #platelog-auth .err { color: var(--bad, #c33440); margin: 0; }
      </style>
      <div class="card">
        <form id="platelog-auth-form" style="display:grid;gap:12px">
          <h2>Sign in</h2>
          <p class="small muted" style="margin:0">Plate Log keeps one private log. Sign in with your email and password (supports Face ID / Keychain autofill).</p>
          <label class="field">Email<input id="platelog-email" type="email" autocomplete="username" required></label>
          <label class="field">Password<input id="platelog-password" type="password" autocomplete="current-password" required></label>
          <div class="row">
            <button class="btn" type="submit" id="platelog-password-btn">Sign in</button>
            ${showSignup ? '<button class="btn ghost" type="button" id="platelog-signup-btn">Create account</button>' : ""}
          </div>
        </form>
        <details>
          <summary class="small muted">Or sign in with 6-digit email code</summary>
          <div style="display:grid;gap:8px;margin-top:8px">
            <button class="btn ghost" type="button" id="platelog-magic">Send sign-in code</button>
            <div id="platelog-otp-wrap" hidden style="display:grid;gap:8px;padding-top:4px;border-top:1px solid var(--line, #d5dbe4)">
              <label class="field">6-digit code from email<input id="platelog-otp" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" placeholder="123456"></label>
              <button class="btn" type="button" id="platelog-otp-btn">Verify code</button>
            </div>
          </div>
        </details>
        <p class="small err" id="platelog-auth-err" hidden></p>
        <p class="small muted" id="platelog-auth-note" hidden></p>
      </div>`;
    document.body.appendChild(root);
    root.querySelector("#platelog-auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      await passwordAuth(false);
    });
    const signupBtn = root.querySelector("#platelog-signup-btn");
    if (signupBtn) signupBtn.onclick = () => passwordAuth(true);

    root.querySelector("#platelog-magic").onclick = async () => {
      const email = root.querySelector("#platelog-email").value.trim();
      setAuthError("");
      if (!email) {
        setAuthError("Enter your email above first.");
        root.querySelector("#platelog-email").focus();
        return;
      }
      setAuthNote("Sending code…");
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: showSignup,
          emailRedirectTo: `${location.origin}${location.pathname}`,
        },
      });
      if (error) {
        setAuthNote("");
        const msg = String(error.message || "");
        setAuthError(/rate limit/i.test(msg)
          ? "Email rate limit reached (2/hr on Supabase built-in mail). Use your password above instead."
          : msg);
      } else {
        setAuthNote("Check your email for the 6-digit code (or tap the link if in the same browser).");
        const otpWrap = document.getElementById("platelog-otp-wrap");
        if (otpWrap) {
          otpWrap.hidden = false;
          document.getElementById("platelog-otp")?.focus();
        }
      }
    };

    const verifyOtp = async () => {
      const email = document.getElementById("platelog-email").value.trim();
      const token = document.getElementById("platelog-otp").value.trim();
      setAuthError("");
      if (!email || !token) {
        setAuthError("Enter your email and the 6-digit code.");
        return;
      }
      setAuthNote("Verifying…");
      const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (error) {
        setAuthNote("");
        setAuthError(error.message);
      }
    };
    root.querySelector("#platelog-otp-btn").onclick = verifyOtp;
    root.querySelector("#platelog-otp").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        verifyOtp();
      }
    });
  }
  if (message) setAuthError(message);
  root.hidden = false;
}

function setAuthError(text) {
  const el = document.getElementById("platelog-auth-err");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

function setAuthNote(text) {
  const el = document.getElementById("platelog-auth-note");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

async function passwordAuth(signUp) {
  const email = document.getElementById("platelog-email").value.trim();
  const password = document.getElementById("platelog-password").value;
  setAuthError("");
  setAuthNote(signUp ? "Creating account…" : "Signing in…");
  if (!email || !password) {
    setAuthNote("");
    setAuthError("Enter an email and a password.");
    return;
  }
  const result = signUp
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });
  if (result.error) {
    setAuthNote("");
    setAuthError(result.error.message);
  } else if (signUp && !result.data.session) {
    setAuthNote("Account created. If confirmation is on, use the email link. Otherwise sign in.");
  }
}

function hideAuth() {
  const root = document.getElementById("platelog-auth");
  if (root) root.hidden = true;
}

export async function signOut() {
  await supabase.auth.signOut();
  location.reload();
}

export function getUserEmail() {
  return session?.user?.email || "";
}

let resolveAuth;
export const authReady = new Promise((resolve) => { resolveAuth = resolve; });

supabase.auth.onAuthStateChange((event, next) => {
  if (next) {
    session = next;
    hideAuth();
    startRealtime(next.user.id);
    emitSyncStatus(next.user.id);
    flushQueue();
    resolveAuth(next);
  } else if (event === "SIGNED_OUT") {
    session = null;
  }
});

supabase.auth.getSession().then(({ data, error }) => {
  if (error) showAuth(error.message);
  else if (data.session) {
    session = data.session;
    startRealtime(data.session.user.id);
    emitSyncStatus(data.session.user.id);
    flushQueue();
    resolveAuth(data.session);
  } else {
    showAuth();
  }
}).catch((error) => showAuth(error.message || "Couldn't reach Supabase."));

const api = {
  async use(name) {
    await authReady;
    if (name === "db") return db;
    if (name === "sample") return sample;
    if (name === "assets") return assets;
    throw new Error(`Unknown capability ${name}`);
  },
  db,
  sample,
  assets,
  supabase,
  listKeys,
  createKey,
  revokeKey,
  signOut,
  getUserEmail,
  onSyncStatus,
  loadAllDays,
  importBackup,
  exportBackup,
};

window.platelog = api;
