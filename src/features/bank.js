// ==========================================================================
// СПІЛЬНИЙ БАНК — сервіс: ставки, розіграш, повернення, автобанк.
// Чиста логіка й перевірка чесності — у bankcore.js.
// ==========================================================================
const core = require('./bankcore');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const i18n = require('../i18n');
const E = require('../economy');
const time = require('../lib/time');
const quests = require('./quests');
const { round2, fmtStars, whoOf, plainWho } = require('../lib/util');

function get() { return (store.getFeatureFlags() || {}).bank || null; }
function save(b) { store.setFeatureFlags({ bank: b }); return b; }
function autoCfg() { return (store.getFeatureFlags() || {}).bankAuto || { enabled: false, hour: 21, minute: 0 }; }

function prizeOf(b) {
  const ms = core.milestones(b);
  const stars = round2((b.stars != null ? b.stars : core.totalPot(b)) + ms.bonusUnlocked);
  return { stars, tickets: b.tickets || 0, bonus: ms.bonusUnlocked };
}

function view(uid) {
  const b = get();
  if (!b || b.status === 'cancelled') return { active: false, auto: autoCfg() };
  const me = String(uid);
  const secs = core.sectors(b).slice(0, 60).map(s => {
    const su = users.get(s.uid);
    return { uid: s.uid, name: su ? users.displayName(su) : 'гравець', weight: s.amount, stars: s.stars, tickets: s.tickets, percent: s.percent, me: String(s.uid) === me };
  });
  const u = users.get(uid) || {};
  const winner = b.winner ? users.get(b.winner) : null;
  return {
    active: true, id: b.id, status: b.status, drawAt: b.drawAt, msLeft: core.timeLeft(b),
    pot: core.totalPot(b), stars: b.stars != null ? b.stars : core.totalPot(b), tickets: b.tickets || 0,
    players: b.order.length, seedHash: b.seedHash, ticketWeight: core.TICKET_WEIGHT, minBet: core.MIN_BET,
    sectors: secs, milestones: core.milestones(b), prize: prizeOf(b),
    consolation: core.consolationFor(b, me), consolePer: core.CONSOLE_PER, consoleMax: core.CONSOLE_MAX,
    feed: (b.feed || []).slice(-10).reverse().map(f => {
      const fu = users.get(f.uid);
      return { name: fu ? users.displayName(fu) : 'гравець', stars: f.s, tickets: f.t, weight: f.weight, at: f.at, me: String(f.uid) === me };
    }),
    mine: { weight: b.bets[me] || 0, stars: (b.betStars || {})[me] || 0, tickets: (b.betTickets || {})[me] || 0, chance: core.chance(b, me) },
    balance: users.stars(u), myTickets: users.tickets(u),
    winner: b.winner ? { uid: b.winner, name: winner ? users.displayName(winner) : 'гравець', me: String(b.winner) === me } : null,
    won: b.wonStars != null ? { stars: b.wonStars, tickets: b.tickets || 0 } : null,
    verify: b.status === 'drawn' ? core.verify(b) : null,
    auto: autoCfg(),
  };
}

async function bet(uid, stars, tickets) {
  const s = Math.floor(Number(stars) || 0), t = Math.floor(Number(tickets) || 0);
  if (s < 0 || t < 0 || (!s && !t)) return { ok: false, status: 400, error: 'bad_amount' };
  return users.withLock(uid, () => {
    const b = get();
    if (!b || b.status !== 'open') return { ok: false, status: 400, error: 'no_bank' };
    if (Date.now() >= b.drawAt) return { ok: false, status: 400, error: 'too_late' };
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    if (s > users.stars(u)) return { ok: false, status: 402, error: 'not_enough_stars', have: users.stars(u) };
    if (t > users.tickets(u)) return { ok: false, status: 402, error: 'not_enough_tickets', have: users.tickets(u) };
    const r = core.addBet(b, String(uid), s, t);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    const m = users.move(uid, { stars: -s, tickets: -t }, 'bank_bet', { bank: b.id });
    if (!m.ok) return { ok: false, status: 402, error: 'not_enough' };
    save(b);
    // Досвід: зірки ставки — як оборот, плюс разовий бонус за участь у банку.
    if (s) progress.addXp(uid, 'wager', s * E.XP_RATES.bankPerStar);
    const u2 = users.get(uid);
    if (u2.bankXpFor !== b.id) { users.patch(uid, { bankXpFor: b.id }); progress.addXp(uid, 'bank', E.XP.bank.per); }
    quests.track(uid, 'bank');
    return { ok: true, pot: core.totalPot(b), chance: core.chance(b, String(uid)), mine: r.mine, mineStars: r.mineStars, mineTickets: r.mineTickets, balance: m.stars, tickets: m.tickets };
  });
}

function start(drawAt) {
  const cur = get();
  if (cur && cur.status === 'open') return { ok: false, error: 'already_open' };
  if (!drawAt || drawAt <= Date.now() + 60000) return { ok: false, error: 'bad_time' };
  const b = core.create(drawAt);
  save(b);
  return { ok: true, bank: b };
}

function refundAll(b, why) {
  let stars = 0, tickets = 0, players = 0;
  for (const uid of b.order || []) {
    const s = b.betStars ? (b.betStars[uid] || 0) : ((b.bets || {})[uid] || 0);
    const t = b.betTickets ? (b.betTickets[uid] || 0) : 0;
    const u = users.get(uid);
    if (!u || (!s && !t)) continue;
    users.move(uid, { stars: s, tickets: t }, 'bank_refund', { bank: b.id });
    stars += s; tickets += t; players++;
    const what = (s ? s + '⭐' : '') + (s && t ? ' + ' : '') + (t ? t + '🎫' : '');
    notify.dm(uid, i18n.t(u.lang, 'bank.refund', { what }) + (why ? '\n' + why : ''));
  }
  return { stars: round2(stars), tickets, players };
}

function cancel(why) {
  const b = get();
  if (!b || b.status !== 'open') return { ok: false, error: 'no_bank' };
  const r = refundAll(b, why);
  b.status = 'cancelled';
  b.cancelledAt = Date.now();
  save(b);
  return { ok: true, ...r };
}

// Розіграш, коли настав час. Безпечно викликати будь-коли й скільки завгодно.
async function tick() {
  const b = get();
  if (!b || b.status !== 'open' || Date.now() < b.drawAt) return null;
  const res = core.draw(b);
  if (!res.ok) {
    if (res.error === 'empty') { b.status = 'drawn'; b.winner = null; save(b); scheduleNext(); }
    return null;
  }
  const prize = prizeOf(b);
  b.wonStars = prize.stars;
  save(b);
  const winU = users.get(res.winner);
  if (winU) {
    if (prize.stars) users.move(res.winner, { stars: prize.stars }, 'bank_win', { bank: b.id });
    if (prize.tickets) users.move(res.winner, { tickets: prize.tickets }, 'bank_win', { bank: b.id });
  }
  const prizeTxt = fmtStars(prize.stars) + '⭐' + (prize.tickets ? ' + ' + prize.tickets + '🎫' : '');
  for (const pid of b.order) {
    const pu = users.get(pid);
    if (!pu) continue;
    if (String(pid) === String(res.winner)) {
      notify.dm(pid, i18n.t(pu.lang, 'bank.won', { prize: prizeTxt }), notify.appKeyboard(i18n.t(pu.lang, 'btn.open'), 'bank'));
      continue;
    }
    const cons = core.consolationFor(b, pid);
    if (cons > 0) users.move(pid, { tickets: cons }, 'bank_consolation', { bank: b.id });
    notify.dm(pid, i18n.t(pu.lang, 'bank.lost', {
      winner: winU ? whoOf(winU) : 'гравець', prize: prizeTxt,
      cons: cons ? i18n.t(pu.lang, 'bank.cons', { n: cons }) : '',
    }), notify.appKeyboard(i18n.t(pu.lang, 'btn.open'), 'bank'));
  }
  notify.admin(`🏦 <b>Банк розіграно</b>\nПереможець: ${winU ? whoOf(winU) : res.winner}\nПриз: ${prizeTxt}\nУчасників: ${b.order.length}`);
  if (winU) notify.announce('🏦 <b>' + whoOf(winU) + '</b> забрав спільний банк — <b>' + prizeTxt + '</b>! Наступний банк — у застосунку.');
  console.log('🏦 Банк розіграно:', res.winner, prizeTxt);
  scheduleNext();
  return res;
}

// Автобанк: після розіграшу одразу відкривається наступний (якщо увімкнено).
function scheduleNext() {
  const a = autoCfg();
  if (!a.enabled) return;
  let at = time.todayAt(a.hour || 21, a.minute || 0);
  while (at <= Date.now() + 3600000) at += time.DAY_MS * (a.everyDays || 1);
  const cur = get();
  if (cur && cur.status === 'open') return;
  start(at);
}
function setAuto(patch) {
  const a = { ...autoCfg(), ...patch };
  store.setFeatureFlags({ bankAuto: a });
  if (a.enabled) { const cur = get(); if (!cur || cur.status !== 'open') scheduleNext(); }
  return a;
}

// Початковий банк на 30.09 18:00 (Київ) — як у попередній версії, якщо ще немає свого.
function ensureInitial() {
  if (get()) return;
  const draw = time.parseKyiv('2026-09-30 18:00');
  if (draw && Date.now() < draw - 3600000) save(core.create(draw));
}

module.exports = { get, save, view, bet, start, cancel, tick, setAuto, autoCfg, ensureInitial, refundAll, prizeOf, core, plainWho };
