// ==========================================================================
// ВХІД В АКАУНТ ВЛАСНИКА ЗА QR-КОДОМ (для /ugift). Адмін: /tg_login → бот
// надсилає QR → скануєте телефоном (Telegram → Налаштування → Пристрої →
// «Підключити пристрій») → сесія зберігається в DATA_DIR/tg-session.txt.
// Потрібні TG_API_ID і TG_API_HASH. Пароль 2FA — окремим повідомленням
// (бот одразу його видаляє). /tg_logout — забути сесію.
// ==========================================================================
const config = require('../config');
const users = require('../core/users');
const ui = require('./ui');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');
const usergifts = require('../features/usergifts');

const LOGIN_TTL = 5 * 60000;
let active = null;   // { adminId, client, msgId, pwResolve, timer }

function stop() {
  if (!active) return;
  const a = active; active = null;
  clearTimeout(a.timer);
  if (a.pwResolve) a.pwResolve('');
  a.client.disconnect().catch(() => {});
}

function register(bot, hooks) {
  const isAdm = (ctx) => !!(ctx.from && users.isAdmin(ctx.from.id));
  const html = (t) => ({ parse_mode: 'HTML', caption: withEmoji(t) });

  bot.command('tg_login', async (ctx) => {
    if (!isAdm(ctx)) return;
    if (!config.TG_API_ID || !config.TG_API_HASH) {
      return ctx.reply(withEmoji(ui.card('warn', 'ПОТРІБНІ КЛЮЧІ', ['Додайте в Railway → Variables:', '• <code>TG_API_ID</code>', '• <code>TG_API_HASH</code>', '', 'Їх видають на my.telegram.org → API development tools.'])), { parse_mode: 'HTML' }).catch(() => {});
    }
    // Прапорець до першого await — два входи одночасно не стартують.
    if (active) return ctx.reply('⏳ Вхід уже триває. Скасувати — /tg_login_cancel').catch(() => {});
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const QR = require('qrcode');
    const client = new TelegramClient(new StringSession(''), Number(config.TG_API_ID), config.TG_API_HASH, { connectionRetries: 3 });
    client.setLogLevel('error');
    const a = active = { adminId: String(ctx.from.id), client, msgId: null, pwResolve: null };
    a.timer = setTimeout(() => { if (active === a) { stop(); ctx.reply('⌛ QR прострочено. Спробуйте ще раз: /tg_login').catch(() => {}); } }, LOGIN_TTL);
    const caption = '{:lightning} <b>ВХІД В АКАУНТ ДЛЯ /ugift</b>\n━━━━━━━━━━━━━━\nНа телефоні: Telegram → <b>Налаштування → Пристрої → Підключити пристрій</b> і наведіть камеру на цей QR.\n\n<i>QR оновлюється сам · діє 5 хв · скасувати — /tg_login_cancel</i>';
    try {
      await client.connect();
      const me = await client.signInUserWithQrCode({ apiId: Number(config.TG_API_ID), apiHash: config.TG_API_HASH }, {
        qrCode: async ({ token }) => {
          if (active !== a) return;
          const png = await QR.toBuffer('tg://login?token=' + Buffer.from(token).toString('base64url'), { width: 512, margin: 2 });
          if (a.msgId) {
            await ctx.telegram.editMessageMedia(ctx.chat.id, a.msgId, undefined, { type: 'photo', media: { source: png }, ...html(caption) }).catch(() => {});
          } else {
            const m = await ctx.replyWithPhoto({ source: png }, html(caption)).catch(() => null);
            a.msgId = m && m.message_id;
          }
        },
        password: async (hint) => {
          if (active !== a) return '';
          await ctx.reply(withEmoji('🔐 Увімкнено хмарний пароль (2FA)' + (hint ? ' · підказка: <i>' + esc(hint) + '</i>' : '') + '.\nНадішліть пароль одним повідомленням — я одразу його видалю з чату.'), { parse_mode: 'HTML' }).catch(() => {});
          return new Promise((res) => { a.pwResolve = res; });
        },
        onError: async (e) => { await ctx.reply('❌ ' + (e.errorMessage || e.message)).catch(() => {}); return true; },
      });
      if (active !== a) return;
      usergifts.saveSession(client.session.save());
      const who = (me && (me.username ? '@' + me.username : me.firstName)) || 'акаунт';
      if (a.msgId) ctx.telegram.deleteMessage(ctx.chat.id, a.msgId).catch(() => {});
      await ctx.reply(withEmoji(ui.card('check', 'АКАУНТ ПІДКЛЮЧЕНО', [
        '{:crown} Увійшли як <b>' + esc(who) + '</b>',
        '{:giftBox} Тепер працює <code>/ugift @нік</code> — подарунки від цього акаунта',
      ], 'Сесія збережена на сервері · відключити — /tg_logout')), { parse_mode: 'HTML' }).catch(() => {});
    } catch (e) {
      if (active === a) await ctx.reply('❌ Вхід не вдався: ' + esc(String(e.errorMessage || e.message || e)).slice(0, 300) + '\nСпробуйте ще раз: /tg_login').catch(() => {});
    } finally {
      if (active === a) stop();
    }
  });

  bot.command('tg_login_cancel', async (ctx) => {
    if (!isAdm(ctx)) return;
    if (!active) return ctx.reply('Входу зараз немає.').catch(() => {});
    stop();
    await ctx.reply('🚫 Вхід скасовано.').catch(() => {});
  });

  bot.command('tg_logout', async (ctx) => {
    if (!isAdm(ctx)) return;
    const had = usergifts.saveSession('');
    await ctx.reply(had ? '🔌 Збережену сесію видалено. Також закрийте її на телефоні: Налаштування → Пристрої.' + (config.TG_SESSION ? '\n⚠️ Ще задано TG_SESSION у Railway — приберіть змінну.' : '') : 'Збереженої сесії немає.').catch(() => {});
  });

  // Пароль 2FA — забираємо з чату одразу.
  hooks.onAdminText.push(async (ctx, text) => {
    if (!active || !active.pwResolve || active.adminId !== String(ctx.from.id)) return false;
    const r = active.pwResolve; active.pwResolve = null;
    ctx.deleteMessage().catch(() => {});
    await ctx.reply('🔐 Пароль прийнято, перевіряю…').catch(() => {});
    r(text);
    return true;
  });
}

module.exports = { register };
