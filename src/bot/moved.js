// ==========================================================================
// ПЕРЕЇЗД НА НОВИЙ БОТ. Адмін: /moved @бот — увімкнути, /moved off — вимкнути,
// /moved — стан і як виглядає відповідь (features/moved.js).
// Поки увімкнено, для всіх, крім адмінів:
//   • будь-яке повідомлення чи команда в приваті → «ми переїхали» з кнопкою;
//   • старі кнопки → те саме (у групі — спливаюче вікно);
//   • команди в групі → відповідь (не частіше разу на 30 с на чат), решта — тиша;
//   • нові оплати не приймаються (уже сплачені зараховуються).
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const moved = require('../features/moved');
const ui = require('./ui');
const { isAdminCtx, argsOf } = require('./admin/shared');

const text = (to) => 'ми переїхали 🛩\nновий бот: @' + to + '\nзаходь, підписуйся на канал і грай';
const extra = (to) => ui.kb([[ui.url('ПЕРЕЙТИ В @' + to, 'https://t.me/' + to, 'success')]]);

// Команда цьому боту: «/щось» або «/щось@цей_бот» (команди іншим ботам у групі — не наші).
function isOurCommand(ctx) {
  const m = String((ctx.message && ctx.message.text) || '').match(/^\/\w+(?:@(\w+))?/);
  if (!m) return false;
  return !m[1] || !ctx.botInfo || m[1].toLowerCase() === String(ctx.botInfo.username).toLowerCase();
}

function middleware() {
  const lastAt = new Map();   // антиспам: гравець/чат → час останньої відповіді
  const quiet = (key, ms) => {
    if (Date.now() - (lastAt.get(key) || 0) < ms) return true;
    if (lastAt.size > 5000) lastAt.clear();
    lastAt.set(key, Date.now());
    return false;
  };
  return async (ctx, next) => {
    const to = moved.to();
    if (!to || !ctx.from || users.isAdmin(ctx.from.id)) return next();
    // Уже сплачене зараховуємо; нових оплат не приймаємо.
    if (ctx.message && ctx.message.successful_payment) return next();
    if (ctx.updateType === 'pre_checkout_query') return ctx.answerPreCheckoutQuery(false, 'Бот переїхав — новий бот: @' + to).catch(() => {});
    const chat = ctx.chat || (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.chat);
    const priv = !!chat && chat.type === 'private';
    if (ctx.updateType === 'callback_query') {
      if (!priv) return ctx.answerCbQuery('ми переїхали 🛩 новий бот: @' + to, { show_alert: true }).catch(() => {});
      await ctx.answerCbQuery().catch(() => {});
      if (quiet('u' + ctx.from.id, 3000)) return;
      return ctx.reply(text(to), extra(to)).catch(() => {});
    }
    if (!ctx.message) return;   // реакції, учасники тощо — мовчки
    if (priv) return ctx.reply(text(to), extra(to)).catch(() => {});
    if (isOurCommand(ctx) && !quiet('c' + ctx.chat.id, 30000)) {
      return ctx.reply(text(to), { ...extra(to), reply_to_message_id: ctx.message.message_id }).catch(() => {});
    }
  };
}

function register(bot) {
  bot.command('moved', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx)[0] || '';
    if (/^(off|вимк\S*|стоп)$/i.test(a)) {
      store.setFeatureFlags({ moved: null });
      return ctx.reply('✅ Переїзд вимкнено — бот і застосунок знову звичайні.').catch(() => {});
    }
    const to = a.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').split(/[/?]/)[0];
    if (to) {
      if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(to)) return ctx.reply('Формат: /moved @новий_бот').catch(() => {});
      store.setFeatureFlags({ moved: { to, at: Date.now(), by: String(ctx.from.id) } });
      await ctx.reply('🛩 Переїзд увімкнено. Гравці (адміни — ні) на кожну команду, повідомлення й кнопку отримують це, ' +
        'а застосунок показує сторінку переїзду з кнопкою. Нові оплати не приймаються. /moved off — вимкнути.').catch(() => {});
      return ctx.reply(text(to), extra(to)).catch(() => {});
    }
    const to0 = moved.to();
    if (!to0) return ctx.reply('Переїзд вимкнено.\n/moved @новий_бот — увімкнути: увесь бот і застосунок для гравців показуватимуть «ми переїхали» з кнопкою на новий бот.').catch(() => {});
    await ctx.reply('🛩 Переїзд увімкнено → @' + to0 + '. Так гравці бачать кожну команду (адміни — звичайний бот):\n/moved off — вимкнути').catch(() => {});
    await ctx.reply(text(to0), extra(to0)).catch(() => {});
  });
}

module.exports = { middleware, register };
