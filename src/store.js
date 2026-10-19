// Простое хранилище «ключ → значение» на D1 (KV не используется: у API-токена аккаунта нет прав на KV).
// Интерфейс как у KV: get(key, 'json'), put(key, value, { expirationTtl }).
export function kv(db) {
  return {
    async get(key, type) {
      const r = await db.prepare('SELECT value, expires FROM kv WHERE key = ?').bind(key).first();
      if (!r || (r.expires && r.expires < Date.now())) return null;
      return type === 'json' ? JSON.parse(r.value) : r.value;
    },
    async put(key, value, { expirationTtl } = {}) {
      const expires = expirationTtl ? Date.now() + expirationTtl * 1000 : null;
      await db.prepare('INSERT INTO kv (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires')
        .bind(key, String(value), expires).run();
    },
  };
}
