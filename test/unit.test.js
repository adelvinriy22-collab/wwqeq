// Юніт-тести економіки й чесності — без мережі й бота.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-unit-'));
process.env.BOT_TOKEN = '';
const E = require('../src/economy');
const time = require('../src/lib/time');
const core = require('../src/features/bankcore');
const wheels = require('../src/features/wheels');
const rng = require('../src/core/rng');
const users = require('../src/core/users');
const progress = require('../src/core/progress');

test('ігри: очікуваний виграш менший за ставку (RTP 85–95%)', () => {
  for (const [id, g] of Object.entries(E.GAMES)) {
    for (const [bid, b] of Object.entries(g.bets)) {
      let ev = 0;
      if (b.slots) { for (let v = 1; v <= g.faces; v++) ev += E.slotResult(v).k / g.faces; }
      else ev = b.win.length / g.faces * b.k;
      assert.ok(ev > 0.85 && ev < 0.95, `${id}/${bid}: RTP ${ev.toFixed(3)}`);
    }
  }
});

test('колеса: кожен можливий результат має сектор того ж типу', () => {
  for (const [wid, w] of Object.entries(E.WHEELS)) {
    if (w.disabled) continue;
    for (const id of Object.keys(w.weights)) {
      const i = wheels.segmentIndex(wid, id);
      const seg = wheels.segmentsView(wid)[i];
      assert.ok(seg, `${wid}/${id}`);
      assert.strictEqual(seg.kind, wheels.outcomeKind(id), `${wid}/${id} → ${seg.id}`);
    }
  }
});

test('час Києва: перехід на літній/зимовий час не зсуває години', () => {
  // 29 березня 2026 — перехід на літній час (UTC+3), 25 жовтня — на зимовий (UTC+2).
  assert.strictEqual(new Date(time.parseKyiv('2026-03-28 21:00')).toISOString(), '2026-03-28T19:00:00.000Z');
  assert.strictEqual(new Date(time.parseKyiv('2026-03-30 21:00')).toISOString(), '2026-03-30T18:00:00.000Z');
  assert.strictEqual(new Date(time.parseKyiv('2026-10-26 21:00')).toISOString(), '2026-10-26T19:00:00.000Z');
  assert.strictEqual(time.weekKey(time.parseKyiv('2026-09-28 00:30')), time.weekKey(time.parseKyiv('2026-10-04 23:30')), 'тиждень — з понеділка до неділі');
  assert.notStrictEqual(time.weekKey(time.parseKyiv('2026-09-27 23:30')), time.weekKey(time.parseKyiv('2026-09-28 00:30')));
});

test('банк: розіграш детермінований і перевірюваний', () => {
  const mk = () => {
    const b = core.create(Date.now() + 3600e3);
    core.addBet(b, '1', 10, 0); core.addBet(b, '2', 0, 3); core.addBet(b, '3', 25, 1);
    return b;
  };
  const a = mk(), b = { ...mk(), seed: a.seed, seedHash: a.seedHash };
  assert.strictEqual(a.pot, 10 + 15 + 30);
  const ra = core.draw(a), rb = core.draw(b);
  assert.strictEqual(ra.winner, rb.winner, 'той самий seed і ставки → той самий переможець');
  const v = core.verify(a);
  assert.ok(v.seedOk && v.hmacOk);
  assert.strictEqual(core.draw(a).ok, false, 'двічі не розігрується');
});

test('rng: перевірка збігається, розподіл рівномірний', () => {
  users.ensure({ id: 5, first_name: 'T' });
  const f = rng.view('5');
  const counts = [0, 0, 0, 0, 0, 0];
  const rolls = [];
  for (let i = 0; i < 6000; i++) { const r = rng.next('5'); rolls.push(r); counts[rng.face(r.v, 6) - 1]++; }
  for (const c of counts) assert.ok(c > 850 && c < 1150, 'кубик рівномірний: ' + counts.join(','));
  const rot = rng.rotate('5');
  assert.strictEqual(rot.revealed.hash, f.hash);
  for (const r of rolls.slice(0, 20)) assert.strictEqual(rng.verify(rot.revealed.seed, rot.revealed.client, r.nonce).v, r.v);
});

test('досвід: денна стеля й нагорода за рівень', () => {
  users.ensure({ id: 6, first_name: 'X' });
  let got = 0;
  for (let i = 0; i < 50; i++) got += progress.addXp('6', 'spin', 10);
  assert.strictEqual(got, E.XP.spin.dayCap, 'стеля XP за спіни');
  const before = users.tickets(users.get('6'));
  const i0 = progress.levelIndex(80);
  progress.addXp('6', 'admin', 1000);
  const lv = progress.view(users.get('6')).level;
  assert.strictEqual(lv.index, progress.levelIndex(1080));
  let expected = 0;
  for (let i = i0 + 1; i <= lv.index; i++) expected += E.levelReward(i).tickets;
  assert.strictEqual(users.tickets(users.get('6')) - before, expected, 'білети за кожен новий рівень');
});

test('рухи балансу: ніколи в мінус, журнал пишеться', () => {
  users.ensure({ id: 7, first_name: 'Y' });
  assert.strictEqual(users.move('7', { stars: 5 }, 'test').ok, true);
  const r = users.move('7', { stars: -6 }, 'test');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'insufficient');
  assert.strictEqual(users.stars(users.get('7')), 5);
  assert.strictEqual(users.move('7', { stars: -4.5, tickets: 0 }, 'test').stars, 0.5);
  assert.ok(users.get('7').tx.length >= 2);
});

test('вивід: комісія округлюється на користь сервісу, мінімум дотримано', () => {
  assert.deepStrictEqual(E.withdrawCost(20), { payout: 20, cost: 21, fee: 1 });
  assert.deepStrictEqual(E.withdrawCost(15), { payout: 15, cost: 16, fee: 1 });
  assert.strictEqual(E.withdrawCost(100).cost, 105);
});
