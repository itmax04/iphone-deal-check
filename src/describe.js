// Чтение описания объявления нейросетью (Workers AI, Mistral Small 3.1 — Apache 2.0).
// Нейросеть понимает контекст немецкого текста: «стекло телекамеры разбито» — это камера, а не экран; «keine Kratzer» —
// царапин нет; «Akku bei Apple getauscht» — замена у Apple. Результат — основа оценки состояния; правила по словам
// (src/iphone.js) остаются страховкой. Кэш по объявлению — 24 ч.

export const TEXT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

const SYSTEM = `You read a used iPhone sale listing from the German site Kleinanzeigen and assess it for a buyer who wants to resell the phone.
Read the title, the structured fields and the full description. Understand negations ("keine Kratzer" = no scratches) and context
(a cracked camera lens glass is NOT a cracked screen). Use only what the listing says; never invent facts.
Reply with JSON only:
{
 "summary_ru": "2-3 short sentences in Russian: what the seller says about the phone (condition, battery, repairs, accessories, how they sell)",
 "condition": "like_new|very_good|good|defects|for_parts",
 "battery_percent": number|null,
 "defects": ["short Russian phrases for each real defect or damage mentioned"],
 "repairs": ["short Russian phrases for replaced parts / repairs, say if done by Apple"],
 "positives": ["short Russian phrases: box, receipt, warranty, AppleCare, like new, etc."],
 "blockers": ["only serious: iCloud/activation lock, network lock, not turning on, water damage, for parts, Face ID not working"],
 "red_flags": ["scam/oddity signals: payment outside protection (Vorkasse, PayPal Freunde), messenger only, wants to BUY not sell, price far too low, copy/replica"]
}
All list items must be in Russian, max 6 words each, at most 4 per list.
These are NORMAL for private sales in Germany and are NOT red flags: "Privatverkauf, keine Garantie/Rücknahme" (no warranty/return),
pickup only, no shipping, cash or PayPal Waren/Dienstleistungen, "Preis VB".
For repairs, write "у Apple" or "не у Apple" ONLY if the listing explicitly says who did it; otherwise do not mention it.
Positives are only real advantages of the phone or deal; "no warranty" is never a positive. Do not praise the seller.`;

export async function readDescription(env, ad, { cache } = {}) {
  if (!env.AI) return null;
  const key = `desc:${ad.id || ad.url}`;
  if (cache) {
    const hit = await cache.get(key, 'json');
    if (hit) return hit;
  }
  const fields = Object.entries(ad.details || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const user = `TITLE: ${ad.title}\nPRICE: ${ad.priceText || '—'}\nFIELDS:\n${fields || '—'}\nSELLER: ${ad.commercial ? 'commercial' : 'private'}, ${ad.shipping ? 'shipping possible' : 'pickup only'}\nDESCRIPTION:\n${(ad.description || '').slice(0, 2500) || '(empty)'}`;
  try {
    const out = await env.AI.run(TEXT_MODEL, {
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      max_tokens: 450, temperature: 0,
    });
    const text = String(out?.response ?? '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const arr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 6) : []);
    const res = {
      summary: String(j.summary_ru || '').slice(0, 500),
      condition: ['like_new', 'very_good', 'good', 'defects', 'for_parts'].includes(j.condition) ? j.condition : null,
      battery: typeof j.battery_percent === 'number' && j.battery_percent >= 50 && j.battery_percent <= 100 ? Math.round(j.battery_percent) : null,
      defects: arr(j.defects), repairs: arr(j.repairs), positives: arr(j.positives), blockers: arr(j.blockers), redFlags: arr(j.red_flags),
    };
    if (cache) await cache.put(key, JSON.stringify(res), { expirationTtl: 86400 });
    return res;
  } catch (err) {
    console.log('describe failed', err.message);
    return null;
  }
}
