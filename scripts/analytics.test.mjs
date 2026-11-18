import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addDays, analyze, dayNum } from "../shared/analytics.js";
import { countExport } from "./export-shape.mjs";

function day(weight, kcal, extra = {}) {
  return {
    weight,
    complete: extra.complete !== false,
    energy_out: extra.energy_out ?? null,
    foods: kcal ? [{ n: "meal", kcal, p: 40, f: 8 }] : [],
    lifts: {},
  };
}

test("gap-adjusted trend matches the page formula", () => {
  const days = {
    "2026-11-01": day(180, 0),
    "2026-11-03": day(182, 0),
  };
  const summary = analyze(days, "2026-11-03");
  assert.equal(dayNum("2026-11-03") - dayNum("2026-11-01"), 2);
  const expected = 180 + (1 - Math.pow(0.9, 2)) * (182 - 180);
  assert.equal(summary.trendWeight, Math.round(expected * 10) / 10);
  assert.equal(summary.series.length, 2);
  assert.equal(summary.series[1].t, expected);
});

test("maintenance uses complete days and 500 kcal per lb/week", () => {
  const today = "2026-11-14";
  const days = {};
  for (let i = 0; i < 14; i++) {
    const date = addDays("2026-11-01", i);
    days[date] = day(180 - i * 0.1, 2000, { energy_out: 2500 });
  }
  const summary = analyze(days, today);
  assert.ok(summary.rateDetail.n >= 10);
  assert.ok(Math.abs(summary.ratePerWeek - (-0.7)) < 1e-9);
  assert.equal(summary.maintenance, 2350);
  assert.equal(summary.energyOutAvg, 2500);
});

test("incomplete days and a short history do not invent a TDEE", () => {
  const days = {};
  for (let i = 0; i < 8; i++) days[addDays("2026-11-01", i)] = day(180, 2000, { complete: false });
  assert.equal(analyze(days, "2026-11-08").maintenance, null);
  assert.equal(analyze({ "2026-11-01": day(180, 2000) }, "2026-11-01").ratePerWeek, null);
});

test("shared analytics matches the edge-function copy", () => {
  const a = readFileSync(new URL("../shared/analytics.js", import.meta.url), "utf8");
  const b = readFileSync(new URL("../supabase/functions/_shared/analytics.js", import.meta.url), "utf8");
  assert.equal(a, b);
});

test("export shape is one object keyed by collection", () => {
  const root = {
    exported: "2026-11-17T00:00:00.000Z",
    source: "platelog-artifact",
    settings: { main: { targets: { kcal: 2700, protein: 150, fiber: 35, goal: "cut" }, exercises: [], dishes: [] } },
    days: { "2026-11-01": { date: "2026-11-01", weight: 172.4, complete: true, foods: [{ n: "Oats", kcal: 300, p: 10, f: 6 }], lifts: {} } },
    foods: { f1: { n: "Chicken breast, cooked", kcal: 165, p: 31, f: 0, u: "g" } },
    combos: { c1: { n: "Breakfast", items: [{ n: "Oats", kcal: 300, p: 10, f: 6 }] } },
    checkins: {},
  };
  const { counts } = countExport(root);
  assert.deepEqual(counts, { settings: 1, days: 1, foods: 1, combos: 1, checkins: 0 });
});

test("analyze aggregates 7-day and overall daily steps", () => {
  const days = {
    "2026-11-01": { ...day(175, 2200), steps: 6000 },
    "2026-11-10": { ...day(174, 2200), steps: 8000 },
    "2026-11-12": { ...day(173.8, 2200), steps: 10000 },
  };
  const summary = analyze(days, "2026-11-12");
  assert.equal(summary.stepsAvg7, 9000);
  assert.equal(summary.stepsAvg, 8000);
  assert.equal(summary.stepsDays, 3);
});
