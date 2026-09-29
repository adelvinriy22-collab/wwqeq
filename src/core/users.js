// ==========================================================================
// ГРАВЦІ Й ГРОШІ.
//
// Єдиний спосіб змінити баланс — move(). Кожен рух зірок і білетів:
//   • перевіряється (баланс ніколи не йде в мінус);
//   • округлюється до сотих;
//   • записується в історію гравця (останні 60) і в журнал на диску.
// Так на будь-яке «куди зникли мої зірки» є точна відповідь.
// ==========================================================================
const store = require('../store');
const config = require('../config');
const { round2 } = require('../lib/util');

const TX_KEEP = 60;

function get(uid) { return store.getUser(String(uid)); }
function patch(uid, p) { return store.upsertUser(String(uid), p); }
function all() { return store.allUsers(); }
function isAdmin(uid) { return config.isAdminUid(uid); }

// Створити запис з об'єкта користувача Telegram (або оновити ім'я).
function ensure(from, extra) {
  const uid = String(from.id);
  const u = get(uid);
  const name = from.first_name || '';
  const username = from.username || null;
  if (!u) {
    return patch(uid, {
      id: uid, name, username, lang: null, v: 3,
      joinedAt: Date.now(), firstSeenAt: Date.now(), lastActiveAt: Date.now(),
      starBalance: 0, tickets: 0, invitedIds: [], subscribed: false,
      xp: null, ...(extra || {}),
    });
  }
  if (u.name !== name || u.username !== username || u.id !== uid) {
    return patch(uid, { id: uid, name: name || u.name || '', username });
  }
  return u;
}

function stars(u) { return round2((u && u.starBalance) || 0); }
function tickets(u) { return Math.max(0, Math.floor((u && u.tickets) || 0)); }

// Рух коштів. delta: { stars, tickets } (додатні — нарахування, від'ємні — списання).
// Повертає { ok: true, stars, tickets } або { ok: false, error: 'insufficient', ... }.
function move(uid, delta, reason, meta) {
  uid = String(uid);
  const u = get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  const ds = round2(delta.stars || 0);
  const dt = Math.trunc(delta.tickets || 0);
  if (!ds && !dt) return { ok: true, stars: stars(u), tickets: tickets(u) };
  const ns = round2(stars(u) + ds);
  const nt = tickets(u) + dt;
  if (ns < 0 && !(delta.allowNegative)) return { ok: false, error: 'insufficient', currency: 'stars', have: stars(u), need: -ds };
  if (nt < 0 && !(delta.allowNegative)) return { ok: false, error: 'insufficient', currency: 'tickets', have: tickets(u), need: -dt };
  const tx = { ts: Date.now(), s: ds || undefined, t: dt || undefined, r: reason, m: meta || undefined };
  const txs = (u.tx || []).concat([tx]).slice(-TX_KEEP);
  patch(uid, { starBalance: ns, tickets: Math.max(0, nt), tx: txs });
  store.appendLedger({ ts: tx.ts, uid, s: ds, t: dt, r: reason, m: meta || null, bs: ns, bt: Math.max(0, nt) });
  return { ok: true, stars: ns, tickets: Math.max(0, nt) };
}

// ─── Блокування на гравця ───────────────────────────────────────────────
// Дві дії з балансом одного гравця не виконуються одночасно: друга чекає
// першу (до timeoutMs), а не отримує помилку «зачекай».
const chains = new Map();
async function withLock(uid, fn, timeoutMs) {
  uid = String(uid);
  const prev = chains.get(uid) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  const chain = prev.then(() => mine);
  chains.set(uid, chain);
  let timer;
  const waited = await Promise.race([
    prev.then(() => true),
    new Promise(r => { timer = setTimeout(() => r(false), timeoutMs || 8000); }),
  ]);
  clearTimeout(timer);
  if (!waited) {
    // Попередня дія зависла — не блокуємо людину назавжди, але й не
    // виконуємо паралельно: повертаємо «зайнято».
    release();
    if (chains.get(uid) === chain) chains.delete(uid);
    const e = new Error('busy'); e.code = 'busy'; throw e;
  }
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(uid) === chain) chains.delete(uid);
  }
}

function displayName(u) {
  if (!u) return 'гравець';
  if (u.anonymous) return 'Гравець #' + String(u.id || '').slice(-4);
  if (u.username) return '@' + u.username;
  return (u.name || '').trim() || 'Гравець #' + String(u.id || '').slice(-4);
}

function findByUsernameOrId(q) {
  const w = String(q || '').replace(/^@/, '').trim().toLowerCase();
  if (!w) return null;
  if (get(w)) return get(w);
  for (const u of Object.values(all())) if (u && u.username && u.username.toLowerCase() === w) return u;
  return null;
}

module.exports = { get, patch, all, ensure, stars, tickets, move, withLock, isAdmin, displayName, findByUsernameOrId };
