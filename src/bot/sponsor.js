// Місія в боті: «Підпишись на канал-спонсора» (features/sponsor.js).
// Кнопка в головному меню, доки місію не виконано; підписку перевіряє бот.
const users = require('../core/users');
const sponsor = require('../features/sponsor');
const ui = require('./ui');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');
const E = require('../economy');

const T = {
  uk: { btn: 'МІСІЯ: ПІДПИШИСЬ +{t}🎫', title: 'МІСІЯ: ПІДПИСКА', body: '{:megaphone} Підпишись на канал <b>{c}</b> — і забирай <b>+{t}🎫</b> та <b>+{x} XP</b>.\n\n{:warn} Підписка також <b>обов\'язкова для виводу</b> зірок.', foot: 'Підписався? Тисни «Перевірити»', sub: 'ПІДПИСАТИСЯ', check: 'ПЕРЕВІРИТИ',
    ok: '{:check} <b>МІСІЮ ВИКОНАНО!</b>\n━━━━━━━━━━━━━━\n{:giftBox} +<b>{t}🎫</b> · +<b>{x} XP</b>\nДякуємо, що ти з нами {:crown}', no: '{:warn} Не бачу підписки на <b>{c}</b>. Підпишись і натисни «Перевірити» ще раз.', done: '{:check} Місію вже виконано.' },
  en: { btn: 'MISSION: SUBSCRIBE +{t}🎫', title: 'MISSION: SUBSCRIBE', body: '{:megaphone} Subscribe to <b>{c}</b> and get <b>+{t}🎫</b> and <b>+{x} XP</b>.\n\n{:warn} The subscription is also <b>required for withdrawals</b>.', foot: 'Subscribed? Tap «Check»', sub: 'SUBSCRIBE', check: 'CHECK',
    ok: '{:check} <b>MISSION COMPLETE!</b>\n━━━━━━━━━━━━━━\n{:giftBox} +<b>{t}🎫</b> · +<b>{x} XP</b>\nThanks for being with us {:crown}', no: '{:warn} I don\'t see your subscription to <b>{c}</b>. Subscribe and tap «Check» again.', done: '{:check} Mission already completed.' },
  ru: { btn: 'МИССИЯ: ПОДПИШИСЬ +{t}🎫', title: 'МИССИЯ: ПОДПИСКА', body: '{:megaphone} Подпишись на канал <b>{c}</b> — и забирай <b>+{t}🎫</b> и <b>+{x} XP</b>.\n\n{:warn} Подписка также <b>обязательна для вывода</b> звёзд.', foot: 'Подписался? Жми «Проверить»', sub: 'ПОДПИСАТЬСЯ', check: 'ПРОВЕРИТЬ',
    ok: '{:check} <b>МИССИЯ ВЫПОЛНЕНА!</b>\n━━━━━━━━━━━━━━\n{:giftBox} +<b>{t}🎫</b> · +<b>{x} XP</b>\nСпасибо, что ты с нами {:crown}', no: '{:warn} Не вижу подписки на <b>{c}</b>. Подпишись и нажми «Проверить» ещё раз.', done: '{:check} Миссия уже выполнена.' },
};
const langOf = (u) => (T[(u || {}).lang] ? u.lang : 'uk');
const fill = (lang, k) => String(T[lang][k]).replace(/\{(\w)\}/g, (m, x) => ({ t: E.SPONSOR.tickets, x: E.SPONSOR.xp, c: esc(sponsor.channel() || '') })[x] ?? m);

// Кнопка для головного меню (null — місію виконано або вимкнено).
function menuButton(u) {
  if (!sponsor.channel() || ((u && u.taskDone) || {}).sponsor) return null;
  return ui.cb(fill(langOf(u), 'btn'), 'sp:show', 'success', 'megaphone');
}

function card(lang) {
  return {
    text: withEmoji(ui.card('megaphone', fill(lang, 'title'), [fill(lang, 'body')], fill(lang, 'foot'))),
    extra: { parse_mode: 'HTML', ...ui.kb([
      [ui.url(fill(lang, 'sub') + ' — ' + sponsor.channel(), sponsor.link(), 'primary')],
      [ui.cb(fill(lang, 'check'), 'sp:check', 'success', 'check')],
      [ui.back(lang)],
    ]) },
  };
}

function register(bot) {
  bot.command('mission', async (ctx) => {
    if (!sponsor.channel()) return;
    const c = card(langOf(users.get(ctx.from.id)));
    await ctx.reply(c.text, c.extra).catch(() => {});
  });
  bot.action('sp:show', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!sponsor.channel()) return;
    const c = card(langOf(users.get(ctx.from.id)));
    await ctx.reply(c.text, c.extra).catch(() => {});
  });
  bot.action('sp:check', async (ctx) => {
    const uid = String(ctx.from.id), lang = langOf(users.get(uid));
    const r = await sponsor.claim(uid);
    await ctx.answerCbQuery(r.ok ? '✅' : r.error === 'need_sub' ? '❌' : '').catch(() => {});
    const k = r.ok ? 'ok' : r.error === 'already_done' ? 'done' : 'no';
    await ctx.reply(withEmoji(fill(lang, k)), { parse_mode: 'HTML', ...ui.kb([[ui.back(lang)]]) }).catch(() => {});
  });
}

module.exports = { register, menuButton };
