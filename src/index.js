// iPhone Deal Check: ссылка на Kleinanzeigen + цена после торга → маржа по рынку OLX.ua → покупать / торговаться / обходить.
// Только webhook Telegram, без cron. Состояние (ожидание цены, настройки, кэш OLX и курсов) — D1 `DB` (таблица kv).
import { call, sendText, escapeHtml as e } from './telegram.js';
import { adUrlFrom, adUrlsFrom, fetchAd, AdError } from './kleinanzeigen.js';
import { analyzePhotos } from './photos.js';
import { analyze, formatResult } from './analyze.js';
import { modelOf, storageOf } from './iphone.js';
import { kv } from './store.js';

const DEFAULT_MARGIN = 80; // € — как в iphone-alert-bot (/margin)
const PENDING_TTL = 3600;

const HISTORY_SIZE = 20;
const MAX_BATCH = 5;

const COMMANDS = [
  { command: 'history', description: 'Последние проверки' },
  { command: 'margin', description: 'Порог маржи для «покупать»: /margin 80' },
  { command: 'help', description: 'Как пользоваться' },
];

const HELP = `<b>Проверка iPhone с Kleinanzeigen по рынку OLX.ua</b>
1. Пришли ссылку на объявление (можно сразу с ценой: «ссылка 380»).
2. Укажи цену после торга — кнопкой или числом.
3. Получишь вердикт: ✅ покупать · 🤝 торговаться (и до какой цены) · ❌ обходить.
   Следом — 📷 проверка фото нейросетью (трещины, сколы, скриншот аккумулятора).

Несколько объявлений сразу: пришли 2–5 ссылок одним сообщением — сравню таблицей.
/history — последние проверки.

Маржа = цена быстрой продажи на OLX (нижняя четверть цен частников, по курсу НБУ) − цена покупки.
Доставку и растаможку бот не считает. Состояние оценивается по полям «Zustand», «Akkuzustand» и тексту объявления.

/margin 80 — порог маржи для «покупать» (сейчас: {margin} €)`;

async function getMargin(env) {
  return Number(await env.STATE.get('margin')) || DEFAULT_MARGIN;
}

async function getRates(env) {
  const hit = await env.STATE.get('rates', 'json');
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.rates;
  const r = await fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json');
  const rates = { UAH: 1 };
  for (const x of await r.json()) rates[x.cc] = x.rate;
  await env.STATE.put('rates', JSON.stringify({ at: Date.now(), rates }));
  return rates;
}

const priceFrom = (text) => {
  const t = String(text || '').replace(/https?:\/\/\S+/g, ' ');
  const m = t.match(/(?:^|\s)(\d{2,4})(?:[.,]\d{1,2})?\s*(?:€|eur|евро|euro)?(?=\s|$)/i);
  return m ? Number(m[1]) : null;
};

async function askPrice(env, ad) {
  const p = ad.price;
  const row = p ? [
    { text: `${p} € (как в объявлении)`, callback_data: `p:${p}` },
    { text: `−10%: ${Math.round(p * 0.9 / 5) * 5} €`, callback_data: `p:${Math.round(p * 0.9 / 5) * 5}` },
    { text: `−15%: ${Math.round(p * 0.85 / 5) * 5} €`, callback_data: `p:${Math.round(p * 0.85 / 5) * 5}` },
  ] : [];
  const model = modelOf(ad.title) || '?';
  const storage = storageOf(Object.entries(ad.details || {}).find(([k]) => /^speicher/i.test(k))?.[1] || '') || storageOf(ad.title) || '';
  await sendText(env, `📱 <b>${e(model)} ${e(storage)}</b> — ${e(ad.title.slice(0, 80))}\n💶 ${e(ad.priceText || 'цена не указана')}${ad.details?.Zustand ? ` · Zustand: ${e(ad.details.Zustand)}` : ''}\n\n<b>Цена после торга?</b> Нажми кнопку или пришли число, например <code>380</code>.`, {
    reply_markup: { inline_keyboard: row.length ? [row] : [] },
  });
}

async function runAnalysis(env, ad, price) {
  await call(env, 'sendChatAction', { action: 'typing' }).catch(() => {});
  const [rates, margin] = await Promise.all([getRates(env), getMargin(env)]);
  const r = await analyze(ad, price, { rates, margin, cache: env.STATE });
  await sendText(env, formatResult(r), {
    reply_markup: { inline_keyboard: [[{ text: '🔁 Другая цена', callback_data: 'again' }, { text: '🔗 Объявление', url: ad.url }]] },
  });
  await addHistory(env, r);
  await sendPhotoCheck(env, ad, r);
  return r;
}

// ---------- 📷 Фото: нейросеть ищет то, что продавец мог не написать (кэш по объявлению 24 ч) ----------
async function sendPhotoCheck(env, ad, r) {
  if (!env.AI || !ad.photos?.length) return;
  const key = `photos:${ad.id || ad.url}`;
  let p = await env.STATE.get(key, 'json');
  if (!p) {
    await call(env, 'sendChatAction', { action: 'upload_photo' }).catch(() => {});
    p = await analyzePhotos(env, ad.photos);
    if (!p) return;
    await env.STATE.put(key, JSON.stringify(p), { expirationTtl: 86400 });
  }
  if (!p.checked) return sendText(env, '📷 Фото проверить не получилось — посмотри их сам.', { disable_notification: true });
  const lines = [`📷 <b>Фото</b> (проверено ${p.checked} из ${ad.photos.length})`];
  if (!p.phoneSeen) lines.push('⚠️ На фото не видно самого телефона — попроси реальные фото.');
  lines.push(p.issues.length ? `${p.serious ? '⚠️' : 'ℹ️'} Видно: ${e(p.issues.join(', '))}` : '✅ Явных повреждений не видно.');
  if (p.battery) lines.push(`🔋 На скриншоте аккумулятор: ${p.battery}%${r.cond?.battery && r.cond.battery !== p.battery ? ` (в тексте ${r.cond.battery}%)` : ''}`);
  const textMentions = (r.cond?.minuses || []).some((m) => /трещины|повреждение/.test(m));
  if (p.serious && !textMentions && ['buy', 'negotiate'].includes(r.verdict)) {
    lines.push('➡️ В тексте объявления этого нет — уточни у продавца и сбивай цену: на OLX такие продаются дешевле.');
  }
  lines.push('<i>Нейросеть может ошибаться — это подсказка, а не проверка. Смотри телефон при встрече.</i>');
  return sendText(env, lines.join('\n'), { disable_notification: true });
}

// ---------- /history ----------
async function addHistory(env, r) {
  const list = (await env.STATE.get('history', 'json')) || [];
  list.unshift({ at: Date.now(), url: r.ad.url, model: r.model, storage: r.storage, price: r.buyPrice, verdict: r.verdict, profit: r.profit, maxPrice: r.maxPrice });
  await env.STATE.put('history', JSON.stringify(list.slice(0, HISTORY_SIZE)));
}

const V_ICON = { buy: '✅', negotiate: '🤝', avoid: '❌', unknown: '❔' };

async function sendHistory(env) {
  const list = (await env.STATE.get('history', 'json')) || [];
  if (!list.length) return sendText(env, 'Проверок пока нет — пришли ссылку на объявление.');
  const fmt = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(t);
  const lines = list.slice(0, 10).map((h, i) => `${i + 1}. ${V_ICON[h.verdict] || '•'} <a href="${e(h.url)}">${e(h.model || '?')} ${e(h.storage || '')}</a> · ${h.price ?? '—'} € · маржа ${h.profit != null ? `${h.profit >= 0 ? '+' : ''}${h.profit} €` : '—'}${h.maxPrice > 0 ? ` · выгодно до ${h.maxPrice} €` : ''} · <i>${fmt(h.at)}</i>`);
  return sendText(env, `<b>🗂 Последние проверки</b>\n${lines.join('\n')}`);
}

// ---------- Несколько ссылок: сравнение по цене из объявлений ----------
async function runBatch(env, urls) {
  await call(env, 'sendChatAction', { action: 'typing' }).catch(() => {});
  const [rates, margin] = await Promise.all([getRates(env), getMargin(env)]);
  const ads = await Promise.all(urls.map((u) => fetchAd(u).catch((err) => ({ error: err.message, url: u }))));
  const rows = [];
  for (const ad of ads) {
    if (ad.error) { rows.push({ ad, error: ad.error }); continue; }
    rows.push({ ad, r: await analyze(ad, ad.price, { rates, margin, cache: env.STATE }) });
  }
  const ok = rows.filter((x) => x.r);
  ok.sort((a, b) => (b.r.profit ?? -1e9) - (a.r.profit ?? -1e9));
  const best = ok.find((x) => x.r.verdict !== 'avoid' && x.r.profit != null);
  const lines = ok.map((x, i) => {
    const r = x.r;
    return `${i + 1}. ${V_ICON[r.verdict]} <a href="${e(x.ad.url)}">${e(r.model || '?')} ${e(r.storage || '')}</a> · ${x.ad.price ?? '—'} €${x.ad.negotiable ? ' VB' : ''} · маржа ${r.profit != null ? `${r.profit >= 0 ? '+' : ''}${r.profit} €` : '—'}${r.maxPrice > 0 ? ` · до ${r.maxPrice} €` : ''}${r.cond.blockers.length ? ` · ⛔ ${e(r.cond.blockers[0])}` : ''}${x === best ? ' ⭐' : ''}`;
  });
  for (const x of rows.filter((y) => y.error)) lines.push(`• не открылось: ${e(x.error)}`);
  await env.STATE.put(`batch:${env.TELEGRAM_CHAT_ID}`, JSON.stringify(ok.map((x) => x.ad)), { expirationTtl: PENDING_TTL });
  for (const x of ok) await addHistory(env, x.r);
  const buttons = ok.map((_, i) => ({ text: `🔎 ${i + 1}`, callback_data: `b:${i}` }));
  return sendText(env, `<b>📊 Сравнение ${ok.length} объявлений</b> (по цене из объявления, порог маржи ${margin} €)\n${lines.join('\n')}${best ? `\n\n⭐ Лучший вариант — №${ok.indexOf(best) + 1}.` : '\n\nВыгодных среди них нет.'}\n🔎 N — полный разбор с ценой после торга и проверкой фото.`, {
    reply_markup: { inline_keyboard: [buttons] },
  });
}

async function loadAd(env, url) {
  const ad = await fetchAd(url);
  await env.STATE.put(`pending:${env.TELEGRAM_CHAT_ID}`, JSON.stringify(ad), { expirationTtl: PENDING_TTL });
  return ad;
}

async function handleUpdate(env, update) {
  const q = update.callback_query;
  if (q) {
    if (String(q.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return;
    await call(env, 'answerCallbackQuery', { callback_query_id: q.id }, { withChat: false }).catch(() => {});
    if (q.data.startsWith('b:')) {
      const list = await env.STATE.get(`batch:${env.TELEGRAM_CHAT_ID}`, 'json');
      const picked = list?.[Number(q.data.slice(2))];
      if (!picked) return sendText(env, 'Сравнение устарело (больше часа) — пришли ссылки ещё раз.');
      await env.STATE.put(`pending:${env.TELEGRAM_CHAT_ID}`, JSON.stringify(picked), { expirationTtl: PENDING_TTL });
      return askPrice(env, picked);
    }
    const ad = await env.STATE.get(`pending:${env.TELEGRAM_CHAT_ID}`, 'json');
    if (!ad) return sendText(env, 'Объявление устарело (больше часа) — пришли ссылку ещё раз.');
    if (q.data === 'again') return askPrice(env, ad);
    if (q.data.startsWith('p:')) return runAnalysis(env, ad, Number(q.data.slice(2)));
    return;
  }
  const msg = update.message;
  if (!msg || String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  const text = msg.text || msg.caption || '';
  const [cmd, arg] = text.trim().split(/\s+/);
  if (/^\/(start|help)/.test(cmd)) return sendText(env, HELP.replace('{margin}', await getMargin(env)));
  if (/^\/margin/.test(cmd)) {
    const n = Number(arg);
    if (!arg || !(n >= 0 && n < 2000)) return sendText(env, `Сейчас порог маржи: ${await getMargin(env)} €. Пример: /margin 80`);
    await env.STATE.put('margin', String(Math.round(n)));
    return sendText(env, `Ок: «покупать» — при марже от ${Math.round(n)} €, «торговаться» — от 1 до ${Math.round(n) - 1} €.`);
  }

  if (/^\/history/.test(cmd)) return sendHistory(env);
  const urls = adUrlsFrom(text);
  if (urls.length > 1) {
    if (urls.length > MAX_BATCH) await sendText(env, `Сравню первые ${MAX_BATCH} из ${urls.length}.`);
    return runBatch(env, urls.slice(0, MAX_BATCH));
  }
  const url = adUrlFrom(text);
  const price = priceFrom(text);
  if (url) {
    let ad;
    try { ad = await loadAd(env, url); } catch (err) {
      return sendText(env, `Не смог открыть объявление: ${e(err instanceof AdError ? err.message : 'ошибка сети, попробуй ещё раз')}.`);
    }
    if (price) return runAnalysis(env, ad, price);
    return askPrice(env, ad);
  }
  if (price) {
    const ad = await env.STATE.get(`pending:${env.TELEGRAM_CHAT_ID}`, 'json');
    if (!ad) return sendText(env, 'Сначала пришли ссылку на объявление Kleinanzeigen.');
    return runAnalysis(env, ad, price);
  }
  return sendText(env, 'Пришли ссылку на объявление Kleinanzeigen (можно сразу с ценой после торга). /help');
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = { ...rawEnv, STATE: kv(rawEnv.DB) };
    const url = new URL(request.url);
    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const update = await request.json();
      ctx.waitUntil(handleUpdate(env, update).catch(async (err) => {
        console.log('update failed', err.stack || err);
        await sendText(env, `Ошибка: ${e(String(err.message || err).slice(0, 200))}`).catch(() => {});
      }));
      return new Response('ok');
    }
    if (!env.RUN_KEY || url.searchParams.get('key') !== env.RUN_KEY) return new Response('not found', { status: 404 });
    if (url.pathname === '/setup') {
      const r1 = await call(env, 'setWebhook', { url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] }, { withChat: false });
      const r2 = await call(env, 'setMyCommands', { commands: COMMANDS }, { withChat: false });
      return Response.json({ webhook: r1.ok, commands: r2.ok });
    }
    if (url.pathname === '/run') {
      // Проверка без Telegram: /run?key=…&url=<ссылка>&price=380
      const ad = await fetchAd(url.searchParams.get('url'));
      const [rates, margin] = await Promise.all([getRates(env), getMargin(env)]);
      const price = Number(url.searchParams.get('price')) || ad.price;
      const r = await analyze(ad, price, { rates, margin, cache: env.STATE });
      const photos = url.searchParams.get('photos') === '1' ? await analyzePhotos(env, ad.photos) : undefined;
      return Response.json({ verdict: r.verdict, reason: r.reason, model: r.model, storage: r.storage, cond: r.cond, base: r.base, quickEur: r.quickEur, profit: r.profit, maxPrice: r.maxPrice, details: ad.details, photos, text: formatResult(r) });
    }
    return new Response('not found', { status: 404 });
  },
};
