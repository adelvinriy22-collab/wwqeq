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

const SEASON_IDX = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / (30 * 86400000));
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
      // Мав ставку в банку, який попередня версія встигла скасувати, — банк має відновитись.
      900: U('900', { starBalance: 6, tickets: 2 }),
      // Пас у форматі справжнього giftbot: сезон «s9», 250 XP на рівень, куплений преміум.
      950: U('950', { pass: { season: 's' + SEASON_IDX, xp: 900, claimed: [3], claimedPrem: [1, 2, 3], premium: true, boughtAt: 1, wagerDay: '', wagerXpDay: 0 } }),
      951: U('951', { pass: { season: 's' + (SEASON_IDX - 1), xp: 5000, claimed: [], claimedPrem: [], premium: true } }),
      // Встиг витратити повернену ставку — з відновленого банку випадає.
      901: U('901', { starBalance: 0, tickets: 0 }),
      // Для /stars і /tickets.
      960: U('960', { starBalance: 6, tickets: 2 }),
      // Грає в кубик у чаті з ботом.
      970: U('970', { starBalance: 50 }),
      // Відкривають скриньки в чаті.
      980: U('980', { tickets: 0 }), 981: U('981', { tickets: 0 }),
      // Автовивід Мішки.
      985: U('985', {}),
      // Перший коментар під постом каналу.
      986: U('986', {}), 987: U('987', {}),
      // Клани: лідер (3-й рівень, 150🎫), учасники, заявка в закритий клан.
      990: U('990', { tickets: 150, ticketsUsed: 0, starBalance: 100, chatPts: 100 }), 991: U('991', { starBalance: 100 }),
      992: U('992', { starBalance: 100 }), 993: U('993', {}),
      // Розіграш автовидачі.
      995: U('995', {}), 996: U('996', {}), 997: U('997', {}),
    },
    giveaways: {}, applications: [], nextApplicationId: 1,
    featureFlags: {
      eventUnlocked: false,
      // Так банк лишила попередня версія: скасувала й повернула ставки, повідомлення ще не пішли.
      bank: { id: 'bank_prod', status: 'cancelled', reason: 'bank_removed', cancelledAt: Date.now(), drawAt: Date.now() + 86400e3,
              order: ['900', '901'], bets: { 900: 15, 901: 10 }, betStars: { 900: 5, 901: 10 }, betTickets: { 900: 2, 901: 0 },
              pot: 25, stars: 15, tickets: 2, feed: [], seed: 'a'.repeat(64), seedHash: 'x', winner: null, roll: null },
      bankRefundNotices: [{ uid: '900', what: '5⭐ + 2🎫' }, { uid: '901', what: '10⭐' }],
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
      SPIN_MIN_GAP_MS: '0', ADVANCED_UNLOCK_PASSWORD: 'secret', NO_SCHEDULERS: '1', USERGIFT_DRY_RUN: '1',
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
  // Пас зі справжнього giftbot: рівень той самий (900 XP / 250 = рівень 4), преміум і забрані нагороди збережено.
  const p950 = db.users['950'];
  assert.strictEqual(p950.pass.premium, true, 'куплений преміум-пас не втрачено');
  assert.deepStrictEqual(p950.pass.claimed, { free: [3], prem: [1, 2, 3] });
  assert.strictEqual(p950.xp.season.xp, 360);
  const pv = await api('GET', '/progress', null, '950');
  assert.strictEqual(pv.d.pass.level, 4);
  assert.strictEqual(pv.d.pass.premium, true);
  assert.strictEqual(db.users['951'].pass, null, 'пас минулого сезону не переноситься');
  const me = await api('GET', '/me');
  assert.strictEqual(me.status, 200, JSON.stringify(me.d));
  assert.strictEqual(me.d.balance.tickets, 23);
  assert.strictEqual(me.d.progress.level.n, 5, '310 XP — «Завсідник», як і було в чаті');
});

test('банк, скасований попередньою версією, відновлено з тими самими ставками', async () => {
  await sleep(500);   // база пишеться на диск із невеликою затримкою
  const db = readDb();
  const b = db.featureFlags.bank;
  assert.strictEqual(b.status, 'open');
  assert.strictEqual(b.reason, undefined);
  assert.deepStrictEqual(b.order, ['900'], '901 витратив повернене — випадає');
  assert.strictEqual(b.pot, 15);
  assert.strictEqual(db.users['900'].starBalance, 1, 'ставку 5⭐ знову в банку');
  assert.strictEqual(db.users['900'].tickets, 0, 'і 2🎫 теж');
  assert.strictEqual(db.users['901'].starBalance, 0, 'у мінус не йде');
  assert.deepStrictEqual(db.featureFlags.bankRefundNotices, [], 'повідомлення про «повернення» скасовано');
  const v = await api('GET', '/bank', null, '900');
  assert.strictEqual(v.d.active, true);
  assert.strictEqual(v.d.mine.chance, 100);
  let dm901;
  for (let i = 0; i < 20 && !dm901; i++) { await sleep(150); dm901 = tg.calls.find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '901'); }
  assert.ok(dm901 && /повернувся/.test(dm901.payload.text), 'тому, хто випав, прийшло повідомлення');
  assert.ok(!tg.calls.some(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '900'), '900 нічого не помітив — повідомлень не треба');
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
  assert.strictEqual(ex.d.stars, 1, 'курс: 10🎫 = 1⭐');
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

test('банк: адмін відкриває, гравець ставить, чужим адмінка закрита', async () => {
  assert.strictEqual((await api('GET', '/admin/overview', null, '700')).status, 403);
  const d = new Date(Date.now() + 2 * 86400000);
  const at = d.toISOString().slice(0, 10) + ' 21:00';
  await api('POST', '/admin/bank/cancel', {}, ADMIN);   // стартовий банк міг відкритись сам
  const st = await api('POST', '/admin/bank/start', { at }, ADMIN);
  assert.strictEqual(st.status, 200, JSON.stringify(st.d));
  const b = await api('POST', '/bank/bet', { stars: 5, tickets: 1 }, '400');
  assert.strictEqual(b.status, 200, JSON.stringify(b.d));
  assert.strictEqual(b.d.pot, 10, '5⭐ + 1🎫×5');
  const v = await api('GET', '/bank', null, '400');
  assert.strictEqual(v.d.mine.chance, 100);
  const cancel = await api('POST', '/admin/bank/cancel', {}, ADMIN);
  assert.strictEqual(cancel.status, 200);
});

test('адмін: /stars і /tickets нараховують і забирають', async () => {
  const bal = () => readDb().users['960'];
  const wait = async (pred) => { for (let i = 0; i < 30; i++) { await sleep(150); if (pred()) return true; } return false; };
  adminCmd('/stars user960 -2 помилкове нарахування');
  assert.ok(await wait(() => bal().starBalance === 4), 'забрано 2⭐');
  adminCmd('/tickets 960 5');
  assert.ok(await wait(() => bal().tickets === 7), 'нараховано 5🎫');
  adminCmd('/stars @user960 -100');
  assert.ok(await wait(() => bal().starBalance === 0), 'забрати більше, ніж є, — забирається все');
  const tx = bal().tx.slice(-3);
  assert.deepStrictEqual(tx.map(x => [x.s || 0, x.t || 0, x.r]), [[-2, 0, 'admin'], [0, 5, 'admin'], [-4, 0, 'admin']]);
  assert.strictEqual(tx[0].m.note, 'помилкове нарахування');
  // Не адмін — команда ігнорується.
  tg.push({ message: { message_id: 991, date: Math.floor(Date.now() / 1000), chat: { id: 700, type: 'private' }, from: { id: 700, is_bot: false, first_name: 'U' }, text: '/stars 700 1000', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  await sleep(700);
  assert.strictEqual(readDb().users['700'].starBalance < 1000, true);
});

test('ігри в боті: Telegram кидає кубик, результат і реакція, «Ще раз»', async () => {
  const from = { id: 970, is_bot: false, first_name: 'U970', username: 'user970' };
  const cb = (data) => tg.push({ callback_query: { id: 'q' + Math.random(), from, chat_instance: 'x', data, message: { message_id: 5, date: 0, chat: { id: 970, type: 'private' } } } });
  const n0 = tg.calls.length;
  cb('dice_menu');
  let menuMsg;
  for (let i = 0; i < 20 && !menuMsg; i++) { await sleep(150); menuMsg = tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '970'); }
  assert.ok(menuMsg && /dg:dice:even/.test(JSON.stringify(menuMsg.payload.reply_markup)), 'меню ігор з кнопками');
  // Фейковий Telegram завжди «кидає» 6: парне виграє ×1.85.
  cb('dp:dice:even:10');
  let res;
  for (let i = 0; i < 40 && !res; i++) { await sleep(200); res = tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '970' && /ВИГРАШ/i.test(c.payload.text || '')); }
  assert.ok(res, 'результат після анімації');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'sendDice' && c.payload.emoji === '🎲'), 'кубик кинув Telegram');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'setMessageReaction'), 'реакція на кубику');
  assert.match(JSON.stringify(res.payload.reply_markup), /dp:dice:even:10/, 'кнопка «Ще раз»');
  assert.match(JSON.stringify(res.payload.reply_markup), /back_to_menu/, 'кнопка «Назад» під результатом');
  assert.match(JSON.stringify(menuMsg.payload.reply_markup), /back_to_menu/, 'кнопка «Назад» у меню ігор');
  assert.match(res.payload.text, /<tg-emoji emoji-id="\d+">/, 'преміум-емодзі в результаті');
  // «Назад» під полем вводу показується один раз, після першого підекрана.
  const kb = tg.calls.slice(n0).filter(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '970' && c.payload.reply_markup && c.payload.reply_markup.keyboard);
  assert.strictEqual(kb.length, 1, 'кнопка «Назад» унизу — один раз');
  assert.strictEqual(kb[0].payload.reply_markup.is_persistent, true);
  await sleep(500);
  const u = readDb().users['970'];
  assert.strictEqual(u.starBalance, 58.5, '50 − 10 + 18.5');
  assert.strictEqual(u.diceGames, 1);
  // Своя ставка текстом.
  cb('do:dice:six');
  await sleep(400);
  tg.push({ message: { message_id: 993, date: Math.floor(Date.now() / 1000), chat: { id: 970, type: 'private' }, from, text: '3' } });
  for (let i = 0; i < 40; i++) { await sleep(200); if ((readDb().users['970'].diceGames || 0) >= 2) break; }
  assert.strictEqual(readDb().users['970'].starBalance, 58.5 - 3 + 15.6, 'рівно 6 ×5.2');
  // «Назад» під полем вводу: скасовує очікування ставки й показує головне меню.
  cb('do:dice:six');
  await sleep(400);
  const n1 = tg.calls.length;
  tg.push({ message: { message_id: 995, date: Math.floor(Date.now() / 1000), chat: { id: 970, type: 'private' }, from, text: 'Назад' } });
  let mm;
  for (let i = 0; i < 30 && !mm; i++) { await sleep(150); mm = tg.calls.slice(n1).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '970' && /my_profile/.test(JSON.stringify(c.payload.reply_markup || {}))); }
  assert.ok(mm, 'головне меню після «Назад»');
  tg.push({ message: { message_id: 996, date: Math.floor(Date.now() / 1000), chat: { id: 970, type: 'private' }, from, text: '3' } });
  await sleep(1000);
  assert.strictEqual(readDb().users['970'].diceGames, 2, 'після «Назад» число вже не ставка');
});

test('рівень у боті: фото рівня, сторінки гортаються в тому самому повідомленні', async () => {
  const from = { id: 970, is_bot: false, first_name: 'U970', username: 'user970' };
  const cb = (data, photo) => tg.push({ callback_query: { id: 'l' + Math.random(), from, chat_instance: 'x', data, message: { message_id: 7, date: 0, chat: { id: 970, type: 'private' }, ...(photo ? { photo: [{ file_id: 'F', width: 1280, height: 720 }] } : {}) } } });
  const n0 = tg.calls.length;
  cb('my_level');
  let ph;
  for (let i = 0; i < 20 && !ph; i++) { await sleep(150); ph = tg.calls.slice(n0).find(c => c.method === 'sendPhoto'); }
  assert.ok(ph, 'картка рівня — фото');
  const n1 = tg.calls.length;
  cb('lv:all:1', true);
  let ed;
  for (let i = 0; i < 20 && !ed; i++) { await sleep(150); ed = tg.calls.slice(n1).find(c => c.method === 'editMessageMedia'); }
  assert.ok(ed, 'сторінка «Усі рівні» — у тому самому повідомленні');
  assert.ok(!tg.calls.slice(n1).some(c => c.method === 'sendPhoto' || c.method === 'sendMessage'), 'без нових повідомлень');
});

test('скриньки в чаті: одна спроба на людину, головний приз — одному', async () => {
  const GROUP = -1001;
  const wait = async (pred) => { for (let i = 0; i < 30; i++) { await sleep(150); try { if (pred()) return true; } catch (e) {} } return false; };
  const gmsg = (from, text) => tg.push({ message: { message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: 'supergroup', title: 'G' }, from, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined } });
  const click = (uid, data) => tg.push({ callback_query: { id: 'b' + uid + Math.random(), from: { id: uid, is_bot: false, first_name: 'P' + uid }, chat_instance: 'g', data, message: { message_id: 1, date: 0, chat: { id: GROUP, type: 'supergroup' } } } });
  const answers = (uid) => tg.calls.filter(c => c.method === 'answerCallbackQuery' && String(c.payload.callback_query_id).startsWith('b' + uid));
  const n0 = tg.calls.length;
  gmsg({ id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, '/chat_here');
  assert.ok(await wait(() => tg.calls.slice(n0).some(c => c.method === 'sendMessage' && /прив/.test(c.payload.text || ''))), 'чат прив\'язано');
  adminCmd('/chat_boxes');
  let post;
  for (let i = 0; i < 30 && !post; i++) { await sleep(150); post = tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === String(GROUP) && /СКРИНЬКИ/.test(c.payload.text || '')); }
  assert.ok(post, 'скриньки опубліковано');
  const kb = post.payload.reply_markup.inline_keyboard;
  assert.strictEqual(kb.flat().length, 9);
  const id = kb[0][0].callback_data.split(':')[1];
  await sleep(500);
  const bx = readDb().featureFlags.chat.boxes;
  const empty = [...Array(9).keys()].find(i => i !== bx.mainIdx && !bx.small.includes(i));
  click(980, 'bx:' + id + ':' + empty);
  assert.ok(await wait(() => answers(980).length === 1), 'відповідь на першу скриньку');
  assert.match(answers(980)[0].payload.text, /Порожньо/);
  click(980, 'bx:' + id + ':' + bx.mainIdx);
  assert.ok(await wait(() => answers(980).length === 2));
  assert.match(answers(980)[1].payload.text, /вже відкрив/, 'друга спроба заборонена');
  click(981, 'bx:' + id + ':' + bx.mainIdx);
  assert.ok(await wait(() => answers(981).length === 1));
  assert.match(answers(981)[0].payload.text, /ПРИЗ/);
  const bal = (uid) => { const u = readDb().users[uid]; return (u.tickets || 0) + ':' + (u.starBalance || 0); };
  assert.ok(await wait(() => bal('981') === (bx.prize.tickets || 0) + ':' + (bx.prize.stars || 0)), 'головний приз нараховано');
  assert.strictEqual(bal('980'), '0:0', 'за порожню нічого');
  assert.ok(await wait(() => tg.calls.some(c => c.method === 'editMessageText' && /ВІДКРИТО/.test(c.payload.text || ''))), 'повідомлення оновлено');
});

test('/say: пост у чат від імені бота — текст, преміум-емодзі, кнопки, закріплення', async () => {
  const n0 = tg.calls.length;
  adminCmd('/say pin <b>Двіж!</b> {:starIcon} Сьогодні ×2 XP\n[🎰 Грати](https://t.me/TestStarBot)');
  let post;
  for (let i = 0; i < 20 && !post; i++) { await sleep(150); post = tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '-1001'); }
  assert.ok(post, 'пост у чаті');
  assert.match(post.payload.text, /<b>Двіж!<\/b> <tg-emoji emoji-id="\d+">⭐<\/tg-emoji> Сьогодні ×2 XP/);
  assert.doesNotMatch(post.payload.text, /\[🎰 Грати\]/, 'рядок кнопки не в тексті');
  assert.deepStrictEqual(post.payload.reply_markup.inline_keyboard, [[{ text: '🎰 Грати', url: 'https://t.me/TestStarBot' }]]);
  assert.ok(await (async () => { for (let i = 0; i < 20; i++) { await sleep(100); if (tg.calls.slice(n0).some(c => c.method === 'pinChatMessage')) return true; } return false; })(), 'закріплено');
});

test('автовивід: адмін відкриває, гравець пише підпис, бот надсилає Мішку — рівно один раз', async () => {
  const from = { id: 985, is_bot: false, first_name: 'P985', username: 'user985' };
  const cb = (data) => tg.push({ callback_query: { id: 'g' + Math.random(), from, chat_instance: 'x', data, message: { message_id: 9, date: 0, chat: { id: 985, type: 'private' } } } });
  const waitFor = async (pred) => { for (let i = 0; i < 30; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const n0 = tg.calls.length;
  adminCmd('/autowd @user985');
  const invite = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '985' && /ag:text/.test(JSON.stringify(c.payload.reply_markup || {}))));
  assert.ok(invite, 'гравцю прийшло запрошення');
  cb('ag:text');
  await sleep(400);
  tg.push({ message: { message_id: 2001, date: Math.floor(Date.now() / 1000), chat: { id: 985, type: 'private' }, from, text: 'Дякую за Мішку 🧸🔥', entities: [{ type: 'bold', offset: 0, length: 5 }, { type: 'url', offset: 6, length: 2 }] } });
  const preview = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '985' && c.payload.text === 'Дякую за Мішку 🧸🔥'));
  assert.ok(preview, 'підпис показано так, як його побачать');
  assert.match(JSON.stringify(preview.payload.reply_markup), /ag:send/);
  cb('ag:send');
  cb('ag:send');   // подвійне натискання
  const gift = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendGift'));
  assert.ok(gift, 'бот викликав sendGift');
  assert.strictEqual(gift.payload.user_id, 985);
  assert.strictEqual(gift.payload.text, 'Дякую за Мішку 🧸🔥');
  assert.deepStrictEqual(gift.payload.text_entities, [{ type: 'bold', offset: 0, length: 5 }], 'лише дозволене форматування');
  await sleep(600);
  assert.strictEqual(tg.calls.slice(n0).filter(c => c.method === 'sendGift').length, 1, 'подвійне натискання — одна Мішка');
  assert.strictEqual(readDb().users['985'].autoGift.status, 'sent');
  // Повторно — ні гравцю, ні адміну.
  cb('ag:plain');
  adminCmd('/autowd @user985');
  await sleep(800);
  assert.strictEqual(tg.calls.slice(n0).filter(c => c.method === 'sendGift').length, 1, 'автовивід одноразовий');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'sendMessage' && String(c.payload.chat_id) === ADMIN && /уже отримав/.test(c.payload.text || '')), 'адміну сказано, що вже отримав');
});

test('джекпот за активність: адмін обирає, Мішка видається одразу (sendGift) рівно раз, у чаті — фото й закріплення', async () => {
  const n0 = tg.calls.length;
  adminCmd('/jackpot https://t.me/starforge_chat/555 @user960');
  const waitFor = async (pred) => { for (let i = 0; i < 40; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const ask = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && /jp_555_bear/.test(JSON.stringify(c.payload.reply_markup || {}))));
  assert.ok(ask, 'адміну — вибір призу');
  const click = () => tg.push({ callback_query: { id: 'j' + Math.random(), from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, chat_instance: 'a', data: 'jp_555_bear', message: { message_id: 3, date: 0, chat: { id: Number(ADMIN), type: 'private' } } } });
  click(); click();
  const gift = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendGift'));
  assert.ok(gift, 'Мішку надіслано подарунком');
  assert.strictEqual(gift.payload.user_id, 960);
  assert.ok(await waitFor(() => tg.calls.slice(n0).some(c => c.method === 'pinChatMessage')), 'джекпот закріплено');
  assert.strictEqual(tg.calls.slice(n0).filter(c => c.method === 'sendGift').length, 1, 'подвійне натискання — одна Мішка');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '-1001' && /Хтось у чаті дуже активний/.test(c.payload.text || '')), 'інтрига в чаті');
  assert.ok(!tg.calls.slice(n0).some(c => /адмін/i.test(String(c.payload.text || c.payload.caption || '')) && String(c.payload.chat_id) !== ADMIN), 'ніде не видно, що обирає адмін');
  assert.ok(!tg.calls.slice(n0).some(c => c.method === 'sendDice'), 'це не гра — без кубика');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'sendPhoto'), 'картка JACKPOT');
  await sleep(500);
  const app = readDb().applications.find(a => a.uid === '960' && a.source === 'chat_jackpot');
  assert.ok(app && app.status === 'approved' && app.autoSent, 'в історії — видано автоматично');
});

test('перший коментар у каналі: бот ловить першого, кнопки лише для нього, подарунок одразу', async () => {
  const G = -2002;
  const waitFor = async (pred) => { for (let i = 0; i < 30; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const n0 = tg.calls.length;
  adminCmd('/first_gift');
  const post = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && c.payload.chat_id === '@starforge_news'));
  assert.ok(post, 'пост у каналі');
  assert.match(post.payload.text, /Першому коментарю — будь-який гіфт за 15⭐️/);
  const now = Math.floor(Date.now() / 1000);
  // Telegram копіює пост у групу обговорення.
  tg.push({ message: { message_id: 70, date: now, chat: { id: G, type: 'supergroup', title: 'Обговорення' }, from: { id: 777000, is_bot: false, first_name: 'Telegram' },
    sender_chat: { id: -100555, type: 'channel', title: 'Канал' }, is_automatic_forward: true, forward_origin: { type: 'channel', chat: { id: -100555, type: 'channel' }, message_id: post.payload.chat_id ? 1 : 1, date: now }, text: 'пост' } });
  await sleep(400);
  const comment = (id, mid, text) => tg.push({ message: { message_id: mid, date: now, chat: { id: G, type: 'supergroup' }, from: { id, is_bot: false, first_name: 'U' + id, username: 'user' + id },
    reply_to_message: { message_id: 70, date: now, chat: { id: G, type: 'supergroup' } }, message_thread_id: 70, text } });
  comment(986, 71, 'Я перший!');
  comment(987, 72, 'А я другий');
  const reply = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === String(G) && /fc:/.test(JSON.stringify(c.payload.reply_markup || {}))));
  assert.ok(reply, 'бот відповів першому');
  assert.strictEqual(reply.payload.reply_to_message_id, 71, 'саме на перший коментар');
  await sleep(400);
  assert.strictEqual(tg.calls.slice(n0).filter(c => c.method === 'sendMessage' && String(c.payload.chat_id) === String(G) && /fc:/.test(JSON.stringify(c.payload.reply_markup || {}))).length, 1, 'другий коментар — без кнопок');
  const data = reply.payload.reply_markup.inline_keyboard[0][1].callback_data;
  assert.match(data, /^fc:\w+:heart$/);
  const click = (id) => tg.push({ callback_query: { id: 'f' + id + Math.random(), from: { id, is_bot: false, first_name: 'U' + id }, chat_instance: 'g', data, message: { message_id: 90, date: now, chat: { id: G, type: 'supergroup' } } } });
  click(987);
  const alien = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'answerCallbackQuery' && /для переможця/.test(c.payload.text || '')));
  assert.ok(alien, 'чужий не може натиснути');
  click(986); click(986);
  const gift = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendGift'));
  assert.ok(gift, 'подарунок надіслано');
  assert.strictEqual(gift.payload.user_id, 986);
  await sleep(600);
  assert.strictEqual(tg.calls.slice(n0).filter(c => c.method === 'sendGift').length, 1, 'подвійне натискання — один подарунок');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'editMessageText' && /уже надіслано/.test(c.payload.text || '')), 'відповідь «подарунок надіслано»');
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'editMessageText' && c.payload.chat_id === '@starforge_news' && /Забрав/.test(c.payload.text || '')), 'у пості каналу — хто забрав');
});

test('клани: війна сама стартує, створення кнопкою за 3🎫, вступ в 1 клік із бонусом, скрині, фінал із призами', async () => {
  const GROUP = -1001;
  const waitFor = async (pred) => { for (let i = 0; i < 40; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const who = (id) => ({ id, is_bot: false, first_name: 'U' + id, username: 'user' + id });
  const gmsg = (id, text) => tg.push({ message: { message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: who(id), text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } });
  const pmsg = (id, text) => tg.push({ message: { message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: who(id), text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } });
  const click = (id, data, chatId) => tg.push({ callback_query: { id: 'c' + id + Math.random(), from: who(id), chat_instance: 'x', data, message: { message_id: 5, date: 0, chat: { id: chatId || id, type: chatId ? 'supergroup' : 'private' } } } });
  const sent = (n0, chat, re) => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === String(chat) && re.test(c.payload.text || ''));
  const clan = () => Object.values((readDb().featureFlags.clans || { list: {} }).list)[0];

  // Бот сам шукає чат через 3 с після старту — прив'язуємо після цього.
  await waitFor(() => tg.calls.some(c => c.method === 'getChat'));
  await sleep(300);
  let n0 = tg.calls.length;
  tg.push({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, text: '/chat_here', entities: [{ type: 'bot_command', offset: 0, length: 10 }] } });
  await waitFor(() => sent(n0, GROUP, /прив/));
  // Без білетів клан не створити (ціна — 3🎫, рівень не потрібен).
  gmsg(992, '/clan_create Слабаки');
  assert.ok(await waitFor(() => sent(n0, GROUP, /коштує 3🎫 \(у тебе 0\)/)), 'без білетів — відмова');
  assert.ok(sent(n0, GROUP, /КЛАНОВА ВІЙНА — 3 ДНІ/), 'перша війна стартувала сама, на 3 дні');
  const ev = await waitFor(() => (readDb().featureFlags.clans || {}).event);
  assert.ok(ev.endsAt - Date.now() > 71 * 3600e3 && ev.endsAt - Date.now() <= 73 * 3600e3, 'фінал через 3 дні');

  // Створення кнопкою: бот просить назву, її пишуть у відповідь.
  click(990, 'cl:new', GROUP);
  const ask = await waitFor(() => sent(n0, GROUP, /напиши назву свого клану/));
  assert.ok(ask, 'бот попросив назву');
  assert.strictEqual(ask.payload.reply_markup.force_reply, true);
  tg.push({ message: { message_id: 4001, date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: 'supergroup' }, from: who(990), text: '🐺 Вовки', reply_to_message: { message_id: 1, date: 0, chat: { id: GROUP, type: 'supergroup' } } } });
  assert.ok(await waitFor(() => sent(n0, GROUP, /Клан .*Вовки.* створено/)), 'клан створено');
  await sleep(300);
  let c = clan();
  assert.strictEqual(c.tag, 'ВОВК');
  assert.strictEqual(c.emoji, '🐺');
  assert.strictEqual(c.owner, '990');
  await sleep(300);
  const led = (uid, r) => ledger(uid).filter(e => e.r === r).map(e => e.t);
  assert.deepStrictEqual(led('990', 'clan_create'), [-3], 'створення коштує 3🎫');
  assert.deepStrictEqual(led('990', 'clan_bonus'), [25], 'лідеру одразу +25🎫');
  assert.ok(sent(n0, GROUP, /Бонус лідеру: <b>\+25🎫 \+100 XP<\/b>/), 'про бонус сказано');
  // Хто не запускав бота — кнопка відкриває бота, вступ після /start.
  click(12345, 'cl:q', GROUP);
  assert.ok(await waitFor(() => tg.calls.slice(n0).some(c => c.method === 'answerCallbackQuery' && /\?start=clan_q$/.test(c.payload.url || ''))), 'незареєстрованому — посилання на бота');

  // Відкритий клан — одразу; закритий — заявка лідеру з кнопками.
  gmsg(991, '/clan_join ВОВК');
  assert.ok(await waitFor(() => sent(n0, GROUP, /user991 вступив у клан[\s\S]*\+15🎫 \+50 XP/)), '991 у клані, +15🎫 +50 XP одразу');
  gmsg(990, '/clan_close');
  assert.ok(await waitFor(() => sent(n0, GROUP, /лише за заявкою/)));
  gmsg(993, '/clan_join вовки');
  const req = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '990' && /cl:a:/.test(JSON.stringify(c.payload.reply_markup || {}))));
  assert.ok(req, 'лідеру — заявка з кнопками');
  assert.ok(sent(n0, GROUP, /Заявку в клан/), 'гравцю — «заявку надіслано»');
  click(991, req.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.ok(await waitFor(() => tg.calls.slice(n0).some(c => c.method === 'answerCallbackQuery' && /лише лідер/.test(c.payload.text || ''))), 'учасник не приймає заявки');
  click(990, req.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.ok(await waitFor(() => sent(n0, 993, /прийнято в клан/)), '993 прийнято');
  gmsg(990, '/clan_open');
  await waitFor(() => sent(n0, GROUP, /Клан відкритий/));
  // Вступ в один клік — бот сам обирає відкритий клан.
  click(992, 'cl:q', GROUP);
  assert.ok(await waitFor(() => sent(n0, GROUP, /user992.*вступив/)), '992 вступив в 1 клік');
  await sleep(300);
  c = clan();
  assert.deepStrictEqual(c.members.slice().sort(), ['990', '991', '992', '993']);
  for (const id of ['991', '992', '993']) assert.deepStrictEqual(led(id, 'clan_join'), [15], id + ': бонус за вступ');
  assert.deepStrictEqual(led('990', 'clan_recruit'), [2, 2, 2], 'лідеру +2🎫 за кожного нового учасника');

  // Очки клану — XP учасників (ігри на зірки: 2 XP за ⭐).
  for (const id of ['990', '991', '992']) {
    const g = await api('POST', '/games/play', { game: 'dice', bet: 'even', stake: 20 }, id);
    assert.strictEqual(g.status, 200, JSON.stringify(g.d));
  }
  await sleep(300);
  c = clan();
  assert.strictEqual(c.ev.pts, 120, 'очки війни = XP учасників');
  assert.strictEqual(c.ev.contrib['991'], 40);
  // Скриня 1 (50 очок): +2🎫 кожному, хто приніс від 5 очок.
  assert.ok(await waitFor(() => sent(n0, GROUP, /відкрив[\s\S]*скриню 1\/4/)), 'у чаті — скриню відкрито');
  const chest = (uid) => ledger(uid).filter(e => e.r === 'clan_chest');
  for (const id of ['990', '991', '992']) assert.deepStrictEqual(chest(id).map(e => e.t), [2], id + ' отримав скриню');
  assert.strictEqual(chest('993').length, 0, 'без внеску — без скрині');

  // Один вхід /clan — далі кнопки, повідомлення редагується на місці.
  gmsg(991, '/clan');
  const hub = await waitFor(() => sent(n0, GROUP, /КЛАНОВА ВІЙНА[\s\S]*До фіналу[\s\S]*Вовки[\s\S]*120[\s\S]*Скриня 2\/4[\s\S]*ще <b>30<\/b> очок/));
  assert.ok(hub, 'хаб війни: час, мій клан, прогрес скрині');
  assert.match(hub.payload.text, /<tg-emoji emoji-id="\d+">/, 'преміум-емодзі');
  assert.match(JSON.stringify(hub.payload.reply_markup), /cl:my.*cl:l.*cl:help/, 'кнопки: мій клан, усі клани, як це працює');
  const e0 = tg.calls.length;
  click(991, 'cl:l', GROUP);
  assert.ok(await waitFor(() => tg.calls.slice(e0).find(c => c.method === 'editMessageText' && /УСІ КЛАНИ · 1[\s\S]*Вовки/.test(c.payload.text || ''))), 'усі клани — у тому самому повідомленні');
  click(991, 'cl:my', GROUP);
  const lb = await waitFor(() => tg.calls.slice(e0).find(c => c.method === 'editMessageText' && /ВОВКИ \[ВОВК\][\s\S]*user991 — 40/.test(c.payload.text || '')));
  assert.ok(lb, 'мій клан: лідерборд учасників');

  // Битва години: хто більше зіграє на зірки. Клан проти «Одинаків» (700 — без клану).
  let b0 = tg.calls.length;
  adminCmd('/clanwar battle games 30');
  assert.ok(await waitFor(() => sent(b0, GROUP, /БИТВА: ХТО БІЛЬШЕ ЗІГРАЄ НА ЗІРКИ/)), 'битва оголошена в чаті');
  assert.strictEqual((await api('POST', '/games/play', { game: 'dice', bet: 'even', stake: 10 }, '991')).status, 200);
  assert.strictEqual((await api('POST', '/games/play', { game: 'dice', bet: 'even', stake: 5 }, '700')).status, 200);
  click(991, 'cl:b', GROUP);
  const board = await waitFor(() => tg.calls.slice(b0).find(c => c.method === 'editMessageText' && /БИТВА[\s\S]*Вовки[\s\S]*10[\s\S]*Одинаки[\s\S]*5/.test(c.payload.text || '')));
  assert.ok(board, 'табло: клан попереду Одинаків');
  const ptsBefore = clan().ev.pts;
  adminCmd('/clanwar battle end');
  assert.ok(await waitFor(() => sent(b0, GROUP, /ПІДСУМОК БИТВИ[\s\S]*Перемога[\s\S]*Вовки/)), 'підсумок: переміг клан');
  await sleep(300);
  const bl = (uid, r) => ledger(uid).filter(e => e.r === r);
  assert.deepStrictEqual(bl('991', 'clan_battle').map(e => e.s), [3], 'топ-1 гравець: +3⭐');
  assert.deepStrictEqual(bl('700', 'clan_battle').map(e => e.s), [2], 'топ-2, навіть без клану: +2⭐');
  assert.deepStrictEqual(bl('991', 'clan_battle_win').map(e => e.t), [5], 'бійцю клану-переможця: +5🎫');
  assert.strictEqual(bl('990', 'clan_battle_win').length, 0, 'хто не бився — без бонусу команди');
  assert.strictEqual(clan().ev.pts, ptsBefore + 100, 'клану +100 очок у війні');
  const warPts = clan().ev.pts;

  // Фінал: активним (від 15 очок) — 7⭐ + 30🎫 + 100 XP, власнику — 🎁 за 25⭐.
  n0 = tg.calls.length;
  adminCmd('/clanwar finish');
  assert.ok(await waitFor(() => sent(n0, ADMIN, /Підсумки війни підбито/)), 'адміну — підсумки');
  const gift = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendGift'));
  assert.ok(gift, 'власнику — справжній подарунок');
  assert.strictEqual(gift.payload.user_id, 990);
  assert.strictEqual(gift.payload.gift_id, '5170250947678437525', '🎁 за 25⭐');
  assert.ok(await waitFor(() => sent(n0, GROUP, /ФІНАЛ КЛАНОВОЇ ВІЙНИ/)), 'оголошення в чаті');
  await sleep(300);
  const war = (uid) => ledger(uid).filter(e => e.r === 'clan_war');
  for (const id of ['990', '991', '992']) {
    assert.strictEqual(war(id).length, 1, id + ' нагороджено');
    assert.strictEqual(war(id)[0].s, 7);
    assert.strictEqual(war(id)[0].t, 30);
  }
  assert.strictEqual(war('993').length, 0, 'неактивний без призу');
  c = clan();
  assert.strictEqual(c.ev.pts, warPts, 'XP-нагорода не рахується в очки');
  assert.strictEqual(c.wins, 1);
  assert.strictEqual(readDb().featureFlags.clans.event.status, 'ended');
  // Повторно — війна вже не йде, подвійних нагород немає.
  adminCmd('/clanwar finish');
  assert.ok(await waitFor(() => sent(n0, ADMIN, /Війна зараз не йде/)));
  assert.strictEqual(war('991').length, 1, 'без подвійних нагород');
  // Нова війна — очки з нуля.
  adminCmd('/clanwar start 3');
  assert.ok(await waitFor(() => sent(n0, ADMIN, /стартувала на 3 дні/)));
  assert.ok(await waitFor(() => sent(n0, GROUP, /СТАРТУЄ КЛАНОВА ВІЙНА/)), 'оголошення нової війни');
  gmsg(991, '/clan');
  assert.ok(await waitFor(() => sent(n0, GROUP, /Вовки[\s\S]*<b>0<\/b> очок[\s\S]*Перше місце поки вільне/)), 'очки нової війни — з нуля');

  // Вихід: повернутись одразу не можна.
  n0 = tg.calls.length;
  pmsg(993, '/clan_leave');
  assert.ok(await waitFor(() => sent(n0, 993, /Ти вийшов із клану/)), 'вийшов (у приваті з ботом)');
  pmsg(993, '/clan_join ВОВК');
  assert.ok(await waitFor(() => sent(n0, 993, /через 6 год/)), 'повернення — через 6 год');
});

test('правила чату: /rules; скарга на заявку — видалення й бан на 7 днів, з 3-го разу — назавжди; розбан адміном', async () => {
  const GROUP = -1001;
  const waitFor = async (pred) => { for (let i = 0; i < 40; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const now = () => Math.floor(Date.now() / 1000);
  const gmsg = (id, text, mid) => tg.push({ message: { message_id: mid || Math.floor(Math.random() * 1e6), date: now(), chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id, is_bot: false, first_name: 'U' + id, username: 'user' + id }, text,
    entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined } });
  await waitFor(() => tg.calls.some(c => c.method === 'getChat'));
  let n0 = tg.calls.length;
  tg.push({ message: { message_id: 2, date: now(), chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, text: '/chat_here', entities: [{ type: 'bot_command', offset: 0, length: 10 }] } });
  await waitFor(() => tg.calls.slice(n0).some(c => c.method === 'sendMessage' && /прив/.test(c.payload.text || '')));
  const calls = (m) => tg.calls.slice(n0).filter(c => c.method === m);

  n0 = tg.calls.length;
  gmsg(987, '/rules');
  assert.ok(await waitFor(() => calls('sendMessage').find(c => /ПРАВИЛА ЧАТУ[\s\S]*заявки[\s\S]*бан на <b>7 днів/.test(c.payload.text || ''))), '/rules показує правило');
  gmsg(987, 'як зробити заявку на вивід?');
  await sleep(700);
  assert.strictEqual(calls('banChatMember').length, 0, 'звичайне питання — без бану');

  gmsg(987, 'заявку вже 3 дні не виплачують', 9001);
  const ban = await waitFor(() => calls('banChatMember')[0]);
  assert.ok(ban, 'бан');
  assert.strictEqual(ban.payload.user_id, 987);
  const days = (ban.payload.until_date - now()) / 86400;
  assert.ok(days > 6.9 && days <= 7.01, 'на 7 днів');
  assert.ok(calls('deleteMessage').some(c => c.payload.message_id === 9001), 'повідомлення видалено');
  assert.ok(await waitFor(() => calls('sendMessage').find(c => String(c.payload.chat_id) === String(GROUP) && /бан на 7 днів за правило чату/.test(c.payload.text || ''))), 'у чаті — пояснення');
  const toAdmin = await waitFor(() => calls('sendMessage').find(c => String(c.payload.chat_id) === ADMIN && /rules_unban_987/.test(JSON.stringify(c.payload.reply_markup || {}))));
  assert.ok(toAdmin, 'адміну — сповіщення з кнопкою «Розбанити»');

  gmsg(987, 'вивід не приходить, довго');
  gmsg(987, 'де мої зірки з заявки?');
  assert.ok(await waitFor(() => calls('banChatMember').length === 3), 'кожне порушення — бан');
  assert.strictEqual(calls('banChatMember')[2].payload.until_date, undefined, 'третій раз — назавжди');
  assert.ok(await waitFor(() => calls('sendMessage').find(c => /бан назавжди/.test(c.payload.text || ''))));

  tg.push({ callback_query: { id: 'rb' + Math.random(), from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, chat_instance: 'a', data: 'rules_unban_987', message: { message_id: 3, date: 0, chat: { id: Number(ADMIN), type: 'private' } } } });
  const un = await waitFor(() => calls('unbanChatMember')[0]);
  assert.ok(un && un.payload.user_id === 987, 'адмін розбанив');
});

test('секретне завдання сховане: ні на головній, ні в завданнях, заявку не подати', async () => {
  const me = await api('GET', '/me', null, '700');
  assert.strictEqual(me.status, 200, JSON.stringify(me.d));
  assert.strictEqual(me.d.partner.on, false);
  assert.strictEqual(me.d.showFeature, false, 'без спливаючого вікна');
  const pr = await api('GET', '/progress', null, '700');
  assert.strictEqual(pr.d.partner.on, false);
  const claim = await api('POST', '/partner/claim', {}, '700');
  assert.strictEqual(claim.status, 403);
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

test('/ugift: прев\'ю → зміна підпису → надсилання рівно раз, гравцю — привітання', async () => {
  const waitFor = async (pred) => { for (let i = 0; i < 30; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const click = (data) => tg.push({ callback_query: { id: 'u' + Math.random(), from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, chat_instance: 'a', data, message: { message_id: 4, date: 0, chat: { id: Number(ADMIN), type: 'private' } } } });
  const toAdmin = (n0, re) => tg.calls.slice(n0).filter(c => c.method === 'sendMessage' && String(c.payload.chat_id) === ADMIN && re.test(c.payload.text || ''));
  let n0 = tg.calls.length;
  adminCmd('/ugift @user985 heart Привіт <3');
  const pv = await waitFor(() => toAdmin(n0, /ПОДАРУНОК ВІД ВАШОГО АКАУНТА/)[0]);
  assert.ok(pv, 'прев\'ю');
  assert.match(pv.payload.text, /Серце/);
  assert.match(pv.payload.text, /<blockquote>Привіт &lt;3<\/blockquote>/);
  assert.match(JSON.stringify(pv.payload.reply_markup), /ug:send/);
  n0 = tg.calls.length;
  click('ug:text');
  await waitFor(() => toAdmin(n0, /Напишіть підпис/)[0]);
  tg.push({ message: { message_id: 3001, date: Math.floor(Date.now() / 1000), chat: { id: Number(ADMIN), type: 'private' }, from: { id: Number(ADMIN), is_bot: false, first_name: 'Admin' }, text: 'Ти топ!', entities: [{ type: 'bold', offset: 0, length: 2 }] } });
  const pv2 = await waitFor(() => toAdmin(n0, /<blockquote><b>Ти<\/b> топ!<\/blockquote>/)[0]);
  assert.ok(pv2, 'новий підпис з форматуванням');
  n0 = tg.calls.length;
  click('ug:send'); click('ug:send');
  assert.ok(await waitFor(() => toAdmin(n0, /ПОДАРУНОК НАДІСЛАНО/)[0]), 'картка успіху');
  const dm = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '985' && /ТОБІ ПОДАРУНОК/.test(c.payload.text || '')));
  assert.ok(dm, 'гравцю — привітання');
  assert.match(dm.payload.text, /<b>Ти<\/b> топ!/);
  await sleep(500);
  assert.strictEqual(toAdmin(n0, /ПОДАРУНОК НАДІСЛАНО/).length, 1, 'подвійне натискання — один подарунок');
});

test('/tg_login без TG_API_ID — підказка, які ключі додати', async () => {
  const n0 = tg.calls.length;
  adminCmd('/tg_login');
  let r;
  for (let i = 0; i < 20 && !r; i++) { await sleep(150); r = tg.calls.slice(n0).find(c => c.method === 'sendMessage' && /TG_API_HASH/.test(c.payload.text || '')); }
  assert.ok(r);
});

test('мега-розіграш: пост у каналі, участь, на N учасниках — призи за місцями', async () => {
  const waitFor = async (pred) => { for (let i = 0; i < 40; i++) { await sleep(150); const r = pred(); if (r) return r; } return null; };
  const cb = (id, data) => tg.push({ callback_query: { id: 'w' + Math.random(), from: { id, is_bot: false, first_name: 'P' + id, username: 'user' + id }, chat_instance: 'x', data, message: { message_id: 9, date: 0, chat: { id, type: 'private' } } } });
  const n0 = tg.calls.length;
  adminCmd('/awd_giveaway 3 1');
  const post = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && /МЕГА-РОЗІГРАШ/.test(c.payload.text || '') && /start=awdga/.test(JSON.stringify(c.payload.reply_markup || {}))));
  assert.ok(post, 'пост у каналі з кнопкою участі');
  assert.ok(await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && /awdga:join/.test(JSON.stringify(c.payload.reply_markup || {})))), 'розсилка');
  cb(995, 'awdga:join'); cb(995, 'awdga:join'); await sleep(300);
  cb(996, 'awdga:join'); await sleep(300);
  cb(997, 'awdga:join');
  await waitFor(() => readDb().featureFlags.awdGiveaway && readDb().featureFlags.awdGiveaway.status === 'done');
  const g = readDb().featureFlags.awdGiveaway;
  assert.strictEqual(g.status, 'done');
  assert.strictEqual(Object.keys(g.participants).length, 3, 'повторна участь не рахується');
  assert.strictEqual(g.winnerIds.length, 3, 'учасників менше, ніж місць — призи всім');
  const w = Number(g.winnerIds[0]);
  const dm = await waitFor(() => tg.calls.slice(n0).find(c => c.method === 'sendMessage' && String(c.payload.chat_id) === String(w) && /ТИ ПОСІВ 1 МІСЦЕ/.test(c.payload.text || '')));
  assert.ok(dm, 'переможцю — картка з місцем');
  assert.ok(await waitFor(() => tg.calls.slice(n0).filter(c => c.method === 'sendGift' && c.payload.user_id === w).length === 2), '1-ше місце — 🚀 і 🎁');
});

test('місія «підпишись на канал-спонсора»: бот перевіряє підписку, нагорода один раз', async () => {
  const call = (id) => fetch(base + '/api/sponsor/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Init-Data': init(id) }, body: '{}' }).then(r => r.json());
  const n0 = tg.calls.length;
  const r = await call('993');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tickets, 10);
  assert.ok(tg.calls.slice(n0).some(c => c.method === 'getChatMember' && c.payload.chat_id === '@Sanichkap'), 'перевірка в @Sanichkap');
  assert.strictEqual((await call('993')).error, 'already_done', 'нагорода один раз');
  const q = await (await fetch(base + '/api/progress', { headers: { 'X-Init-Data': init('993') } })).json();
  assert.strictEqual(q.sponsor.done, true);
});
