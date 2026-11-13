// Units: every unit belongs to a family (g, ml, u) with a factor to that base.
export const UNITS = {
  g: { f: 1, base: 'g' },
  kg: { f: 1000, base: 'g' },
  ml: { f: 1, base: 'ml' },
  l: { f: 1000, base: 'ml' },
  u: { f: 1, base: 'u' },
};
export const UNIT_LABEL = { g: 'g', kg: 'kg', ml: 'ml', l: 'L', u: 'u' };
export const FAMILY_UNITS = { g: ['g', 'kg'], ml: ['ml', 'l'], u: ['u'] };
export const FAMILY_DEFAULT = { g: 'g', ml: 'ml', u: 'u' };

// What a recipe yields. Sale price and cost are always "per 1 yield unit" (per portion, per unit, per kg…).
export const YIELD_UNITS = ['porciones', 'unidades', 'g', 'kg', 'ml', 'l'];
export const YIELD_LABEL = { porciones: 'porciones', unidades: 'unidades', g: 'g', kg: 'kg', ml: 'ml', l: 'L' };
export const YIELD_ONE = { porciones: 'porción', unidades: 'unidad', g: 'g', kg: 'kg', ml: 'ml', l: 'L' };
export const YIELD_STEP = { porciones: 1, unidades: 1, g: 100, kg: 0.5, ml: 100, l: 0.5 };

// Quantity for display: 1500 g -> "1,5 kg".
export function fmtQty(qty, unit, sub) {
  if (unit === 'g' && qty >= 1000) return `${fmtNum(qty / 1000)} kg`;
  if (unit === 'ml' && qty >= 1000) return `${fmtNum(qty / 1000)} L`;
  return `${fmtNum(qty)} ${unitLabelFor(unit, sub)}`;
}

// How a recipe's yield maps to the unit families, so another recipe can use it as a component.
export const YIELD_BASE = {
  porciones: { base: 'u', f: 1 },
  unidades: { base: 'u', f: 1 },
  g: { base: 'g', f: 1 },
  kg: { base: 'g', f: 1000 },
  ml: { base: 'ml', f: 1 },
  l: { base: 'ml', f: 1000 },
};
export const defaultUnitFor = (sub) => FAMILY_DEFAULT[YIELD_BASE[sub.yieldUnit || 'porciones'].base];
// "u" means "portions" or "units" depending on the component recipe.
export const unitLabelFor = (unit, sub) => (unit === 'u' && sub ? YIELD_LABEL[sub.yieldUnit || 'porciones'] : UNIT_LABEL[unit]);

export const family = (unit) => UNITS[unit]?.base || 'u';

// Price of one base unit (1 g, 1 ml or 1 u) of an ingredient.
export function pricePerBase(ing) {
  const base = (+ing.qty || 0) * (UNITS[ing.unit]?.f || 1);
  return base > 0 && +ing.price > 0 ? ing.price / base : 0;
}

export function itemCost(item, ing) {
  if (!ing || family(item.unit) !== family(ing.unit)) return { cost: 0, ok: false };
  const p = pricePerBase(ing);
  return { cost: (+item.qty || 0) * UNITS[item.unit].f * p, ok: p > 0 };
}

// Cost of one recipe line: an ingredient, or a share of another recipe's total cost.
export function lineCost(item, ingMap, recipeMap, stack) {
  if (!item.subId) return itemCost(item, ingMap.get(item.ingId));
  const sub = recipeMap.get(item.subId);
  if (!sub || stack.has(sub.id)) return { cost: 0, ok: false };
  const yb = YIELD_BASE[sub.yieldUnit || 'porciones'];
  if (family(item.unit) !== yb.base) return { cost: 0, ok: false };
  const a = analyze(sub, ingMap, recipeMap, new Set([...stack, sub.id]));
  const subBase = a.y * yb.f;
  return { cost: subBase > 0 ? (((+item.qty || 0) * UNITS[item.unit].f) / subBase) * a.total : 0, ok: a.missing === 0 };
}

export function analyze(recipe, ingMap, recipeMap = new Map(), stack = new Set(recipe.id ? [recipe.id] : [])) {
  let ingredients = 0;
  let missing = 0;
  for (const it of recipe.items || []) {
    const c = lineCost(it, ingMap, recipeMap, stack);
    ingredients += c.cost;
    if (!c.ok) missing++;
  }
  const total = ingredients + (+recipe.other || 0);
  const y = +recipe.yield > 0 ? +recipe.yield : 1;
  const per = total / y;
  const sale = +recipe.salePrice || 0;
  const profit = sale - per;
  return { total, per, sale, profit, margin: sale > 0 ? profit / sale : null, missing, y };
}

export function fmtNum(n, max = 2) {
  if (!isFinite(n)) return '0';
  const digits = Math.abs(n) >= 100 ? 0 : max;
  return n.toLocaleString('es', { maximumFractionDigits: digits });
}
export const fmtMoney = (n, cur) => (n < 0 ? '-' : '') + cur + fmtNum(Math.abs(n));

export const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function singular(s) {
  return s.split(' ').map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
}

// Find an existing ingredient matching a (possibly handwritten) name.
export function matchIngredient(name, ings) {
  const n = singular(norm(name));
  if (!n) return null;
  return (
    ings.find((i) => singular(norm(i.name)) === n) ||
    ings.find((i) => {
      const m = singular(norm(i.name));
      return m.length > 3 && n.length > 3 && (m.includes(n) || n.includes(m));
    }) ||
    null
  );
}
