// Вердикт: покупать / торговаться / обходить. Считается ТОЛЬКО маржа (решение владельца 19.10.2026):
// маржа = цена быстрой продажи на OLX (нижняя четверть цен частников, в евро по курсу НБУ) − цена покупки.
// Доставку, растаможку и прочие расходы бот не считает.
import { modelOf, storageOf, assessCondition, GRADE_LABEL } from './iphone.js';
import { olxComparables } from './olx.js';
import { escapeHtml as e } from './telegram.js';

export const MIN_COMPARABLES = 5;

export async function analyze(ad, buyPrice, { rates, margin, cache }) {
  const model = modelOf(ad.title) || modelOf(ad.description);
  const storage = storageOf(Object.entries(ad.details || {}).find(([k]) => /^speicher/i.test(k))?.[1] || '') || storageOf(ad.title) || storageOf(ad.description);
  const cond = assessCondition(ad);
  if (!model) return { ad, cond, verdict: 'unknown', reason: 'не понял модель iPhone по объявлению' };
  const market = await olxComparables(model, storage, rates, { cache });

  // Сравниваем с тем же состоянием, если таких объявлений достаточно; иначе — со всеми б/у частников.
  const sameGrade = market.byGrade?.[cond.grade];
  const base = sameGrade && sameGrade.n >= MIN_COMPARABLES ? { ...sameGrade, scope: `в состоянии «${GRADE_LABEL[cond.grade]}»` } : { ...market.private, scope: 'все б/у частников' };
  const eur = rates.EUR;
  const quickEur = base.p25 ? Math.floor(base.p25 / eur) : null;
  const medianEur = base.median ? Math.floor(base.median / eur) : null;
  const profit = quickEur != null && buyPrice != null ? quickEur - buyPrice : null;
  const maxPrice = quickEur != null ? Math.floor((quickEur - margin) / 5) * 5 : null; // цена, при которой маржа ≥ порога
  const lowData = (base.n || 0) < MIN_COMPARABLES;

  let verdict, reason;
  if (cond.blockers.length) { verdict = 'avoid'; reason = `стоп-фактор: ${cond.blockers.join(', ')}`; }
  else if (cond.scam.length) { verdict = 'avoid'; reason = `подозрительно: ${cond.scam.join(', ')}`; }
  else if (profit == null) { verdict = 'unknown'; reason = 'на OLX не нашлось похожих объявлений для сравнения'; }
  else if (profit >= margin) { verdict = 'buy'; reason = `маржа ${profit} € ≥ порога ${margin} €`; }
  else if (profit > 0 && maxPrice > 0) { verdict = 'negotiate'; reason = `маржа ${profit} € < порога ${margin} € — сбивай цену до ${maxPrice} €`; }
  else { verdict = 'avoid'; reason = profit <= 0 ? `минус ${-profit} € — дороже, чем продашь в Украине` : 'маржа слишком мала'; }

  return { ad, model, storage, cond, market, base, quickEur, medianEur, profit, maxPrice, margin, buyPrice, lowData, verdict, reason };
}

const VERDICT = { buy: '✅ <b>ПОКУПАТЬ</b>', negotiate: '🤝 <b>ТОРГОВАТЬСЯ</b>', avoid: '❌ <b>ОБХОДИТЬ СТОРОНОЙ</b>', unknown: '❔ <b>НЕ МОГУ ОЦЕНИТЬ</b>' };
const uahFmt = (x) => (x == null ? '—' : `${x.toLocaleString('uk-UA').replace(/ /g, ' ')} грн`);

export function formatResult(r) {
  const a = r.ad;
  const c = r.cond;
  const lines = [];
  lines.push(`${VERDICT[r.verdict]}\n${e(r.reason)}`);
  if (r.lowData && r.verdict !== 'avoid' && r.base?.n) lines.push(`⚠️ Мало данных: на OLX всего ${r.base.n} похожих — решай осторожно.`);
  lines.push('');
  lines.push(`📱 <b>${e(r.model || '?')} ${e(r.storage || '(память не указана)')}</b> — <a href="${e(a.url)}">объявление</a>`);
  lines.push(`💶 В объявлении: ${a.price != null ? `${a.price} €${a.negotiable ? ' VB' : ''}` : e(a.priceText || '—')} · твоя цена: <b>${r.buyPrice != null ? `${r.buyPrice} €` : '—'}</b>`);
  if (r.quickEur != null) {
    lines.push(`🇺🇦 OLX (${e(r.base.scope)}, ${r.base.n} шт.): быстрая продажа <b>${uahFmt(r.base.p25)} ≈ ${r.quickEur} €</b> · медиана ${uahFmt(r.base.median)} ≈ ${r.medianEur} €`);
    lines.push(`📊 Маржа: <b>${r.profit >= 0 ? '+' : ''}${r.profit} €</b> (порог ${r.margin} €, /margin) · выгодно до <b>${Math.max(0, r.maxPrice)} €</b>`);
  }
  lines.push('');
  lines.push(`🔎 <b>Состояние по объявлению</b>: ${e(c.zustand || 'не указано')}${c.akku ? ` · Akkuzustand: ${e(c.akku)}` : ''}${c.battery ? ` · аккумулятор ${c.battery}%` : ''} → сравниваю как «${GRADE_LABEL[c.grade]}»`);
  if (c.blockers.length) lines.push(`⛔ ${e(c.blockers.join(' · '))}`);
  if (c.scam.length) lines.push(`🚩 ${e(c.scam.join(' · '))}`);
  if (c.minuses.length) lines.push(`➖ ${e(c.minuses.join(' · '))}`);
  if (c.pluses.length) lines.push(`➕ ${e(c.pluses.join(' · '))}`);
  lines.push(`🧾 ${a.commercial ? 'магазин' : 'частник'} · ${a.shipping ? 'есть доставка' : 'только самовывоз'} · фото: ${a.images}${a.location ? ` · ${e(a.location)}` : ''}`);
  if (!c.battery) lines.push('❓ Спроси продавца процент аккумулятора (Einstellungen → Batterie → Batteriezustand).');
  if (r.verdict === 'negotiate' || (r.verdict === 'avoid' && r.maxPrice > 0 && !c.blockers.length && !c.scam.length)) {
    const offer = Math.max(5, r.maxPrice);
    lines.push('');
    lines.push(`💬 <b>Предложить продавцу</b> (нажми, чтобы скопировать):\n<pre>Hallo! Ich hätte Interesse am ${e(r.model)}. Wären Sie mit ${offer} € einverstanden? Ich könnte kurzfristig abholen und bar bezahlen.</pre>`);
  }
  if (r.market?.examples?.length) {
    lines.push('');
    lines.push(`Самые дешёвые похожие на OLX: ${r.market.examples.map((x) => `<a href="${e(x.url)}">${uahFmt(x.uah)}</a>${x.city ? ` (${e(x.city)})` : ''}`).join(' · ')}`);
  }
  lines.push('<i>Считается только маржа: доставка, растаможка и комиссии не учитываются. OLX — цены объявлений, не фактических продаж.</i>');
  return lines.join('\n');
}
