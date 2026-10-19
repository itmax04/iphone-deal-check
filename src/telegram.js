// Отправка сообщений в Telegram.

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Вызов Bot API. chat_id и HTML-разметка подставляются, если метод их принимает. */
export async function call(env, method, payload, { withChat = true } = {}) {
  const body = withChat ? { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: 'HTML', ...payload } : payload;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data;
}

export function sendText(env, text, extra = {}) {
  return call(env, 'sendMessage', { text, link_preview_options: { is_disabled: true }, ...extra });
}

/** Объявление с фото. Если фото не загрузилось, отправляем текст. silent — без звука. */
export async function sendItem(env, text, image, replyMarkup, silent) {
  const extra = { reply_markup: replyMarkup, disable_notification: Boolean(silent) };
  if (image) {
    try {
      return await call(env, 'sendPhoto', { photo: image, caption: text, ...extra });
    } catch {
      // Telegram не смог скачать картинку — не страшно.
    }
  }
  return call(env, 'sendMessage', { text, link_preview_options: { is_disabled: true }, ...extra });
}
