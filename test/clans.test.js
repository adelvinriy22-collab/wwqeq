// Клани без Telegram: ліміт XP у клані, очки понад ліміт, запрошення в клан.
// Запуск: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-clans-'));
const users = require('../src/core/users');
const progress = require('../src/core/progress');
const notify = require('../src/core/notify');
const clans = require('../src/features/clans');
const E = require('../src/economy');

const said = [];
notify.tg.chat = { say: async (t) => { said.push(t); } };
progress.hooks.onXp.push((uid, src, gain, raw) => clans.onXp(uid, src, gain, raw));
progress.hooks.capMult.push((uid, src) => clans.capMult(uid, src));
for (const id of ['1', '2', '3']) { users.ensure({ id: Number(id), first_name: 'U' + id, username: 'u' + id }); users.patch(id, { lang: 'uk', tickets: 10 }); }
clans.startEvent(clans.data(), 3);
const c = clans.create('1', '🐺 Вовки').clan;
clans.join('2', c.id);

test('у клані під час війни денний ліміт XP ×2, без клану — звичайний', () => {
  assert.strictEqual(progress.dayCapOf('2', 'chat'), E.XP.chat.dayCap * 2);
  assert.strictEqual(progress.dayCapOf('3', 'chat'), E.XP.chat.dayCap);
  assert.strictEqual(progress.dayCapOf('2', 'friend'), E.XP.friend.dayCap, 'XP за друзів — без множника');
});

test('понад ліміт XP активність однаково йде в очки клану — до запобіжної стелі', () => {
  const cap = progress.dayCapOf('2', 'chat');
  assert.strictEqual(progress.addXp('2', 'chat', cap + 50), cap, 'XP — лише до ліміту');
  assert.strictEqual(clans.data().list[c.id].ev.contrib['2'], cap + 50, 'а в клан пішло все');
  assert.strictEqual(progress.addXp('2', 'chat', 1000), 0, 'ліміт XP вичерпано');
  const s = clans.data().list[c.id].ev;
  assert.strictEqual(s.contrib['2'], cap + E.CLANS.overflowDayCap, 'понад ліміт — не більше ' + E.CLANS.overflowDayCap + ' на день');
  progress.addXp('2', 'chat', 100);
  assert.strictEqual(clans.data().list[c.id].ev.contrib['2'], cap + E.CLANS.overflowDayCap, 'запобіжник тримає');
});

test('активного в чаті без клану бот кличе в клан один раз', () => {
  const replies = [];
  const ctx = { from: { id: 3, username: 'u3' }, message: { message_id: 7 }, reply: async (t, o) => { replies.push({ t, o }); } };
  for (let i = 0; i < E.CLANS.nudgeAfter * 3; i++) clans.onChatMessage(ctx);
  assert.strictEqual(replies.length, 1, 'одне запрошення');
  assert.match(replies[0].t, /ти сьогодні активний у чаті/);
  assert.match(JSON.stringify(replies[0].o.reply_markup), /cl:q/, 'кнопка вступу в 1 клік');
  const inClan = [];
  const ctx2 = { from: { id: 2, username: 'u2' }, message: { message_id: 8 }, reply: async (t) => { inClan.push(t); } };
  for (let i = 0; i < E.CLANS.nudgeAfter * 2; i++) clans.onChatMessage(ctx2);
  assert.strictEqual(inClan.length, 0, 'учасника клану не кличемо');
});
