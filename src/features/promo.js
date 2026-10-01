// Промокоди: зірки, білети, бонусні спіни й автовидача (одноразова Мішка від бота).
// Кожен гравець — один раз на код. forUid — код лише для одного гравця.
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');

// Автовидачу відкриває модуль бота (bot/autogift.js) — через хук, без циклічних залежностей.
const hooks = { onAutowd: [] };

function what(p) {
  const out = [];
  if (p.amount) out.push('+' + p.amount + '⭐');
  if (p.tickets) out.push('+' + p.tickets + ' 🎫');
  if (p.spins) out.push('+' + p.spins + ' 🎰');
  if (p.autowd) out.push('🧸 Автовидача');
  return out.join(' · ');
}

async function redeem(uid, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase().slice(0, 40);
  if (!code) return { ok: false, error: 'bad' };
  const r = await users.withLock(uid, () => {
    const p = store.getPromoCode(code);
    if (!p || p.deleted) return { ok: false, error: 'bad' };
    if (p.forUid && String(p.forUid) !== String(uid)) return { ok: false, error: 'bad' };
    if (p.autowd && ((users.get(uid) || {}).autoGift || {}).status === 'sent') return { ok: false, error: 'used' };
    const used = p.usedBy || [];
    if (used.includes(String(uid))) return { ok: false, error: 'used' };
    if (p.usesLeft != null && used.length >= p.usesLeft) return { ok: false, error: 'limit' };
    if (p.expiresAt && Date.now() > p.expiresAt) return { ok: false, error: 'bad' };
    p.usedBy = used.concat([String(uid)]);
    store.setPromoCode(code, p);
    if (p.amount || p.tickets) users.move(uid, { stars: p.amount || 0, tickets: p.tickets || 0 }, 'promo', { code });
    if (p.spins) users.patch(uid, { freeSpins: ((users.get(uid) || {}).freeSpins || 0) + p.spins });
    progress.addXp(uid, 'quest', 30, { why: 'promo' });
    const u = users.get(uid);
    return { ok: true, code, what: what(p), autowd: !!p.autowd, balance: users.stars(u), tickets: users.tickets(u) };
  });
  if (r.ok && r.autowd) for (const h of hooks.onAutowd) { try { await h(String(uid), code); } catch (e) { console.error('promo autowd:', e.message); } }
  return r;
}

// «10з 3б 2с 50» → зірки, білети, спіни, кількість активацій.
function parseRewards(tokens) {
  const r = { stars: 0, tickets: 0, spins: 0, uses: null, autowd: false };
  for (const tk of tokens) {
    if (/^(авто|auto|awd)$/i.test(String(tk))) { r.autowd = true; continue; }
    const m = String(tk).toLowerCase().match(/^(\d+)(з|z|s|б|b|t|с|c|sp)?$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (u === 'з' || u === 'z' || u === 's') r.stars = n;
    else if (u === 'б' || u === 'b' || u === 't') r.tickets = n;
    else if (u === 'с' || u === 'c' || u === 'sp') r.spins = n;
    else r.uses = n;
  }
  return r;
}

function create(code, r) {
  const c = String(code || '').toUpperCase().trim();
  if (!c || !/^[A-ZА-ЯІЇЄҐ0-9_-]{2,40}$/.test(c)) return { ok: false, error: 'bad_code' };
  if (!r.stars && !r.tickets && !r.spins && !r.autowd) return { ok: false, error: 'no_reward' };
  if (store.getPromoCode(c)) return { ok: false, error: 'exists' };
  store.setPromoCode(c, { amount: r.stars || 0, tickets: r.tickets || 0, spins: r.spins || 0, autowd: !!r.autowd || undefined, forUid: r.forUid || undefined, usesLeft: r.uses || null, usedBy: [], createdAt: Date.now() });
  return { ok: true, code: c };
}
function remove(code) {
  const c = String(code || '').toUpperCase();
  if (!store.getPromoCode(c)) return false;
  store.setPromoCode(c, { amount: 0, tickets: 0, spins: 0, usesLeft: 0, usedBy: [], deleted: true });
  return true;
}
function list() {
  return Object.entries(store.listPromoCodes() || {}).filter(([, p]) => p && !p.deleted).map(([code, p]) => ({
    code, what: what(p), used: (p.usedBy || []).length, limit: p.usesLeft, createdAt: p.createdAt || 0,
  })).sort((a, b) => b.createdAt - a.createdAt);
}

// Стартові коди попередніх версій.
function ensureDefaults() {
  if (!store.listPromoCodes()['STAR3']) store.setPromoCode('STAR3', { amount: 3, usesLeft: null, usedBy: [], createdAt: Date.now() });
}

module.exports = { hooks, redeem, parseRewards, create, remove, list, what, ensureDefaults };
