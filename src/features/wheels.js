// ==========================================================================
// КОЛЕСА: щоденне (безкоштовне), за білети, за зірки.
//
// Результат вирішує сервер через перевірюваний генератор (core/rng):
// гравець бачить відбиток seed заздалегідь і може перевірити кожен спін.
// Гарантії (pity): після N спінів без призу приз гарантовано.
// ==========================================================================
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const rng = require('../core/rng');
const notify = require('../core/notify');
const time = require('../lib/time');
const applications = require('./applications');
const goal = require('./goal');
const quests = require('./quests');
const { round2, whoOf, esc, fmtStars } = require('../lib/util');

const DAY = 86400000;

// ─── Щаслива година ─────────────────────────────────────────────────────
function happyHour(now) {
  const t = now || Date.now();
  const day = time.dayKey(t);
  const f = store.getFeatureFlags() || {};
  let hh = f.happyHourV3;
  if (!hh || hh.day !== day) {
    const span = E.HAPPY_HOUR.toHour - E.HAPPY_HOUR.fromHour;
    const hour = E.HAPPY_HOUR.fromHour + require('crypto').randomInt(span);
    hh = { day, hour, start: time.todayAt(hour, 0, t) };
    store.setFeatureFlags({ happyHourV3: hh });
  }
  return { ...hh, end: hh.start + 3600000, active: t >= hh.start && t < hh.start + 3600000 };
}
function weightsFor(wheel, now) {
  const w = { ...E.WHEELS[wheel].weights };
  if (happyHour(now).active) for (const id of E.NFT_IDS) if (w[id]) w[id] *= E.HAPPY_HOUR.nftMult;
  return w;
}

// ─── Опис результату ────────────────────────────────────────────────────
function outcomeKind(id) {
  if (E.PRIZE_IDS.includes(id)) return 'prize';
  if (String(id).startsWith('tix')) return 'tickets';
  return 'stars';
}
function outcomeAmount(id) {
  const k = outcomeKind(id);
  if (k === 'tickets') return parseInt(String(id).slice(3), 10) || 0;
  if (k === 'stars') return parseInt(String(id).slice(4), 10) || 0;
  return 0;
}
// Сектор колеса, куди має впасти стрілка.
function segmentIndex(wheel, id) {
  const segs = E.WHEELS[wheel].segments;
  let i = segs.indexOf(id);
  if (i !== -1) return i;
  if (E.PRIZE_IDS.includes(id)) { i = segs.indexOf('nft'); if (i !== -1) return i; }
  // Найближчий номінал того ж типу.
  const kind = outcomeKind(id), amt = outcomeAmount(id);
  let best = 0, bestD = Infinity;
  segs.forEach((s, j) => {
    if (outcomeKind(s === 'nft' ? 'wheel_eye' : s) !== kind) return;
    const d = Math.abs(outcomeAmount(s) - amt);
    if (d < bestD) { bestD = d; best = j; }
  });
  return best;
}
function segmentsView(wheel) {
  return E.WHEELS[wheel].segments.map(id => {
    if (id === 'nft') return { id, kind: 'prize', img: 'nft', cycle: E.NFT_IDS.map(n => E.getTier(n).img) };
    const kind = outcomeKind(id);
    if (kind === 'prize') return { id, kind, img: E.getTier(id).img };
    return { id, kind, amount: outcomeAmount(id) };
  });
}

// ─── Стан для застосунку ────────────────────────────────────────────────
function dailyState(u, now) {
  const t = now || Date.now();
  const last = u.lastDailySpinAt || 0;
  const ready = !last || t - last >= DAY;
  return {
    ready, nextAt: ready ? null : last + DAY,
    freeSpins: u.freeSpins || 0,
    streak: u.dailyStreak || 0,
    streakAlive: !!last && t - last < 2 * DAY,
    bestStreak: u.bestStreak || 0,
  };
}

function view(u) {
  const now = Date.now();
  const d = dailyState(u, now);
  const hh = happyHour(now);
  const pity = {};
  for (const [w, p] of Object.entries(E.PITY)) {
    const g = (u.pityGift && u.pityGift[w]) || 0;
    const n = (u.pityNft && u.pityNft[w]) || 0;
    pity[w] = { giftLeft: p.gift ? Math.max(1, p.gift - g) : null, nftLeft: p.nft ? Math.max(1, p.nft - n) : null };
  }
  const tk = users.tickets(u);
  const wheels = {};
  for (const [id, w] of Object.entries(E.WHEELS)) {
    if (w.disabled) continue;
    const st = { id, cost: w.cost, segments: segmentsView(id), pity: pity[id] };
    if (id === 'daily') Object.assign(st, { ready: d.ready || d.freeSpins > 0, nextAt: d.nextAt, freeSpins: d.freeSpins });
    if (id === 'referral') Object.assign(st, { ready: tk >= w.cost.tickets, spins: Math.floor(tk / w.cost.tickets) });
    if (id === 'paid') Object.assign(st, { ready: (u.paidSpinsGifted || 0) > 0 || users.stars(u) >= w.cost.stars, gifted: u.paidSpinsGifted || 0 });
    wheels[id] = st;
  }
  return {
    wheels, daily: d,
    happyHour: { active: hh.active, start: hh.start, end: hh.end },
  };
}

function logSpin(uid, wheel, extra) {
  const u = users.get(uid) || {};
  store.addWheelLogEvent({ ts: Date.now(), uid: String(uid), wheel, kind: 'spin', name: u.name || '—', username: u.username || null, extra });
}

function spinNotifyOn() { return !(store.getFeatureFlags() || {}).spinNotifyOff; }

// ─── Спін ───────────────────────────────────────────────────────────────
// Повертає { ok, ... } або { ok: false, error, status }.
async function spin(uid, wheel) {
  const w = E.WHEELS[wheel];
  if (!w || !Object.prototype.hasOwnProperty.call(E.WHEELS, wheel)) return { ok: false, status: 400, error: 'unknown_wheel' };
  if (w.disabled) return { ok: false, status: 410, error: 'wheel_disabled' };

  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    const now = Date.now();

    // 1. Перевірки — нічого не списуємо, доки не впевнені, що спін буде.
    const d = dailyState(u, now);
    let useFree = false, useGift = false;
    if (wheel === 'daily' && !d.ready) {
      if (d.freeSpins > 0) useFree = true;
      else return { ok: false, status: 429, error: 'daily_cooldown', nextAt: d.nextAt };
    }
    if (wheel === 'paid' && (u.paidSpinsGifted || 0) > 0) useGift = true;
    const payStars = useGift ? 0 : (w.cost.stars || 0);
    const payTickets = w.cost.tickets || 0;
    if (payStars > users.stars(u)) return { ok: false, status: 402, error: 'not_enough_stars', need: payStars, have: users.stars(u) };
    if (payTickets > users.tickets(u)) return { ok: false, status: 402, error: 'not_enough_tickets', need: payTickets, have: users.tickets(u) };

    // 2. Оплата й лічильники.
    if (payStars || payTickets) {
      const r = users.move(uid, { stars: -payStars, tickets: -payTickets }, 'spin', { wheel });
      if (!r.ok) return { ok: false, status: 402, error: 'not_enough' };
    }
    const patch = {};
    let streak = u.dailyStreak || 0, streakStars = 0;
    if (useGift) patch.paidSpinsGifted = (u.paidSpinsGifted || 0) - 1;
    if (wheel === 'daily') {
      if (useFree) patch.freeSpins = d.freeSpins - 1;
      else {
        streak = d.streakAlive ? streak + 1 : 1;
        patch.lastDailySpinAt = now;
        patch.dailyStreak = streak;
        patch.bestStreak = Math.max(u.bestStreak || 0, streak);
        streakStars = E.streakBonus(streak);
      }
    }

    // 3. Результат.
    const roll = rng.next(uid);
    const pityCfg = E.PITY[wheel] || {};
    const pg = (u.pityGift && u.pityGift[wheel]) || 0;
    const pn = (u.pityNft && u.pityNft[wheel]) || 0;
    let outcome, byPity = null;
    if (pityCfg.nft && pn + 1 >= pityCfg.nft) { outcome = E.NFT_IDS[Math.floor(roll.v * E.NFT_IDS.length)]; byPity = 'nft'; }
    else if (pityCfg.gift && pg + 1 >= pityCfg.gift) { outcome = E.GIFT_IDS[Math.floor(roll.v * E.GIFT_IDS.length)]; byPity = 'gift'; }
    else outcome = rng.pickWeighted(weightsFor(wheel, now), roll.v);

    const kind = outcomeKind(outcome);
    const amount = outcomeAmount(outcome);
    patch.pityGift = { ...(u.pityGift || {}), [wheel]: E.GIFT_IDS.includes(outcome) ? 0 : pg + 1 };
    patch.pityNft = { ...(u.pityNft || {}), [wheel]: E.NFT_IDS.includes(outcome) ? 0 : pn + 1 };
    patch.pendingRisk = kind === 'stars' && amount > 0 ? { amount, streak: 0, at: now, spinAt: now } : null;

    const isPaid = wheel === 'paid';
    const prizeValue = kind === 'prize' ? E.getTier(outcome).price : kind === 'stars' ? amount : 0;
    const best = u.bestWin || { value: 0 };
    Object.assign(patch, {
      spinsTotal: (u.spinsTotal || 0) + 1,
      paidSpinsTotal: (u.paidSpinsTotal || 0) + (isPaid ? 1 : 0),
      starsSpentTotal: round2((u.starsSpentTotal || 0) + payStars),
      starsEarnedTotal: round2((u.starsEarnedTotal || 0) + (kind === 'stars' ? amount : 0) + streakStars),
      ticketsWonTotal: (u.ticketsWonTotal || 0) + (kind === 'tickets' ? amount : 0),
      prizesWonTotal: (u.prizesWonTotal || 0) + (kind === 'prize' ? 1 : 0),
      bestWin: prizeValue > (best.value || 0) ? { value: prizeValue, outcomeId: outcome, at: now } : best,
      firstSeenAt: u.firstSeenAt || now,
      spinHistory: (u.spinHistory || []).concat([{
        id: outcome, sp: kind === 'prize' ? 1 : 0, am: kind === 'stars' ? amount : 0,
        tk: kind === 'tickets' ? amount : undefined, w: wheel, at: now, n: roll.nonce,
      }]).slice(-30),
    });
    users.patch(uid, patch);

    // 4. Виграш.
    let appId = null;
    if (kind === 'stars' && amount) users.move(uid, { stars: amount }, 'spin_win', { wheel, id: outcome });
    if (kind === 'tickets' && amount) users.move(uid, { tickets: amount }, 'spin_win', { wheel, id: outcome });
    if (streakStars) users.move(uid, { stars: streakStars }, 'streak', { streak });
    if (kind === 'prize') {
      const a = applications.create(uid, outcome, 'wheel_' + wheel);
      appId = a.id;
      const t = E.getTier(outcome);
      setTimeout(() => notify.announce('🎉 <b>' + whoOf(u) + '</b> щойно виграв <b>' + t.emoji + ' ' + esc(t.name.uk) + '</b> на колесі!'), 7000);
    }

    // 5. Досвід, ціль, журнал.
    if (isPaid) progress.addXp(uid, 'wager', payStars * E.XP_RATES.paidSpinPerStar);
    else progress.addXp(uid, 'spin', E.XP.spin.per);
    if (wheel === 'daily' && !useFree) progress.addXp(uid, 'quest', 20, { why: 'streak' });
    try { goal.addSpin(uid); } catch (e) { console.error('goal:', e.message); }
    quests.track(uid, wheel === 'daily' ? 'spin_daily' : wheel === 'referral' ? 'spin_tickets' : 'spin_paid');
    logSpin(uid, wheel, { outcomeId: outcome, isSpecial: kind === 'prize', streakBonus: streakStars, bonus: useFree || undefined, gift: useGift || undefined, nonce: roll.nonce });

    if (kind !== 'prize' && spinNotifyOn()) {
      setTimeout(() => {
        const uNow = users.get(uid) || {};
        const rr = uNow.lastRiskResult;
        const what = kind === 'tickets' ? `+${amount}🎫` : `+${amount}⭐`;
        const riskTxt = rr && rr.spinAt === now ? (rr.won ? ` → ризик ×2 виграв → +${rr.finalAmount}⭐` : ' → ризик ×2 злив → 0⭐') : '';
        notify.admin(`🎰 Спін (${w.title.uk}): ${what}${riskTxt}${streakStars ? ` (+${streakStars}⭐ за серію)` : ''}\n` +
          `Баланс: ${fmtStars(users.stars(uNow))}⭐ · ${esc(u.name || '—')} ${u.username ? '@' + u.username : ''} · id ${uid}`);
      }, 45000);
    }

    const after = users.get(uid);
    return {
      ok: true, wheel, outcome, kind, amount, streakBonus: streakStars, streak,
      segment: segmentIndex(wheel, outcome), applicationId: appId, byPity,
      usedFreeSpin: useFree, usedGift: useGift,
      proof: { nonce: roll.nonce, hash: roll.hash },
      riskAvailable: kind === 'stars' && amount > 0,
      balance: users.stars(after), tickets: users.tickets(after),
      state: view(after),
    };
  });
}

module.exports = { view, spin, happyHour, dailyState, segmentIndex, outcomeKind, outcomeAmount, segmentsView, logSpin };
