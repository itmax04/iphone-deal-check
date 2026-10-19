// Модель, память, аккумулятор и состояние iPhone по объявлению (немецкий текст Kleinanzeigen).
// Регулярные выражения модели/памяти/аккумулятора — из iphone-alert-bot (src/filters.js).

// «iPhone 13», «Iphone 14pro», «iPhone 16e», «iPhone 15 Pro Max», «iPhone Air»; 11 и новее.
const MODEL_RE = /i\s?phone\s*(1[1-9]|2\d)(?!\d)\s*(e|pro\s*max|pro|plus|max|mini)?|i\s?phone\s*(air|fold)/i;

export function modelOf(title) {
  const m = (title || '').match(MODEL_RE);
  if (!m) return null;
  if (m[3]) return `iPhone ${m[3][0].toUpperCase()}${m[3].slice(1).toLowerCase()}`;
  const variant = (m[2] || '').toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^E$/, 'e');
  return `iPhone ${m[1]}${variant === 'e' ? 'e' : variant ? ` ${variant}` : ''}`;
}

export function storageOf(text) {
  const m = (text || '').match(/(\d{2,4})\s?(?:gb|гб)|(1|2)\s?(?:tb|тб)/i);
  if (!m) return null;
  return m[1] ? `${m[1]} GB` : `${m[2]} TB`;
}

export function batteryOf(text) {
  const m = (text || '').match(/(\d{2,3})\s?%\s?(?:akku|batterie|battery|kapazität|акб|акум)|(?:akku|batterie|battery|kapazität|akkukapazität|batteriezustand|акб|акумулятор)[^0-9]{0,25}(\d{2,3})\s?%/i);
  const v = m ? parseInt(m[1] || m[2], 10) : null;
  return v && v <= 100 && v >= 50 ? v : null;
}

// «keine Mängel», «nicht gesperrt», «ohne Kratzer» — отрицание перед словом = признака нет.
const NEGATION_BEFORE = /(kein|keine|keinen|keiner|nicht|ohne|frei von|null|nie)\s+(\S+\s+){0,2}$/;
function findUnnegated(lower, words) {
  for (const w of words) {
    let at = lower.indexOf(w);
    while (at !== -1) {
      if (!NEGATION_BEFORE.test(lower.slice(Math.max(0, at - 30), at))) return w;
      at = lower.indexOf(w, at + w.length);
    }
  }
  return null;
}

// Стоп-факторы: покупать нельзя.
const BLOCKERS = [
  [['icloud gesperrt', 'icloud-sperre', 'icloud sperre', 'aktivierungssperre', 'gesperrt', 'blacklist', 'simlock'], 'блокировка iCloud / сети'],
  [['defekt', 'bastler', 'ersatzteil', 'für teile', 'fuer teile', 'wasserschaden', 'startet nicht', 'geht nicht an', 'bootloop'], 'дефект / на запчасти'],
  [['face id geht nicht', 'faceid defekt', 'face id defekt', 'face id funktioniert nicht', 'kein face id', 'true tone fehlt'], 'не работает Face ID / True Tone'],
];
// Минусы состояния: снижают цену продажи.
const MINUSES = [
  [['display gesprungen', 'displaybruch', 'riss im display', 'risse', 'gesprungen', 'gebrochen', 'glas kaputt', 'rückseite gesprungen', 'backcover gebrochen'], 'трещины'],
  [['kaputt', 'beschädigt', 'beschaedigt'], 'есть повреждение (проверь, что именно)'],
  [['kratzer', 'gebrauchsspuren', 'macken', 'dellen', 'abgenutzt'], 'царапины / следы использования'],
  [['display getauscht', 'displaytausch', 'neues display', 'drittanbieter', 'unbekanntes teil', 'unknown part', 'display nicht original', 'display ist nicht original', 'akku nicht original', 'kamera nicht original'], 'неоригинальные запчасти / замена дисплея'],
  [['akku getauscht', 'neuer akku', 'akkutausch', 'akkuwechsel', 'akku gewechselt', 'batterie getauscht'], 'заменён аккумулятор (проверь оригинал)'],
];
// Плюсы: проще продать.
const PLUSES = [
  [['ovp', 'originalverpackung', 'originalkarton', 'mit karton', 'box'], 'коробка'],
  [['rechnung', 'kaufbeleg', 'quittung'], 'чек'],
  [['garantie', 'gewährleistung', 'applecare'], 'гарантия'],
  [['wie neu', 'neuwertig', 'kaum benutzt', 'top zustand', 'sehr guter zustand', 'makellos'], '«как новый»'],
];
// Признаки мошенничества / подозрительного объявления.
const SCAM = [
  [['nur versand', 'nur paypal freunde', 'paypal freunde', 'western union', 'vorkasse', 'überweisung vorab', 'whatsapp', 'per e-mail', 'e-mail schreiben'], 'просят оплату вне защиты / уводят в мессенджер'],
  [['suche', 'kaufe', 'ankauf'], 'это объявление о ПОКУПКЕ, не продаже'],
];

// Поле «Zustand» → категория состояния OLX (condition_grade).
const ZUSTAND_TO_GRADE = { neu: 'like_new', 'wie neu': 'like_new', 'sehr gut': 'very_good', gut: 'good', 'in ordnung': 'good', defekt: 'defects' };

export function assessCondition(ad) {
  const text = `${ad.title}\n${ad.description}`;
  const lower = text.toLowerCase();
  const zustand = (ad.details?.Zustand || '').trim();
  const akkuField = (ad.details?.Akkuzustand || '').trim();
  const battery = batteryOf(text) ?? batteryOf(`akku ${akkuField}`);

  const blockers = [];
  for (const [words, label] of BLOCKERS) if (findUnnegated(lower, words)) blockers.push(label);
  if (/defekt/i.test(zustand) || /defekt/i.test(akkuField)) if (!blockers.includes('дефект / на запчасти')) blockers.push('дефект / на запчасти');
  const scam = [];
  for (const [words, label] of SCAM) {
    if (label.startsWith('это объявление') ? /^\s*(suche|kaufe|ankauf)\b/i.test(ad.title) : findUnnegated(lower, words)) scam.push(label);
  }
  const minuses = [];
  for (const [words, label] of MINUSES) if (findUnnegated(lower, words)) minuses.push(label);
  if (battery != null && battery < 80) minuses.push(`аккумулятор ${battery}% (< 80% — Apple считает изношенным)`);
  else if (battery != null && battery < 85) minuses.push(`аккумулятор ${battery}%`);
  if (ad.images < 3) minuses.push(`мало фото (${ad.images})`);
  const pluses = [];
  for (const [words, label] of PLUSES) if (findUnnegated(lower, words)) pluses.push(label);
  if (battery != null && battery >= 90) pluses.push(`аккумулятор ${battery}%`);

  let grade = ZUSTAND_TO_GRADE[zustand.toLowerCase()] || null;
  if (!grade) grade = pluses.includes('«как новый»') ? 'like_new' : minuses.includes('трещины') ? 'defects' : minuses.length ? 'good' : 'very_good';
  if (minuses.includes('трещины') && grade !== 'defects') grade = 'good';
  // Продавец пишет «Sehr gut», но есть повреждение или изношенный аккумулятор — сравниваем на ступень ниже.
  const serious = minuses.some((m) => /повреждение|трещины|< 80%|неоригинальные/.test(m));
  const DOWN = { like_new: 'very_good', very_good: 'good' };
  if (serious && DOWN[grade]) grade = DOWN[grade];

  return { zustand: zustand || null, akku: akkuField || null, battery, grade, blockers, scam, minuses, pluses };
}

export const GRADE_LABEL = { like_new: 'как новый', very_good: 'очень хорошее', good: 'хорошее / есть следы', defects: 'с дефектами', for_parts: 'на запчасти' };
