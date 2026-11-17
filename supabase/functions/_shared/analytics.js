// Same math as the Plate Log page (trendSeries, rateLbWk, maintenance).
// The page keeps those functions inline. This copy is what the external API runs.
// Units are pounds. Fiber is the third macro (`f`), not fat.
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
  function trendSeries() {
    const pts = weighIns();
    let ema = null;
    let prev = null;
    const out = [];
    for (const p of pts) {
      if (ema === null) ema = p.w;
      else {
        const gap = dayNum(p.s) - dayNum(prev);
        ema = ema + (1 - Math.pow(0.9, gap)) * (p.w - ema);
      }
      prev = p.s;
      out.push({ s: p.s, w: p.w, t: ema });
    }
    return out;
  }
  function rateLbWk(windowDays = 21) {
    const end = today;
    const start = addDays(end, -windowDays);
    const pts = weighIns().filter((p) => p.s > start && p.s <= end);
    if (pts.length < 6) return null;
    const xs = pts.map((p) => dayNum(p.s));
    const ys = pts.map((p) => p.w);
    const mx = avg(xs);
    const my = avg(ys);
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (ys[i] - my);
      den += (x - mx) ** 2;
    });
    if (!den) return null;
    return { rate: (num / den) * 7, n: pts.length };
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
    const r = rateLbWk(21);
    const logged = nutritionWindow(21).filter((d) => days[d.s] && days[d.s].complete);
    if (!r || r.n < 10 || logged.length < 10) return null;
    return Math.round((avg(logged.map((d) => d.kcal)) - r.rate * 500) / 10) * 10;
  }
  const tr = trendSeries();
  const last = tr[tr.length - 1] || null;
  const rate = rateLbWk();
  const outs = sortedDates().filter((s) => typeof days[s].energy_out === "number");
  return {
    units: "lb",
    trendWeight: last ? Math.round(last.t * 10) / 10 : null,
    trendDate: last ? last.s : null,
    scaleWeight: last ? last.w : null,
    ratePerWeek: rate ? rate.rate : null,
    rateDetail: rate,
    maintenance: maintenance(),
    series: tr,
    energyOutAvg: outs.length ? Math.round(avg(outs.map((s) => days[s].energy_out))) : null,
    energyOutDays: outs.length,
  };
}
