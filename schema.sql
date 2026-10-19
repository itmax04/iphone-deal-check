-- D1 для iphone-deal-check: настройки (/margin), ожидание цены, кэш OLX (6 ч) и курсов НБУ (12 ч).
CREATE TABLE IF NOT EXISTS kv (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  expires INTEGER            -- мс; NULL — без срока
);
