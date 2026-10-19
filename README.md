# iPhone Deal Check — стоит ли покупать iPhone с Kleinanzeigen для перепродажи в Украине

> **TL;DR (EN):** Telegram bot (Cloudflare Worker, webhook only). Send a Kleinanzeigen iPhone ad link and the negotiated
> price → the bot parses the ad (model, storage, condition fields «Zustand»/«Akkuzustand», description red flags), pulls
> comparable used iPhones from OLX.ua, and answers **buy / negotiate (with max price and a German message) / avoid**
> based on margin only: OLX quick-sale price (lower quartile of private sellers, NBU rate) − purchase price.

## Как пользоваться

1. Пришли боту ссылку на объявление (можно сразу с ценой: `https://www.kleinanzeigen.de/s-anzeige/... 380`).
2. Укажи цену после торга: кнопки «как в объявлении / −10% / −15%» или число.
3. Ответ: ✅ **покупать** (маржа ≥ порога) · 🤝 **торговаться** (маржа 1…порог−1 → «выгодно до X €» + фраза продавцу на немецком) ·
   ❌ **обходить** (минус, стоп-фактор или подозрение на обман). «🔁 Другая цена» — пересчитать.
4. `/margin 80` — порог маржи (по умолчанию 80 €, как в iphone-alert-bot).

## Как считается

| Шаг | Как |
|---|---|
| Объявление | `src/kleinanzeigen.js`: заголовок, цена (VB), описание, поля `addetailslist` (Zustand, Akkuzustand, Speicher (GB)…), фото, доставка, частник/магазин |
| Состояние | `src/iphone.js`: Zustand → категория OLX (Neu→like_new, Sehr gut→very_good, Gut/In Ordnung→good, Defekt→defects); аккумулятор из поля/текста; ⛔ стоп-факторы (iCloud/сеть, defekt/Bastler/Wasserschaden, Face ID); ➖ минусы (трещины, повреждения, царапины, неоригинальные запчасти, замена аккумулятора, < 80%, мало фото) — при серьёзных минусах сравнение на ступень ниже; ➕ плюсы (коробка, чек, гарантия, «wie neu», ≥ 90%); 🚩 обман (Vorkasse, PayPal Freunde, мессенджеры, объявление «Suche/Kaufe») |
| Рынок Украины | `src/olx.js`: `olx.ua/api/v1/offers` (раздел 85), 3 страницы по 50; та же модель (13 ≠ 13 Pro), та же память, только б/у, без defects/for_parts и «запчастини/iCloud/копія…»; выбросы < 0.5 и > 1.8 медианы отбрасываются; кэш 6 ч |
| Цена продажи | нижняя четверть (p25) цен **частников** в той же категории состояния (если ≥ 5 объявлений), иначе все б/у частников; в евро по курсу НБУ (кэш 12 ч) |
| Маржа | p25 € − цена покупки. **Доставка, растаможка, комиссии не учитываются** (решение владельца 19.10.2026) |

Ограничения: на OLX — цены объявлений, а не продаж; по редким моделям мало данных (бот предупреждает при < 5);
`/api/v1/offers` — внутренний адрес сайта OLX, может измениться.

## Устройство

```
src/index.js        webhook Telegram, сценарий «ссылка → цена → вердикт», /margin, /setup, /run (проверка без Telegram)
src/kleinanzeigen.js страница объявления Kleinanzeigen
src/iphone.js       модель, память, аккумулятор, оценка состояния
src/olx.js          похожие объявления OLX.ua и статистика
src/analyze.js      маржа, вердикт, текст ответа
src/store.js        «KV» на D1 (у API-токена аккаунта нет прав на KV)
schema.sql          таблица kv
```

Работает на аккаунте Cloudflare **lashkevych049** (как freelance-radar-bot), https://iphone-deal-check.lashkevych049.workers.dev,
D1 `iphone-deal-check`. Без cron. **OLX.ua отвечает 200 серверам Cloudflare, но 403 домашнему IP** — проверять только в облаке.

```bash
npm run deploy
npx --yes wrangler@4 secret put TELEGRAM_TOKEN      # вводит владелец
curl "https://iphone-deal-check.lashkevych049.workers.dev/setup?key=$(cat .run_key)"
curl "https://iphone-deal-check.lashkevych049.workers.dev/run?key=$(cat .run_key)&url=<ссылка>&price=380"   # проверка
```
