// ==========================================================================
// СЕЗОННИЙ ПАС.
//
// Сезон триває 30 днів. XP качається ставками в іграх, платними спінами,
// а також «безкоштовними» діями (щоденний спін, ставка в банк, друзі,
// поповнення). Кожен рівень — LEVEL_XP очок, усього MAX_LEVEL рівнів.
//
// Дві лінії нагород: безкоштовна (для всіх) і платна (відкривається один
// раз на сезон за внутрішні зірки або реальні Telegram Stars). Фінал платної
// лінії — Мішка, спін платного колеса і 30⭐.
//
// Модуль чистий: нічого не пише в базу сам. Сервер бере об'єкт пасу через
// ensure(), змінює його функціями нижче й сам зберігає в запис користувача.
// ==========================================================================

const DAY_MS = 86400000;
const SEASON_DAYS = 30;
// Точка відліку сезонів (01.01.2026 00:00 UTC). Номер сезону — скільки
// повних 30-денних проміжків минуло від неї.
const SEASON_EPOCH = Date.UTC(2026, 0, 1);

const MAX_LEVEL = 30;
const LEVEL_XP = 100;

// Звідки береться XP.
const XP_PER_STAR_BET = 2;     // ставка в емодзі-іграх: за кожну ⭐
const XP_PER_STAR_SPIN = 3;    // платне колесо: за кожну витрачену ⭐ (спін 15⭐ = 45 XP)
const XP_DAILY_SPIN = 10;      // безкоштовний спін
const XP_BANK_BET = 15;        // ставка у спільний банк (раз на банк)

// Денні стелі — щоб пас не можна було «купити» за один вечір дрібними ставками.
const WAGER_XP_DAY_CAP = 450;
const FREE_XP_DAY_CAP = 120;

// Платна лінія.
const PREMIUM_PRICE = 150;       // з внутрішнього балансу
const PREMIUM_PRICE_XTR = 100;   // реальними Telegram Stars
const XTR_BONUS_LEVELS = 2;      // бонус за оплату реальними зірками

function r(type, amount, label, extra) { return Object.assign({ type, amount, label }, extra || {}); }

// Нагороди за рівнями. Безкоштовна лінія — кожні 3 рівні, платна — кожні 2.
const FREE = {
  3:  r('tickets', 3, '+3 🎫'),
  6:  r('dailySpin', 1, 'Безкоштовний спін'),
  9:  r('stars', 2, '+2⭐'),
  12: r('tickets', 5, '+5 🎫'),
  15: r('dailySpin', 1, 'Безкоштовний спін'),
  18: r('stars', 3, '+3⭐'),
  21: r('tickets', 5, '+5 🎫'),
  24: r('dailySpin', 1, 'Безкоштовний спін'),
  27: r('stars', 5, '+5⭐'),
  30: r('tickets', 10, '+10 🎫'),
};
const PREM = {
  2:  r('stars', 2, '+2⭐'),
  4:  r('dailySpin', 1, 'Безкоштовний спін'),
  6:  r('tickets', 5, '+5 🎫'),
  8:  r('stars', 3, '+3⭐'),
  10: r('paidSpin', 1, 'Спін «За зірки»'),
  12: r('stars', 3, '+3⭐'),
  14: r('tickets', 10, '+10 🎫'),
  16: r('dailySpin', 2, '2 безкоштовні спіни'),
  18: r('stars', 5, '+5⭐'),
  20: r('paidSpin', 1, 'Спін «За зірки»'),
  22: r('stars', 5, '+5⭐'),
  24: r('tickets', 15, '+15 🎫'),
  26: r('dailySpin', 2, '2 безкоштовні спіни'),
  28: r('stars', 8, '+8⭐'),
  30: r('final', 0, 'Мішка + спін + 30⭐', { stars: 30, paidSpin: 1, prize: 'bear', img: 'bear' }),
};

// REWARDS[level] = { label, free, prem } — label показує найближчу нагороду рівня.
const REWARDS = {};
for (let lv = 1; lv <= MAX_LEVEL; lv++) {
  if (!FREE[lv] && !PREM[lv]) continue;
  REWARDS[lv] = { label: (FREE[lv] || PREM[lv]).label, free: FREE[lv] || null, prem: PREM[lv] || null };
}

function seasonIndex(now) { return Math.floor(((now || Date.now()) - SEASON_EPOCH) / (SEASON_DAYS * DAY_MS)); }
function seasonId(now) { return 'S' + (seasonIndex(now) + 1); }
function seasonEndsAt(now) { return SEASON_EPOCH + (seasonIndex(now) + 1) * SEASON_DAYS * DAY_MS; }
function dayOf(now) { return Math.floor((now || Date.now()) / DAY_MS); }

function levelOf(xp) {
  return Math.max(1, Math.min(MAX_LEVEL, 1 + Math.floor((Number(xp) || 0) / LEVEL_XP)));
}

function fresh(now) {
  return {
    season: seasonId(now), xp: 0, premium: false, premiumMethod: null,
    claimed: { free: [], prem: [] },
    wagered: 0, wagerDay: 0, wagerXpDay: 0, freeDay: 0, freeXpDay: 0,
    bankXpFor: null,
  };
}

// Повертає пас поточного сезону, прикріплений до u.pass. Старий сезон
// замінюється новим (прогрес попереднього згорає — так задумано).
function ensure(u, now) {
  const t = now || Date.now();
  let p = u && u.pass;
  if (!p || typeof p !== 'object' || p.season !== seasonId(t)) p = fresh(t);
  if (!p.claimed) p.claimed = { free: [], prem: [] };
  if (!Array.isArray(p.claimed.free)) p.claimed.free = [];
  if (!Array.isArray(p.claimed.prem)) p.claimed.prem = [];
  p.xp = Math.max(0, Number(p.xp) || 0);
  if (u) u.pass = p;
  return p;
}

function addXp(p, n) {
  const gain = Math.max(0, Math.round((Number(n) || 0) * 100) / 100);
  const before = levelOf(p.xp);
  p.xp = Math.round((p.xp + gain) * 100) / 100;
  const after = levelOf(p.xp);
  return { gained: gain, level: after, leveledUp: after > before };
}

// XP за оборот (ставки й платні спіни) — з денною стелею.
function addWagerXp(p, stars, kind, now) {
  const s = Math.max(0, Number(stars) || 0);
  const d = dayOf(now);
  if (p.wagerDay !== d) { p.wagerDay = d; p.wagerXpDay = 0; }
  p.wagered = Math.round(((p.wagered || 0) + s) * 100) / 100;
  const rate = kind === 'spin' ? XP_PER_STAR_SPIN : XP_PER_STAR_BET;
  const room = Math.max(0, WAGER_XP_DAY_CAP - (p.wagerXpDay || 0));
  const want = Math.min(room, s * rate);
  p.wagerXpDay = (p.wagerXpDay || 0) + want;
  return addXp(p, want);
}

// XP за безкоштовні дії (щоденний спін, банк) — теж зі стелею.
function addFreeXp(p, xp, kind, now) {
  const d = dayOf(now);
  if (p.freeDay !== d) { p.freeDay = d; p.freeXpDay = 0; }
  const room = Math.max(0, FREE_XP_DAY_CAP - (p.freeXpDay || 0));
  const want = Math.min(room, Math.max(0, Number(xp) || 0));
  p.freeXpDay = (p.freeXpDay || 0) + want;
  return addXp(p, want);
}

// XP за «цінні» дії (друг, поповнення, промокод) — без стелі.
function addPetXp(p, xp) { return addXp(p, xp); }

function rewardAt(level, track) {
  const row = REWARDS[level];
  if (!row) return null;
  return track === 'prem' ? row.prem : row.free;
}

function isClaimed(p, level, track) {
  return (p.claimed[track === 'prem' ? 'prem' : 'free'] || []).indexOf(level) !== -1;
}

function claimable(p) {
  const lv = levelOf(p.xp);
  const out = [];
  for (let i = 1; i <= lv; i++) {
    if (FREE[i] && !isClaimed(p, i, 'free')) out.push({ level: i, track: 'free' });
    if (p.premium && PREM[i] && !isClaimed(p, i, 'prem')) out.push({ level: i, track: 'prem' });
  }
  return out;
}

function claim(p, level, track) {
  const lv = parseInt(level, 10);
  const tr = track === 'prem' ? 'prem' : 'free';
  if (!Number.isFinite(lv) || lv < 1 || lv > MAX_LEVEL) return { ok: false, error: 'bad_level' };
  const rw = rewardAt(lv, tr);
  if (!rw) return { ok: false, error: 'no_reward' };
  if (lv > levelOf(p.xp)) return { ok: false, error: 'locked' };
  if (tr === 'prem' && !p.premium) return { ok: false, error: 'not_premium' };
  if (isClaimed(p, lv, tr)) return { ok: false, error: 'already' };
  p.claimed[tr].push(lv);
  return { ok: true, level: lv, track: tr, reward: rw };
}

// Купівля платної лінії. method: 'balance' (перевіряємо баланс) або 'xtr'
// (оплата вже пройшла через Telegram — баланс не чіпаємо, даємо бонусні рівні).
function buy(p, balance, method) {
  if (p.premium) return { ok: false, error: 'already_premium' };
  const viaXtr = method === 'xtr';
  if (!viaXtr && (Number(balance) || 0) < PREMIUM_PRICE) {
    return { ok: false, error: 'no_stars', price: PREMIUM_PRICE };
  }
  p.premium = true;
  p.premiumMethod = viaXtr ? 'xtr' : 'balance';
  p.premiumAt = Date.now();
  if (viaXtr) {
    const cap = (MAX_LEVEL - 1) * LEVEL_XP;
    p.xp = Math.max(p.xp, Math.min(cap, p.xp + XTR_BONUS_LEVELS * LEVEL_XP));
  }
  const unlocked = claimable(p).filter(c => c.track === 'prem').length;
  return { ok: true, price: viaXtr ? 0 : PREMIUM_PRICE, unlocked, level: levelOf(p.xp) };
}

function view(p, now) {
  const t = now || Date.now();
  const level = levelOf(p.xp);
  const atMax = level >= MAX_LEVEL;
  const xpInLevel = atMax ? LEVEL_XP : Math.floor(p.xp - (level - 1) * LEVEL_XP);
  const d = dayOf(t);
  const rewards = [];
  for (let lv = 1; lv <= MAX_LEVEL; lv++) {
    if (!REWARDS[lv]) continue;
    const mk = (rw, tr) => rw ? Object.assign({}, rw, { claimed: isClaimed(p, lv, tr) }) : null;
    rewards.push({ level: lv, open: lv <= level, free: mk(FREE[lv], 'free'), prem: mk(PREM[lv], 'prem') });
  }
  let pendingPremium = 0;
  if (!p.premium) for (let lv = 1; lv <= level; lv++) if (PREM[lv]) pendingPremium++;
  return {
    season: p.season,
    level, maxLevel: MAX_LEVEL, xp: p.xp,
    xpInLevel, levelXp: LEVEL_XP, toNext: atMax ? 0 : Math.ceil(level * LEVEL_XP - p.xp),
    daysLeft: Math.max(0, Math.ceil((seasonEndsAt(t) - t) / DAY_MS)),
    wagered: p.wagered || 0,
    wagerXpDay: p.wagerDay === d ? (p.wagerXpDay || 0) : 0,
    wagerXpCap: WAGER_XP_DAY_CAP,
    premium: !!p.premium,
    price: PREMIUM_PRICE, priceXtr: PREMIUM_PRICE_XTR, xtrBonusLevels: XTR_BONUS_LEVELS,
    pendingPremium,
    claimable: claimable(p),
    rewards,
  };
}

module.exports = {
  ensure, view, claim, claimable, buy,
  addWagerXp, addFreeXp, addPetXp, levelOf,
  seasonId, seasonEndsAt,
  REWARDS, MAX_LEVEL, LEVEL_XP,
  PREMIUM_PRICE, PREMIUM_PRICE_XTR, XTR_BONUS_LEVELS,
  XP_PER_STAR_BET, XP_PER_STAR_SPIN, XP_DAILY_SPIN, XP_BANK_BET,
  WAGER_XP_DAY_CAP, FREE_XP_DAY_CAP,
};
