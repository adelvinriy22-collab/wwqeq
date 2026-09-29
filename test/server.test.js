// Інтеграційні тести: справжній src/index.js проти фейкового Telegram Bot API.
// База засіюється у СТАРОМУ форматі (v2) — заразом перевіряємо міграцію.
// Запуск: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
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

function seedV2() {
  const db = {
    users: {
      // v2: білети = tickets + друзі − ticketsUsed; очки чату окремо.
      100: U('100', { starBalance: 100, invitedIds: ['a1', 'a2', 'a3'], tickets: 20, ticketsUsed: 0, freeSpins: 300, chatPts: 310 }),
      200: U('200', { starBalance: 3, lastDailySpinAt: Date.now() }),
      300: U('300', { starBalance: 50, username: null }),
      400: U('400', { starBalance: 40, tickets: 12, ticketsUsed: 2 }),
      // Виграв 10⭐, але вже витратив: на балансі 3⭐.
      500: U('500', { starBalance: 3, pendingRisk: { amount: 10, streak: 0, at: Date.now(), spinAt: Date.now() } }),
      501: U('501', { starBalance: 30, pendingRisk: { amount: 10, streak: 0, at: Date.now(), spinAt: Date.now() } }),
      // Для паралельних виводів: вистачає рівно на один.
      600: U('600', { starBalance: 25, invitedIds: ['b1', 'b2', 'b3'] }),
      700: U('700', { starBalance: 60 }),
      // Мав ставку у відкритому банку — банк прибрано, ставка має повернутись.
      900: U('900', { starBalance: 1, tickets: 0 }),
    },
    giveaways: {}, applications: [], nextApplicationId: 1,
    featureFlags: {
      eventUnlocked: false, event: null,
      bank: { id: 'bank_old', status: 'open', drawAt: Date.now() + 3600e3, order: ['900'], bets: { 900: 15 }, betStars: { 900: 5 }, betTickets: { 900: 2 }, pot: 15, stars: 5, tickets: 2 },
      bankAuto: { enabled: true, hour: 21 },
    }, event: null,
    passwordChallenge: null, externalRefPool: null, wheelLog: [], promoCodes: {},
  };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db));
}

const init = (id) => signInitData(TOKEN, { id: Number(id), first_name: 'User' + id, username: id === '300' ? undefined : 'user' + id });
async function api(method, url, body, id, raw) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'content-type': 'application/json', 'x-init-data': raw !== undefined ? raw : init(id || '100') },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}
const readDb = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ledger(uid) {
  const out = [];
  for (const f of fs.readdirSync(dataDir).filter(x => /^ledger-.*\.jsonl$/.test(x))) {
    for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (!uid || e.uid === uid) out.push(e);
    }
  }
  return out;
}
const round2 = (n) => Math.round(n * 100) / 100;

function adminCmd(text) {
  tg.push({ message: {
    message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000), chat: { id: Number(ADMIN), type: 'private' },
    from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  } });
}

before(async () => {
  tg = await startFakeTelegram();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-'));
  seedV2();
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  proc = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: ADMIN, DATA_DIR: dataDir, PORT: String(port),
      TELEGRAM_API_ROOT: 'http://127.0.0.1:' + tg.port, WEBAPP_URL: 'https://example.com/app',
      SPIN_MIN_GAP_MS: '0', ADVANCED_UNLOCK_PASSWORD: 'secret', NO_SCHEDULERS: '1',
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

test('міграція v2 → v3: білети, досвід, резервна копія', async () => {
  const db = readDb();
  assert.strictEqual(db.meta.schema, 3);
  assert.ok(fs.readdirSync(dataDir).some(f => /^db\.pre-v3-from-v2-/.test(f)), 'резервна копія перед міграцією');
  assert.strictEqual(db.users['100'].tickets, 23, '20 білетів + 3 друзі');
  assert.strictEqual(db.users['400'].tickets, 10, '12 − 2 витрачені');
  assert.strictEqual(db.users['100'].ticketsUsed, undefined);
  assert.strictEqual(db.users['100'].xp.total, 310, 'очки чату → XP (титул той самий)');
  const me = await api('GET', '/me');
  assert.strictEqual(me.status, 200, JSON.stringify(me.d));
  assert.strictEqual(me.d.balance.tickets, 23);
  assert.strictEqual(me.d.progress.level.n, 5, '310 XP — «Завсідник», як і було в чаті');
});

test('статика: застосунок із версією, модулі й картинки', async () => {
  const h = await (await fetch(base + '/health')).json();
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/js/app.js?v=' + h.build), 'версія підставлена');
  assert.ok(!html.includes('%BUILD%'));
  assert.strictEqual((await fetch(base + '/wheel.html')).status, 200, 'старі посилання ведуть у новий застосунок');
  const js = await fetch(base + '/js/app.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  assert.strictEqual((await fetch(base + '/img/bear.png')).status, 200);
  assert.strictEqual((await fetch(base + '/js/nope.js')).status, 404);
});

test('initData: підробка й прострочення відхиляються', async () => {
  assert.strictEqual((await api('GET', '/me', null, null, init('100') + 'x')).status, 401);
  const old = signInitData(TOKEN, { id: 100 }, Math.floor(Date.now() / 1000) - 30 * 86400);
  assert.strictEqual((await api('GET', '/me', null, null, old)).status, 401);
  assert.strictEqual((await api('GET', '/me', null, null, '')).status, 401);
});

test('150 спінів: жодної помилки, стрілка на своєму секторі, баланс = журнал', async () => {
  const me = (await api('GET', '/me')).d;
  const segs = me.wheels.wheels.daily.segments;
  const s0 = me.balance.stars, t0 = me.balance.tickets;
  const l0 = ledger('100').length;
  let errors = 0, last = null;
  for (let i = 0; i < 150; i++) {
    const r = await api('POST', '/spin', { wheel: 'daily' });
    if (r.status !== 200) { errors++; continue; }
    last = r.d;
    const seg = segs[r.d.segment];
    assert.ok(seg, 'сектор існує');
    assert.strictEqual(seg.kind, r.d.kind, 'сектор того ж типу, що й результат');
    if (r.d.kind !== 'prize') assert.strictEqual(seg.id, r.d.outcome, 'точний сектор для зірок і білетів');
  }
  assert.strictEqual(errors, 0);
  await sleep(700);
  const moves = ledger('100').slice(l0);
  const ds = round2(moves.reduce((a, e) => a + (e.s || 0), 0));
  const dt = moves.reduce((a, e) => a + (e.t || 0), 0);
  const u = readDb().users['100'];
  assert.strictEqual(round2(u.starBalance), round2(s0 + ds), 'зірки: баланс = сума журналу');
  assert.strictEqual(u.tickets, t0 + dt, 'білети: баланс = сума журналу');
  assert.strictEqual(last.balance, u.starBalance);
  assert.strictEqual(moves[moves.length - 1].bs, u.starBalance, 'останній запис журналу = поточний баланс');
  assert.ok(u.xp.total > 310, 'спіни дають XP');
});

test('кулдаун щоденного колеса', async () => {
  const r = await api('POST', '/spin', { wheel: 'daily' }, '200');
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.d.error, 'daily_cooldown');
});

test('колесо білетів списує 5🎫; преміум-колесо вимкнене', async () => {
  const t0 = (await api('GET', '/me', null, '400')).d.balance.tickets;
  const r = await api('POST', '/spin', { wheel: 'referral' }, '400');
  assert.strictEqual(r.status, 200, JSON.stringify(r.d));
  assert.ok(r.d.tickets <= t0 - 5 + (r.d.kind === 'tickets' ? r.d.amount : 0) + 10);
  assert.strictEqual((await api('POST', '/spin', { wheel: 'premium' }, '400')).status, 410);
  assert.strictEqual((await api('POST', '/spin', { wheel: '__proto__' }, '400')).status, 400);
});

test('вивід: умови, комісія, заявка', async () => {
  assert.strictEqual((await api('POST', '/wallet/withdraw', { amount: 20 }, '300')).d.error, 'need_referrals');
  assert.strictEqual((await api('POST', '/wallet/withdraw', { amount: 14 })).d.error, 'bad_amount');
  const ok = await api('POST', '/wallet/withdraw', { amount: 20 });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.d));
  assert.strictEqual(ok.d.cost, 21);
  await sleep(600);
  const app = readDb().applications.find(a => a.id === ok.d.applicationId);
  assert.strictEqual(app.spentStars, 21);
  assert.strictEqual(app.status, 'pending');
});

test('паралельні виводи: проходить рівно один (блокування на гравця)', async () => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', '/wallet/withdraw', { amount: 20 }, '600')));
  assert.strictEqual(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.d.error || 'ok')));
  await sleep(600);
  assert.strictEqual(readDb().users['600'].starBalance, 4);
});

test('ризик ×2: не можна ризикнути витраченим, баланс не йде в мінус', async () => {
  const spent = await api('POST', '/risk', null, '500');
  assert.strictEqual(spent.status, 400);
  assert.strictEqual(spent.d.error, 'spent');
  const ok = await api('POST', '/risk', null, '501');
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.d));
  assert.strictEqual(ok.d.balance, ok.d.won ? 40 : 20);
});

test('обмін білетів і ігри на зірки', async () => {
  const ex = await api('POST', '/wallet/exchange', { tickets: 10 });
  assert.strictEqual(ex.status, 200, JSON.stringify(ex.d));
  assert.strictEqual(ex.d.stars, 2);
  assert.strictEqual((await api('POST', '/wallet/exchange', { tickets: 7 })).d.error, 'bad_amount');
  const bad = await api('POST', '/games/play', { game: 'dice', bet: 'even', stake: 0 }, '700');
  assert.strictEqual(bad.d.error, 'bad_bet');
  const g = await api('POST', '/games/play', { game: 'dice', bet: 'even', stake: 10 }, '700');
  assert.strictEqual(g.status, 200, JSON.stringify(g.d));
  assert.strictEqual(g.d.won, [2, 4, 6].includes(g.d.value));
  assert.strictEqual(g.d.balance, round2(60 - 10 + (g.d.won ? 18.5 : 0)));
});

test('чесність: результат гри перевіряється відкритим seed', async () => {
  const f0 = (await api('GET', '/fair', null, '700')).d;
  const g = await api('POST', '/games/play', { game: 'dice', bet: 'six', stake: 1 }, '700');
  assert.strictEqual(g.d.proof.hash, f0.hash);
  const rot = await api('POST', '/fair/rotate', {}, '700');
  const seed = rot.d.revealed.seed;
  assert.strictEqual(crypto.createHash('sha256').update(seed).digest('hex'), f0.hash, 'seed відповідає показаному відбитку');
  const hmac = crypto.createHmac('sha256', seed).update(rot.d.revealed.client + ':' + g.d.proof.nonce).digest('hex');
  const v = parseInt(hmac.slice(0, 13), 16) / Math.pow(16, 13);
  assert.strictEqual(1 + Math.min(5, Math.floor(v * 6)), g.d.value, 'кубик перераховується вручну');
  assert.notStrictEqual(rot.d.current.hash, f0.hash);
});

test('банк прибрано: ставки з відкритого банку повернуто, API банку немає', async () => {
  const db = readDb();
  assert.strictEqual(db.users['900'].starBalance, 6, '1⭐ + повернуті 5⭐');
  assert.strictEqual(db.users['900'].tickets, 2, 'повернуті 2🎫');
  assert.strictEqual(db.featureFlags.bank.status, 'cancelled');
  assert.strictEqual(db.featureFlags.bankAuto.enabled, false);
  assert.strictEqual((await api('GET', '/bank', null, '900')).status, 404);
  assert.strictEqual((await api('POST', '/admin/bank/start', { at: '2030-01-01 21:00' }, ADMIN)).status, 404);
  assert.strictEqual((await api('GET', '/admin/overview', null, '700')).status, 403, 'чужим адмінка закрита');
  const me = await api('GET', '/me', null, '900');
  assert.strictEqual(me.d.bank, undefined);
  let dm;
  for (let i = 0; i < 20 && !dm; i++) { await sleep(150); dm = tg.calls.find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '900'); }
  assert.ok(dm && /5⭐ \+ 2🎫/.test(dm.payload.text), 'гравцю повідомили про повернення');
});

test('адмін: /stars і /tickets нараховують і забирають', async () => {
  const bal = () => readDb().users['900'];
  const wait = async (pred) => { for (let i = 0; i < 30; i++) { await sleep(150); if (pred()) return true; } return false; };
  adminCmd('/stars user900 -2 помилкове нарахування');
  assert.ok(await wait(() => bal().starBalance === 4), 'забрано 2⭐');
  adminCmd('/tickets 900 5');
  assert.ok(await wait(() => bal().tickets === 7), 'нараховано 5🎫');
  adminCmd('/stars @user900 -100');
  assert.ok(await wait(() => bal().starBalance === 0), 'забрати більше, ніж є, — забирається все');
  const tx = bal().tx.slice(-3);
  assert.deepStrictEqual(tx.map(x => [x.s || 0, x.t || 0, x.r]), [[-2, 0, 'admin'], [0, 5, 'admin'], [-4, 0, 'admin']]);
  assert.strictEqual(tx[0].m.note, 'помилкове нарахування');
  // Не адмін — команда ігнорується.
  tg.push({ message: { message_id: 991, date: Math.floor(Date.now() / 1000), chat: { id: 700, type: 'private' }, from: { id: 700, is_bot: false, first_name: 'U' }, text: '/stars 700 1000', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  await sleep(700);
  assert.strictEqual(readDb().users['700'].starBalance < 1000, true);
});

test('пас: закритий рівень не видається; промокод один раз', async () => {
  const locked = await api('POST', '/pass/claim', { level: 30, track: 'free' }, '700');
  assert.strictEqual(locked.status, 200);
  assert.strictEqual(locked.d.results.length, 0);
  const mk = await api('POST', '/admin/promo', { code: 'TEST5', stars: 5, uses: 10 }, ADMIN);
  assert.strictEqual(mk.status, 200, JSON.stringify(mk.d));
  const r1 = await api('POST', '/promo', { code: 'test5' }, '700');
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.d));
  assert.strictEqual((await api('POST', '/promo', { code: 'TEST5' }, '700')).d.error, 'used');
});

test('оплата: зараховується сплачена сума, повтор ігнорується', async () => {
  const before = readDb().users['200'].starBalance;
  const msg = (charge) => ({ message: {
    message_id: 50, date: Math.floor(Date.now() / 1000), chat: { id: 200, type: 'private' },
    from: { id: 200, is_bot: false, first_name: 'User200', username: 'user200' },
    successful_payment: {
      currency: 'XTR', total_amount: 10, invoice_payload: JSON.stringify({ uid: '200', type: 'topup', amount: 999 }),
      telegram_payment_charge_id: charge, provider_payment_charge_id: '',
    },
  } });
  tg.push(msg('ch_1'));
  tg.push(msg('ch_1'));
  for (let i = 0; i < 40; i++) { await sleep(150); if (readDb().users['200'].depositCount) break; }
  await sleep(500);
  const u = readDb().users['200'];
  assert.strictEqual(round2(u.starBalance - before), 11, '10⭐ + 10% бонус, не 999 і не двічі');
  assert.strictEqual(u.depositCount, 1);
});

test('бот: /start створює гравця й пропонує застосунок', async () => {
  tg.push({ message: {
    message_id: 77, date: Math.floor(Date.now() / 1000), chat: { id: 800, type: 'private' },
    from: { id: 800, is_bot: false, first_name: 'Nova', username: 'nova', language_code: 'en' }, text: '/start ref_100', entities: [{ type: 'bot_command', offset: 0, length: 6 }],
  } });
  let sent;
  for (let i = 0; i < 30 && !sent; i++) { await sleep(150); sent = tg.calls.find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '800'); }
  assert.ok(sent, 'бот відповів');
  assert.match(JSON.stringify(sent.payload.reply_markup), /web_app/);
  await sleep(500);
  const u = readDb().users['800'];
  assert.strictEqual(u.lang, 'en');
  assert.ok(readDb().users['100'].invitedIds.includes('800'), 'реферал зараховано після підписки');
});

test('техроботи full блокують дії через API', async () => {
  adminCmd('/maint full');
  let r;
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    r = await api('POST', '/spin', { wheel: 'daily' });
    if (r.status === 503) break;
  }
  assert.strictEqual(r.status, 503);
  const me = await api('GET', '/me', null, '700');
  assert.strictEqual(me.d.maintenance.mode, 'full');
  adminCmd('/maint off');
});
