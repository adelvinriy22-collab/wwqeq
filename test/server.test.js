// Інтеграційні тести: справжній server.js проти фейкового Telegram Bot API.
// Запуск: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeTelegram, signInitData } = require('./helpers');

const TOKEN = '123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz';
const ADMIN = '999';
const ROOT = path.join(__dirname, '..');
let tg, proc, base, dataDir;

const U = (id, extra) => ({
  id, name: 'User' + id, username: 'user' + id, lang: 'uk', subscribed: true,
  invitedIds: [], starBalance: 0, joinedAt: Date.now(), lastActiveAt: Date.now(), ...extra,
});

function seed() {
  const db = {
    users: {
      100: U('100', { starBalance: 100, invitedIds: ['a1', 'a2', 'a3'], tickets: 20, freeSpins: 300 }),
      200: U('200', { starBalance: 3, lastDailySpinAt: Date.now() }),
      300: U('300', { starBalance: 50, username: null }),
      400: U('400', { starBalance: 40, tickets: 10 }),
      // Виграв 10⭐, але вже витратив їх: на балансі лишилось 3⭐.
      500: U('500', { starBalance: 3, pendingRisk: { amount: 10, streak: 0, at: Date.now(), spinAt: Date.now() } }),
      501: U('501', { starBalance: 30, pendingRisk: { amount: 10, streak: 0, at: Date.now(), spinAt: Date.now() } }),
    },
    giveaways: {}, applications: [], nextApplicationId: 1,
    featureFlags: { eventUnlocked: false, bank: null }, event: null,
    passwordChallenge: null, externalRefPool: null, wheelLog: [], promoCodes: {},
  };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db));
}

async function api(method, url, body) {
  const r = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}
const init = (id) => signInitData(TOKEN, { id: Number(id), first_name: 'User' + id, username: 'user' + id });
const readDb = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  tg = await startFakeTelegram();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-'));
  seed();
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: ADMIN, DATA_DIR: dataDir, PORT: String(port),
      TELEGRAM_API_ROOT: 'http://127.0.0.1:' + tg.port, WEBAPP_URL: 'https://example.com/wheel.html',
      SPIN_MIN_GAP_MS: '0', ADVANCED_UNLOCK_PASSWORD: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (c) => { proc.log += c; });
  proc.stderr.on('data', (c) => { proc.log += c; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (e) {}
    await sleep(100);
  }
});

after(async () => {
  if (proc) { proc.kill('SIGTERM'); await sleep(500); }
  if (tg) tg.server.close();
  if (process.env.SHOW_LOG) console.log(proc && proc.log);
});

test('health і статичні картинки', async () => {
  const h = await api('GET', '/health');
  assert.strictEqual(h.status, 200);
  const img = await fetch(base + '/img/bear.png');
  assert.strictEqual(img.status, 200);
  assert.match(img.headers.get('cache-control') || '', /max-age/);
  const page = await fetch(base + '/wheel.html');
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.length < 400000, 'wheel.html без вбудованих base64-картинок');
});

test('initData: підробка й прострочення відхиляються', async () => {
  assert.strictEqual((await api('GET', '/api/wheel-status?initData=' + encodeURIComponent(init(100) + 'x'))).status, 401);
  const old = signInitData(TOKEN, { id: 100 }, Math.floor(Date.now() / 1000) - 30 * 86400);
  assert.strictEqual((await api('GET', '/api/wheel-status?initData=' + encodeURIComponent(old))).status, 401);
  const ok = await api('GET', '/api/wheel-status?initData=' + encodeURIComponent(init(100)));
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.d));
  // Колесо «за білети» відкривають білети: 20 + 3 друзі = 23 → 4 спіни.
  assert.strictEqual(ok.d.tickets, 23);
  assert.strictEqual(ok.d.referral.available, 4);
  assert.strictEqual(ok.d.referral.unlocked, true);
});

test('щоденне колесо: жоден спін не падає, білетні виграші зараховуються', async () => {
  const before = readDb().users['100'];
  let tix = 0, stars = 0, errors = 0, n = 0, lastBal = null;
  for (let i = 0; i < 150; i++) {
    const r = await api('POST', '/api/spin', { initData: init(100), wheel: 'daily' });
    if (r.status !== 200) { errors++; continue; }
    n++;
    if (r.d.wonTickets) tix += r.d.wonTickets;
    stars += (r.d.amount || 0) + (r.d.streakBonus || 0);
    lastBal = r.d.balance;
  }
  assert.strictEqual(errors, 0, 'усі спіни мають повертати 200');
  assert.ok(tix > 0, 'за 150 спінів мають випасти білети (~27%)');
  await sleep(600);
  const u = readDb().users['100'];
  assert.strictEqual(u.spinsTotal, n);
  assert.strictEqual(Math.round(u.starBalance * 100) / 100, Math.round((before.starBalance + stars) * 100) / 100);
  assert.strictEqual(lastBal, u.starBalance);
  assert.strictEqual(u.tickets, before.tickets + tix);
  assert.ok(u.spinHistory.length > 0);
  const prof = await api('GET', '/api/profile?initData=' + encodeURIComponent(init(100)));
  assert.ok(!prof.d.history.some(h => /\+0⭐/.test(h.name)), 'історія не показує «+0⭐» для білетів');
});

test('кулдаун щоденного колеса без бонусних спінів', async () => {
  const r = await api('POST', '/api/spin', { initData: init(200), wheel: 'daily' });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.d.error, 'daily_cooldown');
});

test('колесо за білети списує 5 білетів', async () => {
  const t0 = (await api('GET', '/api/wheel-status?initData=' + encodeURIComponent(init(400)))).d.tickets;
  const r = await api('POST', '/api/spin', { initData: init(400), wheel: 'referral' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.d));
  assert.strictEqual(r.d.tickets, t0 - 5 + (r.d.wonTickets || 0));
});

test('тапалка вимкнена', async () => {
  assert.strictEqual((await api('POST', '/api/tap', { initData: init(100), count: 100 })).status, 410);
});

test('преміум-колесо: спін не продається', async () => {
  assert.strictEqual((await api('POST', '/api/create-spin-invoice', { initData: init(100) })).status, 410);
  assert.strictEqual((await api('POST', '/api/spin', { initData: init(100), wheel: 'premium' })).status, 410);
});

test('вивід: умови й коректні причини відмови', async () => {
  const noUser = await api('POST', '/api/withdraw', { initData: init(300), amount: 20 });
  assert.strictEqual(noUser.d.error, 'need_referrals');
  const bad = await api('POST', '/api/withdraw', { initData: init(100), amount: 14 });
  assert.strictEqual(bad.d.error, 'bad_amount');
  const ok = await api('POST', '/api/withdraw', { initData: init(100), amount: 20 });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.d));
  assert.strictEqual(ok.d.cost, 21);
  await sleep(600);   // база пишеться на диск із невеликою затримкою
  const app = readDb().applications.find(a => a.id === ok.d.applicationId);
  assert.strictEqual(app.spentStars, 21);
});

test('ризик ×2 неможливий, якщо виграш уже витрачено', async () => {
  const spent = await api('POST', '/api/risk', { initData: init(500) });
  assert.strictEqual(spent.status, 400);
  assert.strictEqual(spent.d.error, 'spent');
  // Той самий ризик із зірками на балансі — працює, і баланс ніколи не йде в мінус.
  const ok = await api('POST', '/api/risk', { initData: init(501) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.d));
  assert.strictEqual(ok.d.balance, ok.d.won ? 40 : 20);
});

test('обмін білетів на зірки', async () => {
  const r = await api('POST', '/api/tickets-convert', { initData: init(100), tickets: 10 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.d));
  assert.strictEqual(r.d.stars, 2);
});

test('оплата: зараховується реально сплачена сума, повтор ігнорується', async () => {
  const before = readDb().users['200'].starBalance;
  const msg = (charge) => ({
    message: {
      message_id: 50, date: Math.floor(Date.now() / 1000), chat: { id: 200, type: 'private' },
      from: { id: 200, is_bot: false, first_name: 'User200', username: 'user200' },
      successful_payment: {
        currency: 'XTR', total_amount: 10,
        invoice_payload: JSON.stringify({ uid: '200', starsAmount: 999, ts: Date.now() }),
        telegram_payment_charge_id: charge, provider_payment_charge_id: '',
      },
    },
  });
  tg.push(msg('ch_1'));
  tg.push(msg('ch_1'));
  for (let i = 0; i < 40; i++) { await sleep(150); if (readDb().users['200'].depositCount) break; }
  await sleep(400);
  const u = readDb().users['200'];
  // 10⭐ + бонус 10% = 11⭐, а не 999 з payload і не двічі.
  assert.strictEqual(Math.round((u.starBalance - before) * 100) / 100, 11);
  assert.strictEqual(u.depositCount, 1);
});

test('техроботи full блокують дії через API', async () => {
  tg.push({
    message: {
      message_id: 51, date: Math.floor(Date.now() / 1000), chat: { id: Number(ADMIN), type: 'private' },
      from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' },
      text: '/maint full', entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  });
  let r;
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    r = await api('POST', '/api/spin', { initData: init(100), wheel: 'daily' });
    if (r.status === 503) break;
  }
  assert.strictEqual(r.status, 503);
});
