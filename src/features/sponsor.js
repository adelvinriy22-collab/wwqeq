// Місія «Підпишись на канал-спонсора» (config.SPONSOR_CHANNEL) і умова для виводу.
// Підписку перевіряє бот (getChatMember) — він має бути адміном каналу.
const config = require('../config');
const users = require('../core/users');
const progress = require('../core/progress');
const subscription = require('../core/subscription');
const E = require('../economy');

const channel = () => config.SPONSOR_CHANNEL || null;
const link = () => channel() ? 'https://t.me/' + channel().replace(/^@/, '') : null;
const done = (u) => !!((u && u.taskDone) || {}).sponsor;

function view(u) {
  if (!channel()) return null;
  return { channel: channel(), link: link(), done: done(u), reward: { tickets: E.SPONSOR.tickets, xp: E.SPONSOR.xp } };
}

// Перевірити підписку й видати нагороду (один раз).
async function claim(uid) {
  if (!channel()) return { ok: false, status: 400, error: 'no_task' };
  const u = users.get(uid);
  if (!u) return { ok: false, status: 400, error: 'no_user' };
  if (done(u)) return { ok: false, status: 429, error: 'already_done' };
  subscription.forget(uid);
  const ok = await subscription.check(uid, channel());
  if (ok !== true) return { ok: false, status: 400, error: 'need_sub', channel: channel() };
  return users.withLock(uid, () => {
    const cur = users.get(uid);
    if (done(cur)) return { ok: false, status: 429, error: 'already_done' };
    users.patch(uid, { taskDone: { ...(cur.taskDone || {}), sponsor: Date.now() } });
    const r = users.move(uid, { tickets: E.SPONSOR.tickets }, 'task', { task: 'sponsor' });
    progress.addXp(uid, 'quest', E.SPONSOR.xp, { why: 'sponsor' });
    return { ok: true, tickets: E.SPONSOR.tickets, xp: E.SPONSOR.xp, ticketsLeft: r.tickets };
  });
}

// Для виводу: true — можна. Якщо Telegram не відповів (null) — не блокуємо.
async function okForWithdraw(uid) {
  if (!channel() || users.isAdmin(uid)) return true;
  return (await subscription.check(uid, channel())) !== false;
}

module.exports = { channel, link, view, claim, okForWithdraw };
