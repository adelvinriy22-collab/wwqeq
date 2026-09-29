// ==========================================================================
// Бот для гравця — мінімальний: вхід, мова, підписка, запрошення друзів,
// оплата й промокоди. Уся гра — у застосунку.
// ==========================================================================
const config = require('../config');
const users = require('../core/users');
const progress = require('../core/progress');
const subscription = require('../core/subscription');
const notify = require('../core/notify');
const i18n = require('../i18n');
const referrals = require('../features/referrals');
const promo = require('../features/promo');
const wallet = require('../features/wallet');
const maintenance = require('../features/maintenance');
const ui = require('./ui');
const { esc, fmtStars } = require('../lib/util');
const time = require('../lib/time');

const awaitingPromo = new Set();

function langFromTg(from) {
  const c = String((from && from.language_code) || '').slice(0, 2);
  return c === 'ru' ? 'ru' : c === 'en' ? 'en' : 'uk';
}

function shareUrl(uid, lang) {
  const link = referrals.link(uid);
  if (!link) return null;
  const txt = { uk: 'Заходь у StarForge — колеса удачі, банк і справжні Telegram-подарунки 🎁', en: 'Join StarForge — wheels of luck, a shared bank and real Telegram gifts 🎁', ru: 'Заходи в StarForge — колёса удачи, банк и настоящие Telegram-подарки 🎁' }[lang] || '';
  return 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(txt);
}

async function sendWelcome(ctx, uid) {
  const u = users.get(uid);
  const lang = u.lang || 'uk';
  const lv = progress.view(u, lang).level;
  const text = i18n.t(lang, 'start.welcome', {
    name: esc(u.name || u.username || ''), stars: fmtStars(users.stars(u)), tickets: users.tickets(u),
    level: lv.e + ' ' + esc(lv.t) + ' · ' + (lang === 'en' ? 'level' : 'рівень') + ' ' + lv.n,
  }) + (config.WEBAPP_URL ? '' : i18n.t(lang, 'start.noApp'));
  const share = shareUrl(uid, lang);
  await ctx.reply(text, { parse_mode: 'HTML', ...ui.kb([
    [ui.app(i18n.t(lang, 'btn.open'), null, 'success')],
    [share ? ui.url(i18n.t(lang, 'btn.invite'), share, 'primary') : null],
    [ui.cb(i18n.t(lang, 'btn.lang'), 'lang_menu')],
  ]) }).catch(() => {});
}

async function sendSubscribe(ctx, uid) {
  const lang = (users.get(uid) || {}).lang || 'uk';
  await ctx.reply(i18n.t(lang, 'start.subscribe', { channel: esc(config.CHANNEL_USERNAME) }), {
    parse_mode: 'HTML',
    ...ui.kb([[ui.url(i18n.t(lang, 'btn.subscribe'), config.CHANNEL_URL, 'primary')], [ui.cb(i18n.t(lang, 'btn.checkSub'), 'check_sub', 'success')]]),
  }).catch(() => {});
}

// Спільна перевірка: підписаний → зараховуємо реферала й пускаємо далі.
async function gate(ctx, uid) {
  const ok = await subscription.isSubscribed(uid);
  if (ok) { referrals.attributeIfPending(uid); return true; }
  await sendSubscribe(ctx, uid);
  return false;
}

function register(bot, hooks) {
  bot.start(async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const uid = String(ctx.from.id);
    const existed = !!users.get(uid);
    users.ensure(ctx.from);
    const u = users.get(uid);
    const payload = ctx.startPayload || '';
    if (payload.startsWith('ref_')) referrals.setPending(uid, payload.slice(4));
    if (!u.lang) users.patch(uid, { lang: langFromTg(ctx.from), chatGuest: false, onboardedAt: Date.now() });
    if (!existed) users.patch(uid, { joinedAt: Date.now() });
    // Кампанії (пароль-челендж тощо) обробляють свої payload самі.
    for (const hk of hooks.onStartPayload) { if (await hk(ctx, uid, payload)) return; }
    if (!(await gate(ctx, uid))) return;
    await sendWelcome(ctx, uid);
  });

  bot.action('check_sub', async (ctx) => {
    const uid = String(ctx.from.id);
    subscription.forget(uid);
    const ok = await subscription.isSubscribed(uid);
    const lang = (users.get(uid) || {}).lang || 'uk';
    if (!ok) {
      await ctx.answerCbQuery(i18n.t(lang, 'start.subNotYet', { channel: config.CHANNEL_USERNAME }).replace(/<[^>]+>/g, ''), { show_alert: true }).catch(() => {});
      return;
    }
    await ctx.answerCbQuery('✅').catch(() => {});
    referrals.attributeIfPending(uid);
    await ctx.deleteMessage().catch(() => {});
    await sendWelcome(ctx, uid);
  });

  bot.action('lang_menu', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(i18n.t('uk', 'lang.pick'), ui.kb([[ui.cb('🇺🇦 Українська', 'lang_uk'), ui.cb('🇬🇧 English', 'lang_en'), ui.cb('🇷🇺 Русский', 'lang_ru')]])).catch(() => {});
  });
  bot.action(/^lang_(uk|en|ru)$/, async (ctx) => {
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    users.patch(uid, { lang: ctx.match[1] });
    await ctx.answerCbQuery('✅').catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    if (!(await gate(ctx, uid))) return;
    await sendWelcome(ctx, uid);
  });

  const openTab = (tab) => async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    const lang = users.get(uid).lang || langFromTg(ctx.from);
    await ctx.reply(i18n.t(lang, 'start.inApp'), ui.openApp(lang, tab)).catch(() => {});
  };
  bot.command('app', openTab(null));
  bot.command('bank', openTab('bank'));
  bot.command('pass', openTab('pass'));
  bot.command('games', openTab('games'));
  bot.command('topup', openTab('wallet'));
  bot.command('wallet', openTab('wallet'));
  bot.command('friends', openTab('friends'));

  bot.command('help', async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    const lang = users.get(uid).lang || 'uk';
    await ctx.reply(i18n.t(lang, 'start.help', { support: config.SUPPORT }), { parse_mode: 'HTML', ...ui.openApp(lang) }).catch(() => {});
  });
  bot.command('lang', async (ctx) => {
    await ctx.reply(i18n.t('uk', 'lang.pick'), ui.kb([[ui.cb('🇺🇦 Українська', 'lang_uk'), ui.cb('🇬🇧 English', 'lang_en'), ui.cb('🇷🇺 Русский', 'lang_ru')]])).catch(() => {});
  });

  // Промокод: /promo КОД або кнопкою, потім текстом.
  bot.command('promo', async (ctx, next) => {
    // Адмін: «/promo» — довідка, «/promo КОД 10з 50» — створення (обробляє адмін-модуль).
    if (users.isAdmin(ctx.from.id) && ctx.message.text.trim().split(/\s+/).length !== 2) return next();
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    const code = ctx.message.text.split(/\s+/)[1];
    if (!code) { awaitingPromo.add(uid); return ctx.reply(i18n.t(users.get(uid).lang, 'promo.ask')).catch(() => {}); }
    await redeem(ctx, uid, code);
  });
  bot.action('promo_code_start', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    awaitingPromo.add(uid);
    await ctx.reply(i18n.t((users.get(uid) || {}).lang, 'promo.ask')).catch(() => {});
  });
  async function redeem(ctx, uid, code) {
    if (!(await gate(ctx, uid))) return;
    const lang = users.get(uid).lang || 'uk';
    const r = await promo.redeem(uid, code);
    if (!r.ok) return ctx.reply(i18n.t(lang, r.error === 'used' ? 'promo.used' : r.error === 'limit' ? 'promo.limit' : 'promo.bad')).catch(() => {});
    await ctx.reply(i18n.t(lang, 'promo.ok', { what: r.what }), ui.openApp(lang)).catch(() => {});
  }
  hooks.onText.push(async (ctx, uid, text) => {
    if (!awaitingPromo.has(uid)) return false;
    awaitingPromo.delete(uid);
    await redeem(ctx, uid, text.trim());
    return true;
  });
  hooks.onCommand.push((uid) => awaitingPromo.delete(uid));

  // ─── Оплата Telegram Stars ─────────────────────────────────────────────
  bot.on('pre_checkout_query', async (ctx) => {
    const err = wallet.precheck(ctx.preCheckoutQuery);
    if (err) return ctx.answerPreCheckoutQuery(false, err).catch(() => {});
    await ctx.answerPreCheckoutQuery(true).catch(() => {});
  });
  bot.on('message', async (ctx, next) => {
    if (!(ctx.message && ctx.message.successful_payment)) return next();
    await wallet.processPayment(ctx.message.successful_payment, String(ctx.from.id), ctx.from);
  });
}

// Гейт техробіт для бота (оплата проходить завжди).
function maintenanceGate() {
  const told = new Map();
  return async (ctx, next) => {
    const m = maintenance.state();
    if (m.mode !== 'full' || !ctx.from || users.isAdmin(ctx.from.id)) return next();
    if (ctx.updateType === 'pre_checkout_query' || (ctx.message && ctx.message.successful_payment)) return next();
    if (ctx.chat && ctx.chat.type !== 'private') return next();
    const uid = String(ctx.from.id);
    if (ctx.updateType === 'callback_query') await ctx.answerCbQuery('🛠').catch(() => {});
    if (Date.now() - (told.get(uid) || 0) < 300000) return;
    told.set(uid, Date.now());
    const lang = (users.get(uid) || {}).lang || 'uk';
    await ctx.reply(i18n.t(lang, 'maint.full', {
      text: esc(m.text), support: config.SUPPORT,
      left: m.left ? i18n.t(lang, 'maint.left', { left: time.humanLeft(m.left) }) : '',
    }), { parse_mode: 'HTML' }).catch(() => {});
  };
}

// Старі кнопки зі старих повідомлень (меню, ігри, пас, банк, вивід…) —
// ведемо в застосунок замість мовчання.
function legacyCallbacks(bot) {
  bot.on('callback_query', async (ctx) => {
    const uid = String(ctx.from.id);
    const lang = (users.get(uid) || {}).lang || 'uk';
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const data = String((ctx.callbackQuery && ctx.callbackQuery.data) || '');
    const tab = /wd_|withdraw|topup/.test(data) ? 'wallet' : /bank/.test(data) ? 'bank' : /pass/.test(data) ? 'pass'
      : /dice/.test(data) ? 'games' : /rewards|claim_/.test(data) ? 'friends' : null;
    await ctx.reply(i18n.t(lang, 'start.inApp'), ui.openApp(lang, tab)).catch(() => {});
  });
}

module.exports = { register, maintenanceGate, legacyCallbacks, sendWelcome, gate, shareUrl, langFromTg };
