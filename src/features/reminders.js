// «Безкоштовний спін готовий» — головний механізм утримання. Не частіше
// одного разу на добу й лише тим, хто заходив за останні 14 днів.
const users = require('../core/users');
const notify = require('../core/notify');
const i18n = require('../i18n');
const time = require('../lib/time');

const ACTIVE_WINDOW = 14 * time.DAY_MS;
let running = false;

async function run() {
  if (running || !notify.tg.telegram) return 0;
  running = true;
  let sent = 0;
  try {
    const now = Date.now();
    const today = time.dayKey(now);
    for (const [uid, u] of Object.entries(users.all())) {
      if (!u || !u.lang || u.remindersOff) continue;
      if (u.reminderDay === today) continue;
      if (!u.lastActiveAt || now - u.lastActiveAt > ACTIVE_WINDOW) continue;
      if (!u.lastDailySpinAt || now - u.lastDailySpinAt < time.DAY_MS) continue;
      // Не будимо вночі (за Києвом).
      const h = time.kyivHour(now);
      if (h < 9 || h >= 22) break;
      users.patch(uid, { reminderDay: today });
      const streak = u.dailyStreak || 0;
      const text = streak > 1 ? i18n.t(u.lang, 'spin.readyStreak', { streak }) : i18n.t(u.lang, 'spin.ready');
      const r = await notify.dm(uid, text, notify.appKeyboard(i18n.t(u.lang, 'btn.open'), 'wheel'));
      if (r) sent++;
      await new Promise(x => setTimeout(x, 80));
    }
  } finally { running = false; }
  if (sent) console.log('🔔 Нагадувань надіслано:', sent);
  return sent;
}

module.exports = { run };
