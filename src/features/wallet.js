// ==========================================================================
// ГАМАНЕЦЬ: поповнення Telegram Stars, вивід, обмін білетів, магазин, історія.
// ==========================================================================
const E = require('../economy');
const config = require('../config');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const i18n = require('../i18n');
const applications = require('./applications');
const passSvc = require('./pass');
const maintenance = require('./maintenance');
const { round2, fmtStars } = require('../lib/util');

// ─── Вивід ──────────────────────────────────────────────────────────────
function withdrawInfo(u) {
  const refs = (u.invitedIds || []).length;
  const bal = users.stars(u);
  let max = Math.floor(bal / (1 + E.WITHDRAW.feePercent / 100));
  while (max > 0 && E.withdrawCost(max).cost > bal) max--;
  return {
    min: E.WITHDRAW.min, feePercent: E.WITHDRAW.feePercent,
    needRefs: E.WITHDRAW.minReferrals, haveRefs: refs, hasUsername: !!u.username,
    maxPayout: Math.max(0, max), blocked: maintenance.state().mode !== 'off',
  };
}

async function withdraw(uid, amount) {
  const m = maintenance.state();
  if (m.mode !== 'off' && !users.isAdmin(uid)) return { ok: false, status: 503, error: 'maintenance', message: m.text };
  const payout = Number(amount);
  if (!Number.isInteger(payout) || payout < E.WITHDRAW.min) return { ok: false, status: 400, error: 'bad_amount', min: E.WITHDRAW.min };
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    const refs = (u.invitedIds || []).length;
    if (!users.isAdmin(uid) && refs < E.WITHDRAW.minReferrals) return { ok: false, status: 400, error: 'need_referrals', need: E.WITHDRAW.minReferrals, have: refs };
    if (!u.username) return { ok: false, status: 400, error: 'need_username' };
    const w = E.withdrawCost(payout);
    const r = users.move(uid, { stars: -w.cost }, 'withdraw', { payout: w.payout });
    if (!r.ok) return { ok: false, status: 402, error: 'not_enough', balance: users.stars(u), cost: w.cost, payout: w.payout };
    const a = applications.create(uid, 'stars_payout', 'app_withdrawal', { payoutStars: w.payout, spentStars: w.cost, fee: w.fee });
    notify.dm(uid, i18n.t(u.lang, 'wd.created', { id: a.id, payout: w.payout, cost: w.cost, fee: w.fee }));
    return { ok: true, applicationId: a.id, payout: w.payout, cost: w.cost, fee: w.fee, balance: r.stars };
  });
}

// ─── Обмін білетів ──────────────────────────────────────────────────────
async function exchange(uid, tickets) {
  const n = Math.floor(Number(tickets) || 0);
  const step = E.TICKETS.exchangeTickets;
  if (n < step || n % step !== 0) return { ok: false, status: 400, error: 'bad_amount', step };
  return users.withLock(uid, () => {
    const stars = n / step * E.TICKETS.exchangeStars;
    const r = users.move(uid, { tickets: -n, stars }, 'exchange', { tickets: n });
    if (!r.ok) return { ok: false, status: 402, error: 'not_enough_tickets', have: users.tickets(users.get(uid)) };
    return { ok: true, tickets: n, stars, balance: r.stars, ticketsLeft: r.tickets };
  });
}

// ─── Магазин ────────────────────────────────────────────────────────────
function shopView(u, lang) {
  const have = u.paidSpinsTotal || 0;
  return {
    unlockSpins: E.SHOP.unlockPaidSpins, haveSpins: have, unlocked: have >= E.SHOP.unlockPaidSpins,
    items: E.SHOP.items.map(id => { const t = E.getTier(id); return { id, name: E.tierName(id, lang), emoji: t.emoji, img: t.img, price: E.shopPrice(t) }; }),
    exclusive: ['wheel_stocking', 'wheel_snake', 'wheel_lolpop', 'wheel_eye', 'premium3m'].map(id => ({ id, name: E.tierName(id, lang), img: E.getTier(id).img, value: E.getTier(id).price })),
  };
}
async function shopBuy(uid, itemId) {
  if (!E.SHOP.items.includes(itemId)) return { ok: false, status: 400, error: 'unknown_item' };
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    if ((u.paidSpinsTotal || 0) < E.SHOP.unlockPaidSpins) return { ok: false, status: 403, error: 'need_spins', need: E.SHOP.unlockPaidSpins, have: u.paidSpinsTotal || 0 };
    const t = E.getTier(itemId);
    const price = E.shopPrice(t);
    const r = users.move(uid, { stars: -price }, 'shop', { item: itemId });
    if (!r.ok) return { ok: false, status: 402, error: 'not_enough', balance: users.stars(u), price };
    const a = applications.create(uid, itemId, 'shop', { spentStars: price });
    return { ok: true, applicationId: a.id, balance: r.stars, name: E.tierName(itemId, u.lang) };
  });
}

// ─── Поповнення ─────────────────────────────────────────────────────────
function depositBonus(u, amount) {
  if (((u && u.depositCount) || 0) >= E.DEPOSIT.bonusTimes) return 0;
  return Math.round(amount * E.DEPOSIT.bonusPercent) / 100;
}
function topupInfo(u) {
  return {
    presets: E.DEPOSIT.presets, max: config.TOPUP_MAX,
    bonusPercent: E.DEPOSIT.bonusPercent, bonusLeft: Math.max(0, E.DEPOSIT.bonusTimes - ((u && u.depositCount) || 0)),
  };
}
function parseAmount(raw) {
  const a = parseInt(String(raw == null ? '' : raw).replace(/\s/g, ''), 10);
  if (!a || a < 1) return { error: 'bad_amount' };
  if (a > config.TOPUP_MAX) return { error: 'too_much', max: config.TOPUP_MAX };
  return { amount: a };
}

async function invoiceLink(uid, kind, amount) {
  const tg = notify.tg.telegram;
  if (!tg) return { ok: false, status: 503, error: 'bot_offline' };
  const u = users.get(uid) || {};
  let title, description, price, payload;
  if (kind === 'topup') {
    const p = parseAmount(amount);
    if (p.error) return { ok: false, status: 400, error: p.error, max: config.TOPUP_MAX };
    const bonus = depositBonus(u, p.amount);
    price = p.amount;
    title = `StarForge: +${price}⭐`;
    description = bonus ? `${price}⭐ на баланс + бонус ${fmtStars(bonus)}⭐` : `${price}⭐ на внутрішній баланс StarForge`;
    payload = { uid: String(uid), type: 'topup', starsAmount: price, ts: Date.now() };
  } else if (kind === 'pass') {
    if (passSvc.stateOf(u).premium) return { ok: false, status: 400, error: 'already_premium' };
    price = E.PASS.priceXtr;
    title = 'Платна лінія сезонного пасу';
    description = `Нагороди платної лінії й +${E.PASS.xtrBonusLevels} рівні одразу. Фінал — Мішка, спін і 30⭐.`;
    payload = { uid: String(uid), type: 'pass_premium', ts: Date.now() };
  } else return { ok: false, status: 400, error: 'bad_kind' };
  try {
    const link = await tg.createInvoiceLink({ title, description, payload: JSON.stringify(payload), currency: 'XTR', prices: [{ label: title, amount: price }] });
    return { ok: true, link, price };
  } catch (e) {
    console.error('invoice failed:', e.message);
    return { ok: false, status: 500, error: 'invoice_failed', reason: e.message };
  }
}

function parsePayload(raw) {
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && p.uid ? p : null; } catch (e) { return null; }
}

// Відповідь на pre_checkout: null — усе добре, рядок — причина відмови.
function precheck(q) {
  const payload = parsePayload(q.invoice_payload);
  if (q.currency !== 'XTR') return 'Непідтримувана валюта.';
  if (!payload) return 'Рахунок пошкоджено. Створи новий.';
  if (String(payload.uid) !== String(q.from.id)) return 'Цей рахунок створено для іншого акаунта.';
  if (payload.type === 'premium_spin' && E.WHEELS.premium.disabled) return 'Преміум-колесо вимкнено.';
  if (payload.type === 'pass_premium' && passSvc.stateOf(users.get(q.from.id) || {}).premium) return 'Платна лінія вже відкрита.';
  return null;
}

// Успішна оплата. Зараховуємо РЕАЛЬНО сплачену суму (total_amount), а не
// число з payload. Дубль того самого платежу ігнорується.
async function processPayment(payment, fromId, fromUser) {
  const payload = parsePayload(payment.invoice_payload);
  const paid = payment.currency === 'XTR' ? Math.max(0, parseInt(payment.total_amount, 10) || 0) : 0;
  const uid = String(payload && payload.uid ? payload.uid : fromId);
  const charge = payment.telegram_payment_charge_id || '';
  const f = store.getFeatureFlags() || {};
  const seen = f.paidCharges || [];
  if (charge && seen.includes(charge)) return { ok: false, duplicate: true };
  if (charge) store.setFeatureFlags({ paidCharges: seen.concat([charge]).slice(-1000) });
  if (!users.get(uid) && fromUser) users.ensure(fromUser);
  const u = users.get(uid) || {};
  const lg = u.lang || 'uk';
  console.log(`💳 Оплата ${paid} XTR від ${fromId} (${(payload && payload.type) || 'topup'}) charge=${charge}`);
  if (!paid) {
    notify.admin('⚠️ Платіж без суми XTR від ' + fromId + ': <code>' + JSON.stringify(payment).slice(0, 400) + '</code>');
    return { ok: false, error: 'no_amount' };
  }
  const credit = (whyKey) => {
    const r = users.move(uid, { stars: paid }, 'topup', { charge, note: payload && payload.type });
    notify.dm(uid, i18n.t(lg, 'pay.credited', { why: i18n.t(lg, whyKey), stars: paid, balance: fmtStars(r.stars) }));
    return r;
  };

  if (payload && payload.type === 'pass_premium') {
    const r = passSvc.unlock(uid, 'xtr');
    if (!r.ok) credit('pay.passAlready');
    else {
      notify.dm(uid, i18n.t(lg, 'pay.passOpened', { levels: E.PASS.xtrBonusLevels }), notify.appKeyboard(i18n.t(lg, 'btn.open'), 'pass'));
      notify.admin(`💎 Пас за реальні зірки: ${paid}⭐ · ${uid}`);
    }
    return { ok: true, type: 'pass' };
  }
  if (payload && payload.type === 'premium_spin') {
    if (E.WHEELS.premium.disabled) credit('pay.premiumOff');
    else users.patch(uid, { premiumSpinsAvailable: (u.premiumSpinsAvailable || 0) + 1 });
    return { ok: true, type: 'premium_spin' };
  }
  // Поповнення (+10% на перші три).
  const bonus = depositBonus(u, paid);
  users.move(uid, { stars: paid }, 'topup', { charge });
  if (bonus) users.move(uid, { stars: bonus }, 'topup_bonus', { charge });
  users.patch(uid, { depositCount: (u.depositCount || 0) + 1, depositedTotal: round2((u.depositedTotal || 0) + paid) });
  if (paid >= 5) progress.addXp(uid, 'deposit', E.XP.deposit.per);
  const bal = users.stars(users.get(uid));
  notify.dm(uid, i18n.t(lg, 'pay.topup', { stars: paid, bonus: bonus ? i18n.t(lg, 'pay.bonus', { bonus: fmtStars(bonus) }) : '', balance: fmtStars(bal) }),
    notify.appKeyboard(i18n.t(lg, 'btn.open')));
  if (paid >= 50) notify.admin(`💳 Поповнення ${paid}⭐ від ${u.username ? '@' + u.username : uid}`);
  return { ok: true, type: 'topup', paid, bonus };
}

// ─── Історія транзакцій ─────────────────────────────────────────────────
function history(u) {
  return (u.tx || []).slice().reverse().map(x => ({ at: x.ts, stars: x.s || 0, tickets: x.t || 0, reason: x.r, meta: x.m || null }));
}

module.exports = {
  withdrawInfo, withdraw, exchange, shopView, shopBuy,
  topupInfo, invoiceLink, precheck, processPayment, history, depositBonus, parseAmount,
};
