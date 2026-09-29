// ==========================================================================
// СПІЛЬНИЙ БАНК.
//
// Усі скидаються зірками в один банк. Що більше поставив — то більший
// сектор на колесі. У призначений час колесо крутиться один раз, і той,
// на кому воно зупинилось, забирає ВЕСЬ банк.
//
// Бот не бере комісії. Банк — це не джерело доходу, а привід зібрати
// людей в один час у боті. Комісія тут зруйнувала б саму ідею «переможець
// забирає все» і дала б привід сумніватись у чесності.
//
// ЧЕСНІСТЬ ПЕРЕВІРЯЄТЬСЯ.
// При створенні банку генерується випадковий seed, а людям одразу
// показується його sha256-відбиток. Переможець рахується як
// HMAC(seed, список_ставок) — тобто результат зафіксований ще до того,
// як зроблено першу ставку, але дізнатись його наперед неможливо.
// Після розіграшу seed публікується, і будь-хто перераховує результат сам.
// ==========================================================================

const crypto = require('crypto');

const MIN_BET = 1;

// Білет важить як 5⭐ у банку. Цінність білета вища за зірку, тож і місця
// на арені він дає більше — інакше ставити їх не було б сенсу.
const TICKET_WEIGHT = 5;

// Утішні білети: 1 білет за кожні 25 ваги ставки, максимум 20 на людину.
// Коштує копійки, але прибирає відчуття «я втратив усе» — саме через
// нього люди ставили один раз і більше не поверталися.
const CONSOLE_PER = 25;
const CONSOLE_MAX = 20;

// Віхи банку. Дійшли — адмін доливає обіцяне. Це дає привід кликати
// друзів: що більший банк, то більше в ньому «безкоштовних» зірок.
const MILESTONES = [
  { at: 200,  bonus: 25,  label: '+25⭐ від бота' },
  { at: 500,  bonus: 75,  label: '+75⭐ від бота' },
  { at: 1000, bonus: 200, label: '+200⭐ від бота' },
  { at: 2000, bonus: 500, label: '+500⭐ від бота' },
];

// Скільки втішних білетів отримає гравець.
function consolationFor(b, uid) {
  const w = (b.bets || {})[uid] || 0;
  if (!w) return 0;
  return Math.min(CONSOLE_MAX, Math.floor(w / CONSOLE_PER));
}

// Стан віх: пройдені, наступна, скільки лишилось.
function milestones(b) {
  const pot = totalPot(b);
  const done = MILESTONES.filter(m => pot >= m.at);
  const next = MILESTONES.find(m => pot < m.at) || null;
  return {
    list: MILESTONES.map(m => ({ ...m, reached: pot >= m.at })),
    reachedCount: done.length,
    bonusUnlocked: done.reduce((s, m) => s + m.bonus, 0),
    next,
    toNext: next ? Math.round((next.at - pot) * 100) / 100 : 0,
    nextPercent: next ? Math.round(pot / next.at * 100) : 100,
  };
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

function create(drawAt) {
  const seed = crypto.randomBytes(32).toString('hex');
  return {
    id: 'bank_' + Date.now(),
    status: 'open',
    createdAt: Date.now(),
    drawAt,
    pot: 0,              // сумарна ВАГА банку (зірки + білети×5)
    stars: 0,            // скільки з того зірками
    tickets: 0,          // скільки білетів поставлено
    bets: {},            // uid -> вага
    betStars: {},        // uid -> зірки
    betTickets: {},      // uid -> білети
    order: [],           // uid у порядку першої ставки — щоб сектори не стрибали
    feed: [],            // останні ставки для живої стрічки
    seed,
    seedHash: sha256(seed),
    winner: null,
    drawnAt: 0,
    roll: null,
  };
}

function totalPot(b) { return Math.round((b.pot || 0) * 100) / 100; }

// Ставка: зірки, білети, або те й те одразу.
function addBet(b, uid, stars, tickets) {
  if (b.status !== 'open') return { ok: false, error: 'closed' };
  if (Date.now() >= b.drawAt) return { ok: false, error: 'too_late' };

  const s = Math.floor(Number(stars) || 0);
  const t = Math.floor(Number(tickets) || 0);
  if (s < 0 || t < 0) return { ok: false, error: 'bad_amount' };

  const weight = s + t * TICKET_WEIGHT;
  if (weight < MIN_BET) return { ok: false, error: 'too_small', min: MIN_BET };

  if (!b.bets[uid]) {
    b.bets[uid] = 0; b.betStars[uid] = 0; b.betTickets[uid] = 0;
    b.order.push(uid);
  }
  b.bets[uid] = Math.round((b.bets[uid] + weight) * 100) / 100;
  b.betStars[uid] = (b.betStars[uid] || 0) + s;
  b.betTickets[uid] = (b.betTickets[uid] || 0) + t;

  b.pot = Math.round((b.pot + weight) * 100) / 100;
  b.stars = Math.round(((b.stars || 0) + s) * 100) / 100;
  b.tickets = (b.tickets || 0) + t;

  b.feed = (b.feed || []).concat([{ uid, s, t, weight, at: Date.now() }]).slice(-25);

  return {
    ok: true, stars: s, tickets: t, weight,
    mine: b.bets[uid], mineStars: b.betStars[uid], mineTickets: b.betTickets[uid],
    pot: totalPot(b),
  };
}

function chance(b, uid) {
  const pot = totalPot(b);
  if (!pot || !b.bets[uid]) return 0;
  return Math.round(b.bets[uid] / pot * 1000) / 10;   // відсоток з одним знаком
}

// Список секторів для показу: хто, скільки, який відсоток.
function sectors(b) {
  const pot = totalPot(b);
  return b.order.map((uid) => ({
    uid,
    amount: b.bets[uid],
    stars: b.betStars ? (b.betStars[uid] || 0) : b.bets[uid],
    tickets: b.betTickets ? (b.betTickets[uid] || 0) : 0,
    percent: pot ? Math.round(b.bets[uid] / pot * 1000) / 10 : 0,
  })).sort((x, y) => y.amount - x.amount);
}

// Розіграш. Детермінований: той самий seed і ті самі ставки завжди дають
// того самого переможця, тому результат можна перевірити вручну.
function draw(b) {
  if (b.status !== 'open') return { ok: false, error: 'already_drawn' };
  const pot = totalPot(b);
  if (!pot || !b.order.length) return { ok: false, error: 'empty' };

  // Рядок ставок фіксується у тому ж порядку, у якому люди заходили.
  const betLine = b.order.map((uid) => `${uid}:${b.bets[uid]}`).join(',');
  const hmac = crypto.createHmac('sha256', b.seed).update(betLine).digest('hex');

  // Перші 13 hex-символів -> число 0..1. 13 символів вистачає з запасом
  // і гарантовано вкладається в безпечне ціле JavaScript.
  const roll = parseInt(hmac.slice(0, 13), 16) / Math.pow(16, 13);
  let point = roll * pot;

  let winner = b.order[b.order.length - 1];
  for (const uid of b.order) {
    point -= b.bets[uid];
    if (point <= 0) { winner = uid; break; }
  }

  b.status = 'drawn';
  b.winner = winner;
  b.drawnAt = Date.now();
  b.roll = { hmac, roll: Math.round(roll * 1e6) / 1e6, betLine };
  return { ok: true, winner, pot, roll: b.roll, seed: b.seed, seedHash: b.seedHash };
}

// Перевірка результату сторонньою людиною.
function verify(b) {
  if (!b || b.status !== 'drawn' || !b.roll) return null;
  const hmac = crypto.createHmac('sha256', b.seed).update(b.roll.betLine).digest('hex');
  return {
    seedOk: sha256(b.seed) === b.seedHash,
    hmacOk: hmac === b.roll.hmac,
    seed: b.seed,
    seedHash: b.seedHash,
    betLine: b.roll.betLine,
    hmac,
  };
}

function timeLeft(b) { return Math.max(0, b.drawAt - Date.now()); }

function humanLeft(ms) {
  if (ms <= 0) return 'ось-ось';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const parts = [];
  if (d) parts.push(d + ' дн');
  if (h) parts.push(h + ' год');
  if (m && !d) parts.push(m + ' хв');
  return parts.join(' ') || 'менше хвилини';
}

module.exports = {
  create, addBet, chance, sectors, draw, verify,
  totalPot, timeLeft, humanLeft, sha256, MIN_BET, TICKET_WEIGHT,
  consolationFor, milestones, MILESTONES, CONSOLE_PER, CONSOLE_MAX,
};
