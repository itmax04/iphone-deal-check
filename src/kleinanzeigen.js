// Объявление Kleinanzeigen: загрузка страницы и разбор (строковые операции — лимит CPU 10 мс).
// Поля страницы (проверено 19.10.2026 с серверов Cloudflare): viewad-title, viewad-price, viewad-description-text,
// список addetailslist (Zustand, Akkuzustand, Speicherkapazität…), галерея, «Versand möglich», «Gewerblicher Anbieter».

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const decode = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();

export class AdError extends Error {}

const IMG_RE = /https:\/\/img\.kleinanzeigen\.de\/api\/v1\/prod-ads\/images\/[0-9a-f]{2}\/[0-9a-f-]{36}/g;
/** Фото из галереи самого объявления (без «похожих объявлений» ниже на странице), базовые адреса без ?rule. */
function galleryPhotos(html) {
  const a = html.indexOf('galleryimage-element');
  const b = html.lastIndexOf('galleryimage-element');
  if (a < 0) return [];
  return [...new Set(html.slice(a, b + 3000).match(IMG_RE) || [])].slice(0, 20);
}

/** Все ссылки на объявления в сообщении (без повторов). */
export function adUrlsFrom(text) {
  const found = String(text || '').match(/https?:\/\/(?:www\.|m\.)?kleinanzeigen\.de\/s-anzeige\/[^\s<>"]+/gi) || [];
  return [...new Set(found.map((u) => u.replace(/^http:/, 'https:').replace('//m.', '//www.').replace(/[).,]+$/, '')))];
}

/** Ссылка на объявление из текста сообщения (в т.ч. пересланного из приложения Kleinanzeigen). */
export function adUrlFrom(text) {
  const m = String(text || '').match(/https?:\/\/(?:www\.|m\.)?kleinanzeigen\.de\/s-anzeige\/[^\s<>"]+/i)
    || String(text || '').match(/https?:\/\/(?:www\.)?kleinanzeigen\.de\/[^\s<>"]*?(\d{9,11})[^\s<>"]*/i);
  if (!m) return null;
  return m[0].replace(/^http:/, 'https:').replace('//m.', '//www.').replace(/[).,]+$/, '');
}

export async function fetchAd(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' }, redirect: 'follow' });
  if (r.status === 404 || r.status === 410) throw new AdError('объявление удалено или ссылка неверна');
  if (!r.ok) throw new AdError(`Kleinanzeigen ответил ${r.status}`);
  const page = await r.text();
  // Регулярные выражения — только по блоку объявления (страница ~240 КБ, блок ~60–120 КБ): экономия CPU.
  const start = Math.max(0, page.indexOf('galleryimage-element') - 2000);
  const tIdx = page.indexOf('id="viewad-title"');
  const from = tIdx >= 0 ? Math.min(start, tIdx) : start;
  const html = page.slice(from, from + 140000);
  const title = decode((html.match(/<h1[^>]*id="viewad-title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
  if (!title) throw new AdError('не нашёл объявление на странице (возможно, удалено)');
  const priceText = decode((html.match(/id="viewad-price"[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
  const priceNum = priceText.match(/([\d.]+)\s*€/);
  const description = decode((html.match(/id="viewad-description-text"[^>]*>([\s\S]*?)<\/p>/) || [])[1]).slice(0, 3000);
  const details = {};
  for (const m of html.matchAll(/<li class="addetailslist--detail">([\s\S]*?)<span class="addetailslist--detail--value"[^>]*>([\s\S]*?)<\/span>/g)) {
    details[decode(m[1])] = decode(m[2]);
  }
  const id = (r.url.match(/\/(\d{9,11})-/) || url.match(/\/(\d{9,11})-/) || [])[1] || null;
  return {
    id,
    url: r.url || url,
    title,
    price: priceNum ? Number(priceNum[1].replace(/\./g, '')) : null,
    negotiable: /VB/.test(priceText),
    priceText,
    description,
    details,
    images: (html.match(/galleryimage-element/g) || []).length,
    photos: galleryPhotos(html),
    shipping: html.includes('Versand möglich'),
    commercial: html.includes('Gewerblicher Anbieter') || html.includes('gewerblicher Anbieter'),
    location: decode((html.match(/id="viewad-locality"[^>]*>([\s\S]*?)<\/span>/) || [])[1]),
    posted: decode((html.match(/id="viewad-extra-info"[\s\S]*?<span>([\d.]{8,10})<\/span>/) || [])[1]),
  };
}
