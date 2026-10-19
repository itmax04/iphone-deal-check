// Анализ фото объявления нейросетью Workers AI (бесплатный дневной лимит аккаунта).
// Модель — Mistral Small 3.1 (Apache 2.0). Llama 3.2/4 Vision не используем: их лицензии не дают права
// на мультимодальные модели лицам из ЕС (владелец живёт в Германии). Gemma 3 этому аккаунту недоступна (5018).
// Фото передаётся в запросе как data URL: по http-ссылке модель картинки Kleinanzeigen не скачивает (проверено 19.10.2026).

export const VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const MAX_PHOTOS = 4;
const SIZE_RULE = '$_59.AUTO'; // 720×960, ~170 КБ — достаточно для трещин и скриншотов

const PROMPT = `This is one photo from a used iPhone sale listing. Report ONLY what is clearly visible, do not guess.
Reply with compact JSON and nothing else:
{"phone":true|false,"screen_crack":true|false,"back_crack":true|false,"camera_glass_broken":true|false,"scratches":"none|light|heavy","dents":true|false,"battery_percent":number|null,"other":"short note or empty"}
battery_percent — only if a Settings screen with battery health (Batteriezustand / Maximum Capacity) is visible.`;

function toB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function analyzeOne(env, base) {
  const r = await fetch(`${base}?rule=${SIZE_RULE}`);
  if (!r.ok) return { error: `фото ${r.status}` };
  const dataUrl = `data:image/jpeg;base64,${toB64(await r.arrayBuffer())}`;
  const out = await env.AI.run(VISION_MODEL, {
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    max_tokens: 160, temperature: 0,
  });
  const text = String(out?.response ?? '');
  const json = text.match(/\{[\s\S]*\}/);
  try { return json ? JSON.parse(json[0]) : { other: text.slice(0, 120) }; } catch { return { other: text.slice(0, 120) }; }
}

/** Сводка по 1–4 фото: найденные проблемы, процент аккумулятора, сколько фото проверено. */
export async function analyzePhotos(env, images) {
  const list = (images || []).slice(0, MAX_PHOTOS);
  if (!env.AI || !list.length) return null;
  const results = await Promise.all(list.map((u) => analyzeOne(env, u).catch((err) => ({ error: String(err.message || err).slice(0, 80) }))));
  const ok = results.filter((x) => !x.error);
  const issues = new Set();
  let battery = null;
  for (const x of ok) {
    if (x.screen_crack) issues.add('трещина экрана (или защитного стекла)');
    if (x.back_crack) issues.add('трещина задней крышки');
    if (x.camera_glass_broken) issues.add('разбито стекло камеры');
    if (x.dents) issues.add('вмятины / погнут корпус');
    if (x.scratches === 'heavy') issues.add('сильные царапины');
    else if (x.scratches === 'light') issues.add('лёгкие царапины');
    if (typeof x.battery_percent === 'number' && x.battery_percent >= 50 && x.battery_percent <= 100) battery = x.battery_percent;
  }
  return {
    checked: ok.length,
    failed: results.length - ok.length,
    phoneSeen: ok.some((x) => x.phone !== false),
    issues: [...issues],
    serious: [...issues].some((i) => /трещина|разбито|вмятины|сильные/.test(i)),
    battery,
    notes: ok.map((x) => x.other).filter((n) => n && n.length > 3).slice(0, 2),
  };
}
