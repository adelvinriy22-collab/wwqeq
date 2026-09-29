// ===========================================================================
// 🏆 ЛІГА ТИЖНЯ
//
// Кожна дія дає XP. Тиждень — з понеділка 00:00 до понеділка 00:00 за Києвом.
// Топ отримує призи, усі активні — утішні білети.
//
// КАЛІБРУВАННЯ. XP за витрачену зірку підібрано так, щоб 1 XP приносив боту
// приблизно однакову маржу (~0.19–0.20⭐) з будь-якого джерела:
//   платне колесо  маржа 37% → 2.0 XP/⭐
//   емодзі-ігри    маржа  8% → 0.4 XP/⭐
//
// БАЛАНС. Щоденна безкоштовна активність дає ~540 XP за тиждень — цього
// вистачає на топ-10. Витрати додаються зверху — вони ведуть у топ-3.
// Так ліга тримає всіх, а головні призи покриваються маржею.
// Якби ігри давали стільки ж, скільки колесо, лігу фармили б на парному/
// непарному при п'ятикратно меншій маржі.
//
// Безкоштовні дії (спін, квест, улюбленець) мають денні стелі — щоб XP не
// можна було накрутити нескінченно, але активний безкоштовний гравець усе
// одно реально конкурував.
// ===========================================================================

const XP = {
  paid_star:   2.0,    // за кожну зірку, витрачену на платне колесо
  dice_star:   0.4,    // за кожну зірку ставки в емодзі-іграх
  bank_star:   0.5,    // за кожну зірку в спільний банк
  bank_ticket: 1.0,    // за кожен білет у банк (білет важить як 5⭐, але коштує ~0.34⭐)
  daily_spin:  5,      // безкоштовний спін
  ref_spin:    3,      // спін за білети
  quest:       15,     // виконаний квест
  friend:      60,     // запрошений друг — найцінніше для росту бота
  pet_care:    3,      // погодувати / напоїти / помити
  pet_game:    2,      // міні-гра з улюбленцем
  pet_level:   20,     // улюбленець отримав рівень
  streak_day:  2,      // × днів серії (до 7) — за перший спін дня
  chat_msg:    1,      // повідомлення в чаті (не коротше 8 символів, раз на 30 с)
  duel_win:    3,      // перемога в дуелі в чаті
  chat_goal:   1,      // × одиниць — спільна ціль чату виконана
  activist:    1,      // × одиниць — нагорода «Активіст дня»
  partner:     1,      // × одиниць — партнерське завдання (RubUP тощо)
};

// Денні стелі по джерелах. Витрати зірок не обмежені — там працює маржа.
const DAY_CAP = {
  daily_spin: 5, ref_spin: 30, quest: 120, friend: 300,
  pet_care: 27, pet_game: 20, pet_level: 60, streak_day: 14,
  chat_msg: 40, duel_win: 15, chat_goal: 15, activist: 40, partner: 150,
};
// Тижнева стеля банку: маржі там немає, тож без обмеження це дірка.
const WEEK_CAP = { bank_star: 250, bank_ticket: 250 };

// Мінімум XP, щоб узагалі претендувати на призи місць.
const MIN_XP_FOR_PRIZE = 50;
// Скільки треба набрати, щоб отримати утішні білети.
const PARTICIPATION_XP = 150;
const PARTICIPATION_TICKETS = 3;

// Призи. type: tier — заявка на подарунок; stars / tickets — одразу на баланс.
const REWARDS = [
  { from: 1,  to: 1,  items: [{ type: 'tier', id: 'trophy' }, { type: 'tickets', n: 50 }] },
  { from: 2,  to: 2,  items: [{ type: 'tier', id: 'rocket' }, { type: 'tickets', n: 30 }] },
  { from: 3,  to: 3,  items: [{ type: 'tier', id: 'gift' },   { type: 'tickets', n: 20 }] },
  { from: 4,  to: 5,  items: [{ type: 'tier', id: 'bear' },   { type: 'tickets', n: 10 }] },
  { from: 6,  to: 10, items: [{ type: 'stars', n: 10 },       { type: 'tickets', n: 5 }] },
];

// ---------------------------------------------------------------------------
// Час за Києвом (переходи на літній/зимовий рахуються самі через Intl).
// ---------------------------------------------------------------------------
function kyivParts(ts) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return {
    y: +p.year, m: +p.month, d: +p.day,
    h: +p.hour === 24 ? 0 : +p.hour, mi: +p.minute, s: +p.second,
    wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday),   // 0 = понеділок
  };
}

// Зсув Києва від UTC у мс для моменту ts.
function kyivOffset(ts) {
  const p = kyivParts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

// «2026-09-28 18:00» за Києвом → мс UTC.
function parseKyiv(str) {
  const m = String(str || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Двічі уточнюємо зсув — щоб правильно пройти перехід на літній/зимовий час.
  let t = guess - kyivOffset(guess);
  t = guess - kyivOffset(t);
  return t;
}

function dayKey(ts) {
  const p = kyivParts(ts || Date.now());
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

// Початок тижня (понеділок 00:00 за Києвом) у мс UTC.
function weekStart(ts) {
  const now = ts || Date.now();
  const p = kyivParts(now);
  const localMidnightUTC = Date.UTC(p.y, p.m - 1, p.d) - p.wd * 86400000;
  return localMidnightUTC - kyivOffset(localMidnightUTC);
}

function weekKey(ts) { return 'W' + dayKey(weekStart(ts || Date.now()) + 3600000); }
function weekEnd(ts) { return weekStart((weekStart(ts || Date.now())) + 8 * 86400000); }

// ---------------------------------------------------------------------------
// Стан гравця.
// ---------------------------------------------------------------------------
function ensure(u, now) {
  const wk = weekKey(now);
  let L = u.league;
  if (!L || L.week !== wk) {
    // Минулий тиждень зберігаємо окремо: якщо гравець щось зробив о 00:00
    // понеділка раніше, ніж бот підбив підсумки, результат не зникне.
    if (L && L.week && L.xp > 0) u.leaguePrev = L;
    L = { week: wk, xp: 0, bySrc: {}, day: null, dayBySrc: {}, lastAt: 0 };
  }
  const dk = dayKey(now);
  if (L.day !== dk) { L.day = dk; L.dayBySrc = {}; }
  u.league = L;   // прикріплюємо, щоб виклик міг одразу зберегти u.league
  return L;
}

// Нарахувати XP. amount — кількість одиниць (зірок, дій). Повертає реально нараховане.
function add(u, src, units, now) {
  const t = now || Date.now();
  const L = ensure(u, t);
  const per = XP[src];
  if (per == null) return { gained: 0, league: L };

  let gain = Math.round(per * Math.max(0, Number(units) || 0) * 100) / 100;

  if (DAY_CAP[src] != null) {
    const room = Math.max(0, DAY_CAP[src] - (L.dayBySrc[src] || 0));
    gain = Math.min(gain, room);
  }
  if (WEEK_CAP[src] != null) {
    const room = Math.max(0, WEEK_CAP[src] - (L.bySrc[src] || 0));
    gain = Math.min(gain, room);
  }
  if (gain <= 0) return { gained: 0, league: L };

  L.xp = Math.round((L.xp + gain) * 100) / 100;
  L.bySrc[src] = Math.round(((L.bySrc[src] || 0) + gain) * 100) / 100;
  L.dayBySrc[src] = Math.round(((L.dayBySrc[src] || 0) + gain) * 100) / 100;
  L.lastAt = t;
  return { gained: gain, league: L };
}

// Таблиця: лише гравці поточного тижня. При рівних XP вище той, хто набрав раніше.
function standings(users, now) {
  const wk = weekKey(now);
  const rows = [];
  for (const [uid, u] of users) {
    const L = u && u.league;
    if (!L || L.week !== wk || !(L.xp > 0)) continue;
    rows.push({ uid, xp: L.xp, lastAt: L.lastAt || 0, u });
  }
  rows.sort((a, b) => (b.xp - a.xp) || (a.lastAt - b.lastAt));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// Таблиця конкретного (зокрема вже минулого) тижня.
function standingsFor(users, wk) {
  const rows = [];
  for (const [uid, u] of users) {
    if (!u) continue;
    const L = (u.league && u.league.week === wk) ? u.league
            : (u.leaguePrev && u.leaguePrev.week === wk) ? u.leaguePrev : null;
    if (!L || !(L.xp > 0)) continue;
    rows.push({ uid, xp: L.xp, lastAt: L.lastAt || 0, u });
  }
  rows.sort((a, b) => (b.xp - a.xp) || (a.lastAt - b.lastAt));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function rewardFor(rank) {
  const r = REWARDS.find(x => rank >= x.from && rank <= x.to);
  return r ? r.items : null;
}

module.exports = {
  XP, DAY_CAP, WEEK_CAP, REWARDS,
  MIN_XP_FOR_PRIZE, PARTICIPATION_XP, PARTICIPATION_TICKETS,
  ensure, add, standings, standingsFor, rewardFor,
  weekKey, weekStart, weekEnd, dayKey, kyivParts, kyivOffset, parseKyiv,
};
