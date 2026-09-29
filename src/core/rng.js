// ==========================================================================
// ПЕРЕВІРЮВАНА ЧЕСНІСТЬ (provably fair) для коліс, ігор і ризику.
//
// У кожного гравця є секретний серверний seed. Гравець одразу бачить його
// sha256-відбиток, тобто seed зафіксовано ДО гри. Кожен результат:
//   hmac = HMAC_SHA256(seed, clientSeed + ':' + nonce)
//   число = перші 13 hex-символів / 16^13   (0 ≤ число < 1)
// Після зміни seed старий відкривається — і будь-хто перераховує всі свої
// результати сам (у застосунку є кнопка перевірки).
// ==========================================================================
const crypto = require('crypto');
const users = require('./users');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const HISTORY = 10;

function fresh(client) {
  const seed = crypto.randomBytes(32).toString('hex');
  return { seed, hash: sha256(seed), client: client || crypto.randomBytes(8).toString('hex'), nonce: 0, since: Date.now() };
}

function stateOf(uid) {
  const u = users.get(uid);
  if (!u) return null;
  if (!u.fair || !u.fair.seed) {
    const f = { ...fresh(), history: [] };
    users.patch(uid, { fair: f });
    return f;
  }
  return u.fair;
}

function hmacFor(seed, client, nonce) {
  return crypto.createHmac('sha256', seed).update(client + ':' + nonce).digest('hex');
}
function valueOf(hmac) { return parseInt(hmac.slice(0, 13), 16) / Math.pow(16, 13); }

// Наступне число для гравця. Повертає { v, nonce, hmac, hash }.
function next(uid) {
  const f = stateOf(uid);
  const nonce = f.nonce;
  const hmac = hmacFor(f.seed, f.client, nonce);
  users.patch(uid, { fair: { ...f, nonce: nonce + 1 } });
  return { v: valueOf(hmac), nonce, hmac, hash: f.hash };
}

// Відкрити поточний seed і почати новий.
function rotate(uid, client) {
  const f = stateOf(uid);
  const cleanClient = client ? String(client).replace(/[^\w-]/g, '').slice(0, 32) : null;
  const revealed = { seed: f.seed, hash: f.hash, client: f.client, nonces: f.nonce, since: f.since, until: Date.now() };
  const nf = { ...fresh(cleanClient || null), history: [revealed].concat(f.history || []).slice(0, HISTORY) };
  users.patch(uid, { fair: nf });
  return { revealed, current: publicState(nf) };
}

function publicState(f) {
  return {
    hash: f.hash, client: f.client, nonce: f.nonce, since: f.since,
    history: (f.history || []).map(h => ({ seed: h.seed, hash: h.hash, client: h.client, nonces: h.nonces, since: h.since, until: h.until })),
  };
}
function view(uid) { const f = stateOf(uid); return f ? publicState(f) : null; }

function verify(seed, client, nonce) {
  const hmac = hmacFor(seed, client, nonce);
  return { hash: sha256(seed), hmac, v: valueOf(hmac) };
}

// Зважений вибір за числом v (порядок ключів фіксований — як у конфігу).
function pickWeighted(weights, v) {
  const keys = Object.keys(weights);
  const total = keys.reduce((s, k) => s + weights[k], 0);
  let point = v * total;
  for (const k of keys) { point -= weights[k]; if (point < 0) return k; }
  return keys[keys.length - 1];
}
function face(v, faces) { return 1 + Math.min(faces - 1, Math.floor(v * faces)); }

module.exports = { next, rotate, view, verify, pickWeighted, face, sha256, valueOf };
