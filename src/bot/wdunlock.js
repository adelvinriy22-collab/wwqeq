// ==========================================================================
// РОЗБЛОКУВАННЯ ВИВОДУ. Адмін: /wd_unlock так — розсилка «велике оновлення»
// всім гравцям із кнопкою «Розблокувати вивід», яка діє E.WITHDRAW.unlockWindowMs.
// Натиснути зможе лише той, хто за останні unlockLookbackDays днів був у боті
// щонайменше unlockNeedDays різних днів (features/withdrawgate.js).
// Також: /wd_unlock @нік — відкрити вивід вручну; /wd_ban @нік причина, /wd_unban @нік.
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const notify = require('../core/notify');
const E = require('../economy');
const gate = require('../features/withdrawgate');
const ui = require('./ui');
const time = require('../lib/time');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');
const { isAdminCtx, broadcast, audience, argsOf, yes } = require('./admin/shared');

const W = () => E.WITHDRAW;
const giftsLine = () => W().gifts.map(id => { const t = E.getTier(id); return t.emoji + ' ' + t.name.uk; }).join(' · ');

const T = {
  uk: {
    post: () => '{:rocket} <b>STARFORGE — ВЕЛИКЕ ОНОВЛЕННЯ</b>\n━━━━━━━━━━━━━━\n' +
      '{:giftBox} <b>Вивід — тепер подарунками:</b> ' + giftsLine() + (W().dayCap ? ' (до ' + W().dayCap + '⭐ на день)' : '') + '\n' +
      '{:lockIcon} <b>Захист від абузу</b> — виплати лише справжнім гравцям\n' +
      '{:lightning} <b>Білети прибрано</b> — усі нагороди тепер у XP\n' +
      '{:starIcon} <b>Зірки стали ціннішими</b> — заробити їх тепер складніше\n\n' +
      '{:crown} <b>Натисни кнопку протягом 24 год</b>, щоб розблокувати вивід своїх подарунків.\n\n' +
      '{:warn} <i>Кнопка спрацює, лише якщо за останні ' + W().unlockLookbackDays + ' днів ти заходив у бота хоча б ' + W().unlockNeedDays + ' дні.</i>',
    btn: 'РОЗБЛОКУВАТИ ВИВІД',
    ok: '{:check} <b>ВИВІД РОЗБЛОКОВАНО!</b>\n━━━━━━━━━━━━━━\nТепер ти можеш виводити подарунки: ' + '{gifts}' + '.\n\n<i>Умови виводу — у застосунку: Гаманець → Вивести.</i>',
    notActive: '{:warn} <b>Не вийшло розблокувати.</b>\nЗа останні {days} днів ти був у боті <b>{have}</b> з <b>{need}</b> потрібних днів.\n\n<i>Заходь у бота щодня — і чекай наступної нагоди.</i>',
    closed: '⌛ Час на розблокування минув — кнопка діяла 24 години.',
    already: '{:check} Вивід уже розблоковано.',
    open: 'ВІДКРИТИ ГАМАНЕЦЬ',
  },
  en: {
    post: () => '{:rocket} <b>STARFORGE — BIG UPDATE</b>\n━━━━━━━━━━━━━━\n' +
      '{:giftBox} <b>Withdrawals are now gifts:</b> 🧸 · 🎁 · 🚀' + (W().dayCap ? ' (up to ' + W().dayCap + '⭐ a day)' : '') + '\n' +
      '{:lockIcon} <b>Anti-abuse protection</b> — payouts only for real players\n' +
      '{:lightning} <b>Tickets are gone</b> — all rewards are now XP\n' +
      '{:starIcon} <b>Stars are worth more</b> — they are harder to earn now\n\n' +
      '{:crown} <b>Tap the button within 24 hours</b> to unlock withdrawals of your gifts.\n\n' +
      '{:warn} <i>The button works only if you opened the bot on at least ' + W().unlockNeedDays + ' days in the last ' + W().unlockLookbackDays + '.</i>',
    btn: 'UNLOCK WITHDRAWALS',
    ok: '{:check} <b>WITHDRAWALS UNLOCKED!</b>\n━━━━━━━━━━━━━━\nYou can now withdraw gifts: {gifts}.\n\n<i>Rules are in the app: Wallet → Withdraw.</i>',
    notActive: '{:warn} <b>Could not unlock.</b>\nIn the last {days} days you were in the bot on <b>{have}</b> of the <b>{need}</b> required days.\n\n<i>Open the bot daily and wait for the next chance.</i>',
    closed: '⌛ The unlock window is over — the button worked for 24 hours.',
    already: '{:check} Withdrawals are already unlocked.',
    open: 'OPEN WALLET',
  },
  ru: {
    post: () => '{:rocket} <b>STARFORGE — БОЛЬШОЕ ОБНОВЛЕНИЕ</b>\n━━━━━━━━━━━━━━\n' +
      '{:giftBox} <b>Вывод — теперь подарками:</b> 🧸 · 🎁 · 🚀' + (W().dayCap ? ' (до ' + W().dayCap + '⭐ в день)' : '') + '\n' +
      '{:lockIcon} <b>Защита от абуза</b> — выплаты только настоящим игрокам\n' +
      '{:lightning} <b>Билеты убраны</b> — все награды теперь в XP\n' +
      '{:starIcon} <b>Звёзды стали ценнее</b> — заработать их теперь сложнее\n\n' +
      '{:crown} <b>Нажми кнопку в течение 24 часов</b>, чтобы разблокировать вывод своих подарков.\n\n' +
      '{:warn} <i>Кнопка сработает, только если за последние ' + W().unlockLookbackDays + ' дней ты заходил в бота хотя бы ' + W().unlockNeedDays + ' дня.</i>',
    btn: 'РАЗБЛОКИРОВАТЬ ВЫВОД',
    ok: '{:check} <b>ВЫВОД РАЗБЛОКИРОВАН!</b>\n━━━━━━━━━━━━━━\nТеперь ты можешь выводить подарки: {gifts}.\n\n<i>Условия вывода — в приложении: Кошелёк → Вывести.</i>',
    notActive: '{:warn} <b>Не получилось разблокировать.</b>\nЗа последние {days} дней ты был в боте <b>{have}</b> из <b>{need}</b> нужных дней.\n\n<i>Заходи в бота каждый день — и жди следующей возможности.</i>',
    closed: '⌛ Время на разблокировку вышло — кнопка действовала 24 часа.',
    already: '{:check} Вывод уже разблокирован.',
    open: 'ОТКРЫТЬ КОШЕЛЁК',
  },
};
const L = (u) => (T[(u || {}).lang] ? u.lang : 'uk');
const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] !== undefined ? p[k] : m));
const tx = (lang, k, p) => withEmoji(fill(typeof T[lang][k] === 'function' ? T[lang][k]() : T[lang][k], p));
const kbFor = (lang) => ({ parse_mode: 'HTML', ...ui.kb([[ui.cb(T[lang].btn, 'wdu:go', 'success', 'lockIcon')]]) });

function register(bot) {
  bot.action('wdu:go', async (ctx) => {
    const uid = String(ctx.from.id);
    const u = users.get(uid);
    const lang = L(u);
    const r = gate.tryUnlock(uid);
    if (r.ok) {
      await ctx.answerCbQuery('✅').catch(() => {});
      await ctx.reply(tx(lang, 'ok', { gifts: giftsLine() }), { parse_mode: 'HTML', ...ui.kb([[ui.app(T[lang].open, 'wallet', 'success', 'withdrawBox')]]) }).catch(() => {});
      return;
    }
    const k = r.error === 'not_active' ? 'notActive' : r.error === 'already' ? 'already' : 'closed';
    await ctx.answerCbQuery(k === 'closed' ? '⌛' : k === 'already' ? '✅' : '❌').catch(() => {});
    await ctx.reply(tx(lang, k, { days: W().unlockLookbackDays, have: r.days || 0, need: W().unlockNeedDays }), { parse_mode: 'HTML' }).catch(() => {});
  });

  bot.command('wd_unlock', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx);
    if (a[0] && /^@?\w{3,}$/.test(a[0]) && !/^так$/i.test(a[0])) {
      const u = users.findByUsernameOrId(a[0]);
      if (!u) return ctx.reply('Не знайшов ' + a[0]).catch(() => {});
      users.patch(u.id, { wdUnlockGranted: Date.now() });
      return ctx.reply('🔓 Вивід відкрито вручну для ' + (u.username ? '@' + u.username : u.id) + '.').catch(() => {});
    }
    const s = gate.unlockState();
    const unlocked = Object.values(users.all()).filter(u => u && (u.wdUnlockedAt || u.wdUnlockGranted)).length;
    if (!yes(ctx)) {
      return ctx.reply('🔓 <b>Розблокування виводу</b>\n' +
        (s ? (gate.windowOpen(s) ? '🟢 Кнопка діє до ' + time.fmtKyiv(s.until, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' }) : '⚪ Вікно закрите (було ' + time.fmtKyiv(s.startedAt, { day: 'numeric', month: 'long' }) + ')') : 'Ще не запускалось.') +
        `\nРозблоковано: <b>${unlocked}</b> гравців\n\n` +
        '<code>/wd_unlock так</code> — розсилка «велике оновлення» всім, кнопка діє 24 год\n' +
        '<code>/wd_unlock @нік</code> — відкрити вивід одній людині\n<code>/wd_ban @нік причина</code> · <code>/wd_unban @нік</code>', { parse_mode: 'HTML' }).catch(() => {});
    }
    // Вікно — до першого await, щоб кнопка працювала вже під час розсилки.
    store.setFeatureFlags({ wdUnlock: { startedAt: Date.now(), until: Date.now() + W().unlockWindowMs, by: String(ctx.from.id) } });
    const targets = Object.entries(users.all()).filter(([id, u]) => u && u.lang && !u.remindersOff && !users.isAdmin(id));
    await broadcast(ctx, targets, async (uid, u) => {
      const lang = L(u);
      await notify.tg.telegram.sendMessage(uid, tx(lang, 'post'), kbFor(lang));
    }, 'Розсилка «оновлення + розблокування виводу»');
  });

  bot.command('wd_ban', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [q, ...rest] = argsOf(ctx);
    const u = q ? users.findByUsernameOrId(q) : null;
    if (!u) return ctx.reply('Формат: /wd_ban @нік причина').catch(() => {});
    users.patch(u.id, { wdBan: { at: Date.now(), reason: rest.join(' ') || null } });
    await ctx.reply('🚫 Вивід заблоковано для ' + (u.username ? '@' + u.username : u.id) + '.').catch(() => {});
  });
  bot.command('wd_unban', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const u = users.findByUsernameOrId(argsOf(ctx)[0] || '');
    if (!u) return ctx.reply('Формат: /wd_unban @нік').catch(() => {});
    users.patch(u.id, { wdBan: null });
    await ctx.reply('✅ Вивід знову доступний для ' + (u.username ? '@' + u.username : u.id) + '.').catch(() => {});
  });
}

module.exports = { register, T };
