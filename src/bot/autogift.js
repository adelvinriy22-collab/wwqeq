// ==========================================================================
// АВТОВИВІД ДЛЯ ОБРАНИХ (одноразовий). Адмін вводить /autowd @нік — гравцю
// відкривається автовивід: бот САМ, без черги, надсилає йому справжній
// подарунок Telegram 🧸 Мішку (15⭐ з балансу зірок бота) з підписом, який
// гравець пише сам (до 128 символів, можна з емодзі). Лише один раз.
//
// Стан у гравця — u.autoGift: { status: granted | sending | sent, grantedAt, by,
// draft: { text, entities }, sentAt, text }. «sending» ставиться ДО виклику
// Telegram, тож подвійне натискання не надішле дві Мішки.
// ==========================================================================
const users = require('../core/users');
const notify = require('../core/notify');
const ui = require('./ui');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');
const time = require('../lib/time');

const tggifts = require('../features/tggifts');

const GIFT = { tier: 'bear', ...tggifts.CATALOG.bear };   // «Мішка» з каталогу Telegram
const TEXT_MAX = tggifts.TEXT_MAX;                         // ліміт Telegram на підпис подарунка

const T = {
  uk: {
    grant: '{:giftBox} <b>АВТОВИВІД ВІДКРИТО!</b>\n━━━━━━━━━━━━━━\nТи серед обраних {:crown} — бот <b>сам, без черги</b> надішле тобі справжню {:teddyBear} <b>Мішку</b> прямо в профіль Telegram.\n\n{:lightning} Можеш додати свій підпис до подарунка — до {max} символів, з емодзі.\n\n<i>Автовивід одноразовий — забери, поки діє.</i>',
    write: 'НАПИСАТИ ПІДПИС', plain: 'ЗАБРАТИ БЕЗ ПІДПИСУ', sendWith: 'НАДІСЛАТИ МІШКУ', change: 'ЗМІНИТИ ПІДПИС', noText: 'БЕЗ ПІДПИСУ',
    ask: '{:lightning} Напиши підпис до Мішки одним повідомленням — до {max} символів. Емодзі можна 😉',
    tooLong: '{:warn} Задовго: {n} символів, а можна до {max}. Спробуй коротше.', empty: '{:warn} Підпис порожній — напиши текст або натисни «Без підпису».',
    preview: '{:eye} <b>Так виглядатиме підпис:</b>', previewFoot: 'Надсилаємо?',
    sending: '⏳ Надсилаю Мішку…', sent: '{:check} <b>МІШКУ НАДІСЛАНО!</b>\n━━━━━━━━━━━━━━\n{:teddyBear} Глянь у своєму профілі Telegram → «Подарунки».\n\nЦе був автовивід для обраних {:crown} Дякуємо, що ти з нами!',
    failed: '{:warn} Не вийшло надіслати зараз. Спробуй ще раз за кілька хвилин — автовивід за тобою.', retry: 'СПРОБУВАТИ ЩЕ',
    already: '{:check} Ти вже отримав Мішку автовиводом {date}. Автовивід одноразовий.', notOpen: 'Автовивід тобі поки не відкрито.', busy: '⏳ Уже надсилаю — зачекай кілька секунд.',
  },
  en: {
    grant: '{:giftBox} <b>AUTO-WITHDRAWAL UNLOCKED!</b>\n━━━━━━━━━━━━━━\nYou are one of the chosen {:crown} — the bot will send you a real {:teddyBear} <b>Teddy Bear</b> gift <b>by itself, no queue</b>, straight to your Telegram profile.\n\n{:lightning} You can add your own caption to the gift — up to {max} characters, emoji welcome.\n\n<i>This auto-withdrawal is one-time — claim it while it lasts.</i>',
    write: 'WRITE A CAPTION', plain: 'CLAIM WITHOUT CAPTION', sendWith: 'SEND THE TEDDY', change: 'CHANGE CAPTION', noText: 'NO CAPTION',
    ask: '{:lightning} Send the caption for your Teddy in one message — up to {max} characters. Emoji are welcome 😉',
    tooLong: '{:warn} Too long: {n} characters, the limit is {max}. Try shorter.', empty: '{:warn} The caption is empty — write something or tap «No caption».',
    preview: '{:eye} <b>This is how the caption will look:</b>', previewFoot: 'Send it?',
    sending: '⏳ Sending your Teddy…', sent: '{:check} <b>TEDDY SENT!</b>\n━━━━━━━━━━━━━━\n{:teddyBear} Check your Telegram profile → «Gifts».\n\nThat was the auto-withdrawal for the chosen {:crown} Thanks for being with us!',
    failed: '{:warn} Couldn’t send it right now. Try again in a few minutes — the auto-withdrawal is still yours.', retry: 'TRY AGAIN',
    already: '{:check} You already got your Teddy by auto-withdrawal {date}. It is one-time.', notOpen: 'Auto-withdrawal isn’t unlocked for you yet.', busy: '⏳ Already sending — wait a few seconds.',
  },
  ru: {
    grant: '{:giftBox} <b>АВТОВЫВОД ОТКРЫТ!</b>\n━━━━━━━━━━━━━━\nТы среди избранных {:crown} — бот <b>сам, без очереди</b> отправит тебе настоящего {:teddyBear} <b>Мишку</b> прямо в профиль Telegram.\n\n{:lightning} Можешь добавить свою подпись к подарку — до {max} символов, с эмодзи.\n\n<i>Автовывод одноразовый — забери, пока действует.</i>',
    write: 'НАПИСАТЬ ПОДПИСЬ', plain: 'ЗАБРАТЬ БЕЗ ПОДПИСИ', sendWith: 'ОТПРАВИТЬ МИШКУ', change: 'ИЗМЕНИТЬ ПОДПИСЬ', noText: 'БЕЗ ПОДПИСИ',
    ask: '{:lightning} Напиши подпись к Мишке одним сообщением — до {max} символов. Эмодзи можно 😉',
    tooLong: '{:warn} Слишком длинно: {n} символов, а можно до {max}. Попробуй короче.', empty: '{:warn} Подпись пустая — напиши текст или нажми «Без подписи».',
    preview: '{:eye} <b>Так будет выглядеть подпись:</b>', previewFoot: 'Отправляем?',
    sending: '⏳ Отправляю Мишку…', sent: '{:check} <b>МИШКА ОТПРАВЛЕН!</b>\n━━━━━━━━━━━━━━\n{:teddyBear} Загляни в свой профиль Telegram → «Подарки».\n\nЭто был автовывод для избранных {:crown} Спасибо, что ты с нами!',
    failed: '{:warn} Не получилось отправить сейчас. Попробуй ещё раз через несколько минут — автовывод за тобой.', retry: 'ПОПРОБОВАТЬ ЕЩЁ',
    already: '{:check} Ты уже получил Мишку автовыводом {date}. Автовывод одноразовый.', notOpen: 'Автовывод тебе пока не открыт.', busy: '⏳ Уже отправляю — подожди несколько секунд.',
  },
};
const langOf = (uid) => { const l = (users.get(uid) || {}).lang; return T[l] ? l : 'uk'; };
const fill = (lang, k, p) => String((T[lang] || T.uk)[k] || T.uk[k]).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m));
const tt = (lang, k, p) => withEmoji(fill(lang, k, { max: TEXT_MAX, ...(p || {}) }));
const bt = fill;
const html = (rows) => ({ parse_mode: 'HTML', ...ui.kb(rows) });
const stateOf = (uid) => (users.get(uid) || {}).autoGift || null;
const setState = (uid, patch) => users.patch(uid, { autoGift: { ...(stateOf(uid) || {}), ...patch } });
const who = (u) => (u.username ? '@' + u.username : esc(u.name || '')) + ' · <code>' + u.id + '</code>';


// ─── Адмін відкриває автовивід ──────────────────────────────────────────
function grantKeyboard(lang) {
  return html([
    [ui.cb(bt(lang, 'write'), 'ag:text', 'primary', 'lightning')],
    [ui.cb(bt(lang, 'plain'), 'ag:plain', 'success', 'teddyBear')],
  ]);
}
async function grant(uid, adminId) {
  const st = stateOf(uid);
  if (st && st.status === 'sent') return { ok: false, error: 'already', at: st.sentAt };
  if (!st || st.status !== 'sending') setState(uid, { status: 'granted', grantedAt: Date.now(), by: String(adminId) });
  const lang = langOf(uid);
  const m = await notify.dm(uid, tt(lang, 'grant'), grantKeyboard(lang));
  return { ok: true, delivered: !!m };
}

// ─── Надіслати Мішку ────────────────────────────────────────────────────
async function send(ctx, uid) {
  const lang = langOf(uid);
  const st = stateOf(uid);
  if (!st) return ctx.reply(bt(lang, 'notOpen')).catch(() => {});
  if (st.status === 'sent') return ctx.reply(tt(lang, 'already', { date: time.fmtKyiv(st.sentAt, { day: 'numeric', month: 'long' }, lang) }), { parse_mode: 'HTML' }).catch(() => {});
  if (st.status === 'sending') return ctx.reply(bt(lang, 'busy')).catch(() => {});
  // Стан «надсилаю» — синхронно, до будь-якого await: другий клік сюди вже не пройде.
  setState(uid, { status: 'sending', sendingAt: Date.now() });
  await ctx.reply(bt(lang, 'sending')).catch(() => {});
  const draft = st.draft || null;
  const r = await tggifts.send(uid, GIFT.tier, draft && draft.text, draft && draft.entities);
  if (!r.ok) {
    setState(uid, { status: 'granted', lastError: r.error, lastErrorAt: Date.now() });
    const u = users.get(uid) || {};
    notify.admin('⚠️ <b>Автовивід не вдався</b>: ' + who(u) + '\n<code>' + esc(r.error) + '</code>' +
      (r.lowBalance ? '\n\nСхоже, на балансі зірок бота замало (Мішка коштує ' + GIFT.stars + '⭐). Поповни баланс бота — і гравець натисне «Спробувати ще».' : ''));
    return ctx.reply(tt(lang, 'failed'), html([[ui.cb(bt(lang, 'retry'), 'ag:send', 'primary', 'lightning')]])).catch(() => {});
  }
  setState(uid, { status: 'sent', sentAt: Date.now(), text: draft ? draft.text : '' });
  const u = users.get(uid) || {};
  await ctx.reply(tt(lang, 'sent'), html([[ui.app(i18nOpen(lang), null, 'success', 'rocket')], [ui.back(lang)]])).catch(() => {});
  notify.admin('🧸 <b>Автовивід виконано</b>: ' + who(u) + (draft && draft.text ? '\nПідпис: ' + esc(draft.text) : '\nБез підпису'));
  // Двіж у чаті: хай усі бачать, що бот реально видає.
  notify.announce(withEmoji('{:teddyBear} <b>' + (u.username ? '@' + esc(u.username) : esc(u.name || 'Гравець')) + '</b> отримав справжню <b>Мішку</b> через <b>АВТОВИВІД</b> — бот видав сам, без черги {:lightning}\nАвтовивід — для обраних {:crown} Будь активним — і наступним можеш бути ти 👀'));
  return null;
}
const i18nOpen = (lang) => require('../i18n').t(lang, 'btn.open');

const cleanEntities = tggifts.cleanEntities;

function register(bot, hooks) {
  const awaiting = new Set();
  const priv = (ctx) => !ctx.chat || ctx.chat.type === 'private';

  bot.action('ag:text', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    const uid = String(ctx.from.id), lang = langOf(uid);
    const st = stateOf(uid);
    if (!st || st.status === 'sent') return send(ctx, uid);        // пояснить, чому ні
    awaiting.add(uid);
    await ctx.reply(tt(lang, 'ask'), html([[ui.cb(bt(lang, 'noText'), 'ag:plain', 'success', 'teddyBear')]])).catch(() => {});
  });
  bot.action('ag:plain', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    const uid = String(ctx.from.id);
    awaiting.delete(uid);
    if (stateOf(uid) && stateOf(uid).status === 'granted') setState(uid, { draft: null });
    await send(ctx, uid);
  });
  bot.action('ag:send', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    awaiting.delete(String(ctx.from.id));
    await send(ctx, String(ctx.from.id));
  });

  hooks.onText.push(async (ctx, uid) => {
    if (!awaiting.has(uid)) return false;
    awaiting.delete(uid);
    const lang = langOf(uid);
    const st = stateOf(uid);
    if (!st || st.status !== 'granted') return false;
    const text = String(ctx.message.text || '');
    if (!text.trim()) { awaiting.add(uid); await ctx.reply(tt(lang, 'empty'), { parse_mode: 'HTML' }).catch(() => {}); return true; }
    if (text.length > TEXT_MAX) { awaiting.add(uid); await ctx.reply(tt(lang, 'tooLong', { n: text.length }), { parse_mode: 'HTML' }).catch(() => {}); return true; }
    const entities = cleanEntities(ctx.message.entities);
    setState(uid, { draft: { text, entities } });
    await ctx.reply(tt(lang, 'preview'), { parse_mode: 'HTML' }).catch(() => {});
    // Показуємо підпис рівно так, як його побачить отримувач (з емодзі й форматуванням).
    await ctx.reply(text, { entities, ...ui.kb([
      [ui.cb(bt(lang, 'sendWith'), 'ag:send', 'success', 'teddyBear')],
      [ui.cb(bt(lang, 'change'), 'ag:text', 'primary', 'lightning'), ui.cb(bt(lang, 'noText'), 'ag:plain')],
    ]) }).catch(() => {});
    return true;
  });
  hooks.onCommand.push((uid) => awaiting.delete(uid));

  // ─── Адмін ────────────────────────────────────────────────────────────
  bot.command('autowd', async (ctx) => {
    if (!(ctx.from && users.isAdmin(ctx.from.id))) return;
    const [q, mode] = ctx.message.text.split(/\s+/).slice(1);
    if (!q) {
      const list = Object.values(users.all()).filter(u => u && u.autoGift);
      const line = (u) => ({ granted: '⏳ чекає', sending: '📤 надсилається', sent: '✅ отримав' }[u.autoGift.status] || u.autoGift.status) + ' — ' + who(u);
      return ctx.reply('🧸 <b>Автовивід для обраних</b> (одноразова Мішка, ' + GIFT.stars + '⭐ з балансу зірок бота)\n\n' +
        '<code>/autowd @нік</code> — відкрити гравцю\n<code>/autowd @нік off</code> — скасувати, поки не забрав\n<code>/autowd @нік retry</code> — якщо завис «надсилається»\n\n' +
        (list.length ? list.slice(-30).map(line).join('\n') : 'Поки нікому не відкрито.'), { parse_mode: 'HTML' }).catch(() => {});
    }
    const u = users.findByUsernameOrId(q);
    if (!u) return ctx.reply('Не знайшов ' + q + '. Гравець має хоч раз запустити бота.').catch(() => {});
    const st = u.autoGift;
    if (mode === 'off') {
      if (st && st.status === 'sent') return ctx.reply('Уже отримав — скасувати не можна.').catch(() => {});
      users.patch(u.id, { autoGift: null });
      return ctx.reply('🚫 Автовивід для ' + (u.username ? '@' + u.username : u.id) + ' скасовано.').catch(() => {});
    }
    if (mode === 'retry') {
      if (!st || st.status !== 'sending') return ctx.reply('Нічого не зависло.').catch(() => {});
      setState(String(u.id), { status: 'granted' });
      return ctx.reply('🔁 Повернув у «чекає» — гравець може натиснути ще раз. Перевір спершу, що Мішка справді не дійшла.').catch(() => {});
    }
    const r = await grant(String(u.id), ctx.from.id);
    if (!r.ok) return ctx.reply('✅ ' + (u.username ? '@' + u.username : u.id) + ' уже отримав Мішку автовиводом ' + time.fmtKyiv(r.at, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + '. Автовивід одноразовий.').catch(() => {});
    await ctx.reply('🧸 Автовивід відкрито для ' + (u.username ? '@' + u.username : u.id) + '.\n' +
      (r.delivered ? 'Йому прийшло повідомлення: він напише свій підпис (або без нього) — і бот сам надішле Мішку.' : '⚠️ Повідомлення не дійшло (бот заблокований?). Коли гравець відкриє бота — /autowd ' + q + ' ще раз.') +
      '\n\nНа балансі зірок бота має бути щонайменше ' + GIFT.stars + '⭐.').catch(() => {});
  });
}

module.exports = { register, grant, send, GIFT, TEXT_MAX };
