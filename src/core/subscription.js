// Перевірка підписки на канал із кешем. Позитивний результат тримаємо 10 хв,
// негативний — 20 с (людина може підписатись будь-якої миті). Якщо Telegram
// тимчасово не відповідає — довіряємо останньому відомому стану.
const config = require('../config');
const users = require('./users');
const notify = require('./notify');

const cache = new Map();   // channel:uid -> { ok, at }
const OK_MS = 10 * 60000, NO_MS = 20000;

async function check(uid, channel) {
  const ch = channel || config.CHANNEL_USERNAME;
  const key = ch + ':' + uid;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? OK_MS : NO_MS)) return hit.ok;
  if (!notify.tg.telegram) return hit ? hit.ok : null;
  try {
    const m = await notify.tg.telegram.getChatMember(ch, Number(uid));
    const ok = ['creator', 'administrator', 'member', 'restricted'].includes(m.status) && m.status !== 'left' && m.status !== 'kicked'
      && !(m.status === 'restricted' && m.is_member === false);
    cache.set(key, { ok, at: Date.now() });
    return ok;
  } catch (e) {
    if (hit) return hit.ok;
    return null;
  }
}
function forget(uid) { for (const k of cache.keys()) if (k.endsWith(':' + uid)) cache.delete(k); }

// Для застосунку й бота: true — можна грати. Адмінів не перевіряємо.
async function isSubscribed(uid) {
  if (users.isAdmin(uid)) return true;
  const live = await check(uid);
  const u = users.get(uid);
  if (live === true) { if (u && !u.subscribed) users.patch(uid, { subscribed: true, subCheckedAt: Date.now() }); return true; }
  if (live === false) { if (u && u.subscribed) users.patch(uid, { subscribed: false, subCheckedAt: Date.now() }); return false; }
  return !!(u && u.subscribed);   // API не відповів — не викидаємо людину через збій
}

module.exports = { check, forget, isSubscribed };
