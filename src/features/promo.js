// Промокоди: зірки, білети й бонусні спіни. Кожен гравець — один раз на код.
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');

function what(p) {
  const out = [];
  if (p.amount) out.push('+' + p.amount + '⭐');
  if (p.tickets) out.push('+' + p.tickets + ' 🎫');
  if (p.spins) out.push('+' + p.spins + ' 🎰');
  return out.join(' · ');
}

async function redeem(uid, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase().slice(0, 40);
  if (!code) return { ok: false, error: 'bad' };
  return users.withLock(uid, () => {
    const p = store.getPromoCode(code);
    if (!p) return { ok: false, error: 'bad' };
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
    return { ok: true, code, what: what(p), balance: users.stars(u), tickets: users.tickets(u) };
  });
}

// «10з 3б 2с 50» → зірки, білети, спіни, кількість активацій.
function parseRewards(tokens) {
  const r = { stars: 0, tickets: 0, spins: 0, uses: null };
  for (const tk of tokens) {
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
  if (!r.stars && !r.tickets && !r.spins) return { ok: false, error: 'no_reward' };
  if (store.getPromoCode(c)) return { ok: false, error: 'exists' };
  store.setPromoCode(c, { amount: r.stars || 0, tickets: r.tickets || 0, spins: r.spins || 0, usesLeft: r.uses || null, usedBy: [], createdAt: Date.now() });
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

module.exports = { redeem, parseRewards, create, remove, list, what, ensureDefaults };
