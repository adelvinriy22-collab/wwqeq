// ==========================================================================
// StarForge v3 — точка входу.
//   1. міграція бази (з резервною копією);
//   2. HTTP: застосунок + API (працює навіть без Telegram);
//   3. бот (long polling з повторами);
//   4. планувальники: банк, ліга, чат, нагадування.
// ==========================================================================
require('dotenv').config();
const config = require('./config');
const store = require('./store');
const progress = require('./core/progress');
const notify = require('./core/notify');
const users = require('./core/users');
const i18n = require('./i18n');
const time = require('./lib/time');
const E = require('./economy');
const bank = require('./features/bank');
const league = require('./features/league');
const promo = require('./features/promo');
const reminders = require('./features/reminders');
const { createApp } = require('./http/server');

// Дрібна помилка не повинна вбивати весь процес (і застосунок разом з ним).
const FATAL = ['EADDRINUSE', 'ERR_MODULE_NOT_FOUND', 'Cannot find module'];
const isFatal = (e) => FATAL.some(p => String((e && (e.message || e.code)) || e || '').includes(p));
process.on('unhandledRejection', (e) => { console.error('⚠️ unhandledRejection:', e && e.message ? e.message : e); if (isFatal(e)) process.exit(1); });
process.on('uncaughtException', (e) => { console.error('⚠️ uncaughtException:', e && e.message ? e.message : e); if (isFatal(e)) process.exit(1); });

store.migrate({ pass: E.PASS, seasonId: progress.seasonId, weekKey: time.weekKey });
// Банк, який попередня версія встигла скасувати, повертається з тими самими ставками.
try { bank.restoreRemoved(); } catch (e) { console.error('bank.restoreRemoved:', e.message); }
try { bank.ensureInitial(); } catch (e) { console.error('bank.ensureInitial:', e.message); }
try { promo.ensureDefaults(); } catch (e) { console.error('promo.ensureDefaults:', e.message); }

// Новий рівень — особисте повідомлення: нагорода, що відкрилось, що далі.
// Надсилаємо й тоді, коли рівень набрано в чаті: там лише коротке оголошення.
progress.hooks.onLevelUp.push((uid, info, rw, opts) => {
  if (opts.silent) return;
  const u = users.get(uid);
  if (!u || !u.lang) return;
  notify.dm(uid, require('./bot/levels').levelUpText(u.lang, info, rw),
    notify.appKeyboard(i18n.t(u.lang, 'btn.open'), 'progress', [[{ text: i18n.t(u.lang, 'btn.levels'), callback_data: 'my_level' }]]));
});

const app = createApp();
notify.tg.build = app.locals.build;
const server = app.listen(config.PORT, () => console.log('🌐 HTTP на порту ' + config.PORT));

let bot = null, chat = null;
if (!config.BOT_TOKEN) {
  console.warn('⚠️ BOT_TOKEN не задано — працює лише HTTP (застосунок без бота).');
} else {
  const built = require('./bot').createBot(config.BOT_TOKEN);
  bot = built.bot; chat = built.chat;
  require('./bot').launch(bot, chat, () => bank.deliverRestoreNotices().catch(e => console.error('bank notices:', e.message)));
}
if (!config.WEBAPP_URL) console.warn('ℹ️ WEBAPP_URL не задано — у боті не буде кнопок відкриття застосунку.');
if (config.ADVANCED_UNLOCK_PASSWORD_IS_DEFAULT) console.warn('⚠️ ADVANCED_UNLOCK_PASSWORD не задано — використовується стандартний пароль.');

// ─── Планувальники ──────────────────────────────────────────────────────
const timers = [];
function every(ms, name, fn) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(name + ':', e && e.message); } finally { busy = false; }
  }, ms);
  t.unref();
  timers.push(t);
}
if (!config.NO_SCHEDULERS) {
  every(60 * 1000, 'bank.tick', () => bank.tick());
  every(60 * 1000, 'league.tick', () => league.tick());
  every(60 * 1000, 'chat.tick', () => chat && notify.tg.telegram ? chat.tick() : null);
  every(30 * 60 * 1000, 'reminders', () => reminders.run());
}

function shutdown(sig) {
  console.log(`Отримано ${sig} — зупиняюсь.`);
  timers.forEach(clearInterval);
  try { if (bot) bot.stop(sig); } catch (e) {}
  try { server.close(); } catch (e) {}
  try { store.flush(); } catch (e) { console.error('flush:', e.message); }
  try { store.flushLedger(); } catch (e) {}
  setTimeout(() => process.exit(0), 300).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
