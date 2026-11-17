// Accepts a PlateLog artifact export:
// {
//   exported, source,            // metadata, ignored
//   settings: { main: { ... } }, // one document, keyed "main"
//   days: { "YYYY-MM-DD": { ... } },
//   foods: { "<id>": { ... } },
//   combos: { "<id>": { ... } },
//   checkins: { "<id>": { ... } }  // may be empty
// }
// Collection values may also be arrays of { id, ...fields }.

export const COLLECTIONS = ["settings", "days", "foods", "combos", "checkins"];

const DATE_ID = /^\d{4}-\d{2}-\d{2}$/;

export function assertExportShape(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Export must be one JSON object.");
  }
  for (const key of COLLECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(root, key)) {
      throw new Error(`Export is missing top-level "${key}".`);
    }
  }
  if (root.settings != null && (typeof root.settings !== "object" || Array.isArray(root.settings))) {
    throw new Error('settings must be an object, usually { "main": { ... } }.');
  }
  for (const key of ["days", "foods", "combos", "checkins"]) {
    const value = root[key];
    if (value == null) continue;
    if (typeof value !== "object") throw new Error(`${key} must be an object keyed by document id.`);
  }
}

export function documentsFromExport(root) {
  assertExportShape(root);
  const docs = [];
  const settings = normalizeSettings(root.settings || {});
  for (const [id, item] of Object.entries(settings)) {
    docs.push({ collection: "settings", doc_id: id, data: bodyOf(item) });
  }
  for (const collection of ["days", "foods", "combos", "checkins"]) {
    for (const doc of collectionEntries(collection, root[collection])) {
      if (collection === "days" && !DATE_ID.test(doc.doc_id)) {
        throw new Error(`Day id "${doc.doc_id}" is not YYYY-MM-DD.`);
      }
      docs.push(doc);
    }
  }
  return docs;
}

function normalizeSettings(settings) {
  if (settings.main && typeof settings.main === "object" && !Array.isArray(settings.main)) {
    return settings;
  }
  const marker = ["units", "unit", "kcal", "kcalTarget", "calories", "protein", "proteinTarget", "fat", "fatTarget"];
  if (marker.some((key) => Object.prototype.hasOwnProperty.call(settings, key))) {
    return { main: settings };
  }
  return settings;
}

function collectionEntries(collection, value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => ({
      collection,
      doc_id: String(item?.id || item?.date || index),
      data: bodyOf(item),
    }));
  }
  return Object.entries(value).map(([id, item]) => ({
    collection,
    doc_id: id,
    data: bodyOf(item),
  }));
}

function bodyOf(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item)) return {};
  const keys = Object.keys(item);
  const wrapper = item.data && typeof item.data === "object" && !Array.isArray(item.data)
    && keys.every((key) => key === "id" || key === "data" || key === "path" || key === "exists");
  if (wrapper) return { ...item.data };
  return { ...item };
}

export function countExport(root) {
  const docs = documentsFromExport(root);
  const counts = Object.fromEntries(COLLECTIONS.map((name) => [name, 0]));
  for (const doc of docs) counts[doc.collection] += 1;
  return { counts, docs };
}
