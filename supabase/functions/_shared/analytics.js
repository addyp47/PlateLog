// Shared analytics module used by the web app, external API, and tests.
// Units are pounds. Macros: p = protein (g), c = carbs (g), fat = fat (g), f = fiber (g).
// maintenance = nearest 10 kcal of (average intake on complete days in the last
// 21 days) minus (21-day scale-weight slope, lb/week) * 500.
// It stays null until there are 10 weigh-ins and 10 complete days in that window.

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function parse(s) {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

export function dayNum(s) {
  return Math.round(parse(s).getTime() / 86400000);
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);

export function asDayMap(input) {
  if (!input) return {};
  if (Array.isArray(input)) {
    const map = {};
    for (const day of input) {
      const id = String(day.id || day.doc_id || day.date || "").slice(0, 10);
      if (!id) continue;
      map[id] = day.data && !day.foods && !day.weight ? day.data : (day.data || day);
    }
    return map;
  }
  const keys = Object.keys(input);
  if (keys.length && keys.every((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))) return input;
  return {};
}

export function dayTotals(day) {
  const foods = (day && day.foods) || [];
  return {
    kcal: sum(foods.map((x) => +x.kcal || 0)),
    protein: sum(foods.map((x) => +x.p || 0)),
    carbs: sum(foods.map((x) => +x.c || 0)),
    fat: sum(foods.map((x) => +x.fat || 0)),
    fiber: sum(foods.map((x) => +x.f || 0)),
    n: foods.length,
  };
}

export function analyze(daysInput, today = todayStr()) {
  const days = asDayMap(daysInput);
  const sortedDates = () => Object.keys(days).sort();
  function weighIns() {
    return sortedDates()
      .filter((s) => typeof days[s].weight === "number")
      .map((s) => ({ s, w: days[s].weight }));
  }
  function bodyFats() {
    return sortedDates()
      .filter((s) => typeof days[s].body_fat === "number")
      .map((s) => ({ s, bf: days[s].body_fat }));
  }
  function emaSeries(pts, key) {
    let ema = null;
    let prev = null;
    const out = [];
    for (const p of pts) {
      const val = p[key];
      if (ema === null) ema = val;
      else {
        const gap = dayNum(p.s) - dayNum(prev);
        ema = ema + (1 - Math.pow(0.9, gap)) * (val - ema);
      }
      prev = p.s;
      out.push({ ...p, t: ema });
    }
    return out;
  }
  function linearRatePerWeek(pts, key, windowDays = 21) {
    const end = today;
    const start = addDays(end, -windowDays);
    const sub = pts.filter((p) => p.s > start && p.s <= end);
    if (sub.length < 6) return null;
    const xs = sub.map((p) => dayNum(p.s));
    const ys = sub.map((p) => p[key]);
    const mx = avg(xs);
    const my = avg(ys);
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (ys[i] - my);
      den += (x - mx) ** 2;
    });
    if (!den) return null;
    return { rate: (num / den) * 7, n: sub.length };
  }
  function nutritionWindow(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const s = addDays(today, -i);
      const t = dayTotals(days[s]);
      if (t.n) out.push({ s, ...t });
    }
    return out;
  }
  function maintenance() {
    const r = linearRatePerWeek(weighIns(), "w", 21);
    const logged = nutritionWindow(21).filter((d) => days[d.s] && days[d.s].complete);
    if (!r || r.n < 10 || logged.length < 10) return null;
    return Math.round((avg(logged.map((d) => d.kcal)) - r.rate * 500) / 10) * 10;
  }
  const tr = emaSeries(weighIns(), "w");
  const bfTr = emaSeries(bodyFats(), "bf");
  const last = tr[tr.length - 1] || null;
  const lastBf = bfTr[bfTr.length - 1] || null;
  const rate = linearRatePerWeek(tr, "w", 21);
  const bfRate = linearRatePerWeek(bfTr, "bf", 21);
  const win7Start = addDays(today, -6);
  const outs = sortedDates().filter((s) => typeof days[s].energy_out === "number");
  const out7 = outs.filter((s) => s >= win7Start && s <= today);
  const stepAll = sortedDates().filter((s) => typeof days[s].steps === "number");
  const step7 = stepAll.filter((s) => s >= win7Start && s <= today);
  const leanMass = last && lastBf ? Math.round(last.t * (1 - lastBf.t / 100) * 10) / 10 : null;
  const fatMass = last && lastBf ? Math.round(last.t * (lastBf.t / 100) * 10) / 10 : null;
  return {
    units: "lb",
    trendWeight: last ? Math.round(last.t * 10) / 10 : null,
    trendDate: last ? last.s : null,
    scaleWeight: last ? last.w : null,
    ratePerWeek: rate ? rate.rate : null,
    rateDetail: rate,
    maintenance: maintenance(),
    series: tr,
    scaleBodyFat: lastBf ? Math.round(lastBf.bf * 10) / 10 : null,
    trendBodyFat: lastBf ? Math.round(lastBf.t * 10) / 10 : null,
    bodyFatDate: lastBf ? lastBf.s : null,
    bodyFatDays: bfTr.length,
    bodyFatRatePerWeek: bfRate ? bfRate.rate : null,
    bodyFatRateDetail: bfRate,
    bfSeries: bfTr,
    leanMass,
    fatMass,
    nutritionWindow,
    energyOutAvg: outs.length ? Math.round(avg(outs.map((s) => days[s].energy_out))) : null,
    energyOutAvg7: out7.length ? Math.round(avg(out7.map((s) => days[s].energy_out))) : null,
    energyOutDays: outs.length,
    stepsAvg7: step7.length ? Math.round(avg(step7.map((s) => days[s].steps))) : null,
    stepsAvg: stepAll.length ? Math.round(avg(stepAll.map((s) => days[s].steps))) : null,
    stepsDays: stepAll.length,
  };
}
