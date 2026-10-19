// Рынок Украины: похожие iPhone на OLX.ua.
// Публичный JSON сайта /api/v1/offers (проверено 19.10.2026: с серверов Cloudflare отвечает 200, с домашнего IP — 403).
// Это внутренний адрес сайта, не документированный API: запросы — только по просьбе владельца, с кэшем 6 ч.
// Раздел 85 — «Мобільні телефони»; фильтры enum в адресе дают 400 → отбор по полям ответа.
import { modelOf, storageOf } from './iphone.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const PAGES = [0, 50, 100];
const BAD_TITLE = /(запчаст|на запчастини|розбит|разбит|тріщин|трещин|icloud|айклауд|заблок|блокован|неробоч|не працює|не работает|копія|копия|реплік|реплик|муляж|корпус|чохол|чехол|тільки коробка|только коробка|обмін|обмен|куплю|викуп|выкуп|r-?sim|кредит|розстроч|рассроч)/i;
const GRADE_ORDER = ['like_new', 'very_good', 'good', 'defects', 'for_parts'];

const param = (o, key) => (o.params || []).find((p) => p.key === key)?.value;

export async function olxComparables(model, storage, rates, { cache } = {}) {
  const key = `olx:${model}:${storage || 'any'}`.toLowerCase();
  if (cache) {
    const hit = await cache.get(key, 'json');
    if (hit && Date.now() - hit.at < 6 * 3600e3) return { ...hit.data, cached: true };
  }
  const query = `${model.replace(/^iPhone/i, 'iphone')}${storage ? ` ${storage.replace(' GB', '').replace(' TB', 'tb')}` : ''}`;
  const pages = await Promise.all(PAGES.map((offset) =>
    fetch(`https://www.olx.ua/api/v1/offers/?query=${encodeURIComponent(query)}&category_id=85&limit=50&offset=${offset}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { data: [], error: r.status })).catch(() => ({ data: [], error: 'network' }))));
  if (pages.every((p) => p.error)) throw new Error(`OLX не ответил (${pages[0].error})`);

  const seen = new Set();
  const items = [];
  for (const o of pages.flatMap((p) => p.data || [])) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    if (BAD_TITLE.test(o.title)) continue;
    if (modelOf(o.title) !== model) continue;                     // точная модель: «13» ≠ «13 Pro»
    const sto = (param(o, 'storage')?.label || '').replace(/\s?ГБ/i, ' GB').replace(/\s?ТБ/i, ' TB') || storageOf(o.title);
    if (storage && sto && sto.toUpperCase() !== storage.toUpperCase()) continue;
    if (storage && !sto) continue;
    const state = param(o, 'state')?.key;
    if (state && state !== 'used') continue;                       // только б/у
    const grade = param(o, 'condition_grade')?.key || null;
    if (grade === 'defects' || grade === 'for_parts') continue;
    const price = param(o, 'price');
    if (!price?.value) continue;
    const uah = price.currency === 'UAH' ? price.value : rates?.[price.currency] ? price.value * rates[price.currency] : null;
    if (!uah) continue;
    items.push({ uah: Math.round(uah), grade, business: Boolean(o.business), url: o.url, title: o.title, city: o.location?.city?.name, negotiable: Boolean(price.negotiable) });
  }
  const data = summarize(items);
  if (cache) await cache.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: 6 * 3600 });
  return data;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
};

function stats(list) {
  const prices = list.map((x) => x.uah).sort((a, b) => a - b);
  if (!prices.length) return { n: 0 };
  // Выбросы: дешевле половины медианы (подозрительные/не то) и дороже 1.8 медианы.
  const med0 = quantile(prices, 0.5);
  const clean = prices.filter((p) => p >= med0 * 0.5 && p <= med0 * 1.8);
  return { n: clean.length, p25: quantile(clean, 0.25), median: quantile(clean, 0.5), min: clean[0], max: clean[clean.length - 1] };
}

function summarize(items) {
  // Примеры «самые дешёвые похожие» — только из очищенного диапазона (без запчастей/мошенников по цене).
  const all = items.map((x) => x.uah).sort((a, b) => a - b);
  const med = quantile(all, 0.5) || 0;
  items = items.filter((x) => x.uah >= med * 0.5 && x.uah <= med * 1.8);
  const priv = items.filter((x) => !x.business);
  const byGrade = {};
  for (const g of GRADE_ORDER.slice(0, 3)) byGrade[g] = stats(priv.filter((x) => x.grade === g));
  return {
    total: items.length,
    private: stats(priv),
    business: stats(items.filter((x) => x.business)),
    byGrade,
    examples: priv.sort((a, b) => a.uah - b.uah).slice(0, 3).map((x) => ({ uah: x.uah, title: x.title.slice(0, 60), url: x.url, city: x.city })),
  };
}
