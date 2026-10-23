// ==========================================================================
// ПЕРЕЇЗД НА НОВИЙ БОТ. Адмін: /moved @бот — увімкнути, /moved off — вимкнути,
// /moved — стан і як виглядає відповідь. Поки увімкнено, /start у приваті
// (з будь-яким payload) у відповідь показує «ми переїхали» з кнопкою на новий
// бот. Адміни бачать звичайний /start, решта бота працює як раніше.
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const ui = require('./ui');
const { isAdminCtx, argsOf } = require('./admin/shared');

const state = () => (store.getFeatureFlags() || {}).moved || null;
const text = (to) => 'ми переїхали 🛩\nновий бот: @' + to + '\nзаходь, підписуйся на канал і грай';
const extra = (to) => ui.kb([[ui.url('ПЕРЕЙТИ В @' + to, 'https://t.me/' + to, 'success')]]);
const isStart = (ctx) => !!(ctx.message && typeof ctx.message.text === 'string' && /^\/start(@\w+)?(\s|$)/.test(ctx.message.text));

function middleware() {
  return async (ctx, next) => {
    const m = state();
    if (!m || !m.to || !isStart(ctx) || !ctx.chat || ctx.chat.type !== 'private' || users.isAdmin(ctx.from.id)) return next();
    await ctx.reply(text(m.to), extra(m.to)).catch(() => {});
  };
}

function register(bot) {
  bot.command('moved', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx)[0] || '';
    if (/^(off|вимк\S*|стоп)$/i.test(a)) {
      store.setFeatureFlags({ moved: null });
      return ctx.reply('✅ Переїзд вимкнено — /start знову звичайний.').catch(() => {});
    }
    const to = a.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').split(/[/?]/)[0];
    if (to) {
      if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(to)) return ctx.reply('Формат: /moved @новий_бот').catch(() => {});
      store.setFeatureFlags({ moved: { to, at: Date.now(), by: String(ctx.from.id) } });
      await ctx.reply('🛩 Переїзд увімкнено: кожен /start (крім адмінів) тепер отримує:').catch(() => {});
      return ctx.reply(text(to), extra(to)).catch(() => {});
    }
    const m = state();
    if (!m) return ctx.reply('Переїзд вимкнено.\n/moved @новий_бот — увімкнути: /start відповідатиме «ми переїхали» з кнопкою на новий бот.').catch(() => {});
    await ctx.reply('🛩 Переїзд увімкнено → @' + m.to + '. Так бачать /start гравці (адміни — звичайний):\n/moved off — вимкнути').catch(() => {});
    await ctx.reply(text(m.to), extra(m.to)).catch(() => {});
  });
}

module.exports = { middleware, register };
