// Час за Києвом. Переходи на літній/зимовий час рахує Intl, тож жодних
// жорстко зашитих «+3 години».
const DAY_MS = 86400000;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});

function kyivParts(ts) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ts == null ? Date.now() : ts))) p[x.type] = x.value;
  return {
    y: +p.year, m: +p.month, d: +p.day,
    h: (+p.hour) % 24, mi: +p.minute, s: +p.second,
    wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday),   // 0 = понеділок
  };
}

// Зсув Києва від UTC у мс для моменту ts.
function kyivOffset(ts) {
  const p = kyivParts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

// «2026-09-28 18:00» за Києвом → мс UTC (або null).
function parseKyiv(str) {
  const m = String(str || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = guess - kyivOffset(guess);
  t = guess - kyivOffset(t);
  return t;
}

const pad = (n) => String(n).padStart(2, '0');
function dayKey(ts) { const p = kyivParts(ts); return p.y + '-' + pad(p.m) + '-' + pad(p.d); }
function kyivHour(ts) { return kyivParts(ts).h; }

// Сьогодні HH:MM за Києвом.
function todayAt(hour, minute, ts) {
  return parseKyiv(dayKey(ts == null ? Date.now() : ts) + ' ' + pad(hour) + ':' + pad(minute || 0));
}

// Понеділок 00:00 за Києвом.
function weekStart(ts) {
  const now = ts == null ? Date.now() : ts;
  const p = kyivParts(now);
  const localMidnightUTC = Date.UTC(p.y, p.m - 1, p.d) - p.wd * DAY_MS;
  return localMidnightUTC - kyivOffset(localMidnightUTC);
}
function weekKey(ts) { return 'W' + dayKey(weekStart(ts) + 3600000); }
function weekEnd(ts) { return weekStart(weekStart(ts) + 8 * DAY_MS); }

function fmtKyiv(ts, opts) {
  return new Date(ts).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', ...(opts || {}) });
}

// «2 год 15 хв», «3 дн 4 год».
function humanLeft(ms) {
  if (ms <= 0) return 'ось-ось';
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / 3600000);
  const mi = Math.floor((ms % 3600000) / 60000);
  const parts = [];
  if (d) parts.push(d + ' дн');
  if (h) parts.push(h + ' год');
  if (mi && !d) parts.push(mi + ' хв');
  return parts.join(' ') || 'менше хвилини';
}

// Тривалість: 2д, 3г, 30хв, 1д12г, 90m, 2h30m → мс.
function parseDuration(str) {
  if (!str) return 0;
  const t = String(str).toLowerCase().replace(/\s+/g, '');
  const re = /(\d+)(дн|д|d|год|г|h|хв|х|min|m|с|s)?/g;
  let ms = 0, found = false, m;
  while ((m = re.exec(t)) !== null) {
    const n = parseInt(m[1], 10);
    const unit = m[2] || 'хв';
    found = true;
    if (['д', 'd', 'дн'].includes(unit)) ms += n * DAY_MS;
    else if (['г', 'h', 'год'].includes(unit)) ms += n * 3600000;
    else if (['с', 's'].includes(unit)) ms += n * 1000;
    else ms += n * 60000;
  }
  return found ? ms : 0;
}

module.exports = {
  DAY_MS, kyivParts, kyivOffset, parseKyiv, dayKey, kyivHour, todayAt,
  weekStart, weekKey, weekEnd, fmtKyiv, humanLeft, parseDuration,
};
