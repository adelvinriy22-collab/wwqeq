// ==========================================================================
// «ПЕРШОМУ КОМЕНТАРЮ — ГІФТ ЗА 15⭐». Адмін пише /first_gift — бот публікує
// пост у канал. Коментарі каналу приходять у пов'язану групу обговорення:
// бот ловить ПЕРШИЙ коментар, відповідає на нього кнопками (🧸 Мішка /
// 💝 Сердечко — натиснути може лише переможець), після вибору одразу надсилає
// справжній подарунок Telegram і дописує в пост каналу, хто забрав.
//
// Бот має бути адміном каналу (публікувати й редагувати) і адміном групи
// обговорення (щоб бачити всі коментарі, а не лише звернення до себе).
// Стан — featureFlags.firstComment, переживає перезапуск.
// ==========================================================================
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const users = require('../core/users');
const notify = require('../core/notify');
const applications = require('../features/applications');
const tggifts = require('../features/tggifts');
const usergifts = require('../features/usergifts');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');

const CHOICES = { bear: '🧸 Мішка', heart: '💝 Сердечко' };
const POST_TEXT = '{:giftBox} <b>Першому коментарю — будь-який гіфт за 15⭐️</b>';
const GIFT_TEXT = '🎁 Подарунок за перший коментар у каналі StarForge!';

// Подарунок: від акаунта власника (якщо підключено через /tg_login), інакше — від бота.
// Акаунт шукає людину за @ніком; не вийшло — пробуємо ботом.
async function sendGift(winner, choice) {
  if (usergifts.accountReady()) {
    const r = await usergifts.send(winner.username ? '@' + winner.username : winner.uid, choice, GIFT_TEXT);
    if (r.ok) return { ...r, via: 'account' };
    console.error('first comment: account gift failed:', r.error);
    const b = await tggifts.send(winner.uid, choice, GIFT_TEXT);
    return b.ok ? { ...b, via: 'bot' } : { ...b, error: 'акаунт: ' + r.error + ' · бот: ' + b.error };
  }
  const b = await tggifts.send(winner.uid, choice, GIFT_TEXT);
  return { ...b, via: 'bot' };
}

const st = () => (store.getFeatureFlags() || {}).firstComment || null;
const setSt = (patch) => store.setFeatureFlags({ firstComment: patch === null ? null : { ...(st() || {}), ...patch } });
const nameOf = (from) => (from.username ? '@' + from.username : esc(from.first_name || 'гравець'));
const btn = (text, data, style, icon) => {
  const b = { text, callback_data: data };
  if (style) b.style = style;
  const { EMOJI } = require('../emoji');
  if (icon && EMOJI[icon] && EMOJI[icon].id) b.icon_custom_emoji_id = EMOJI[icon].id;
  return b;
};

// Пост у каналі — автоматична копія в групі обговорення (корінь гілки коментарів).
function isOurPostCopy(m, s) {
  if (!m || !m.is_automatic_forward || !s) return false;
  const o = m.forward_origin;
  const mid = (o && o.message_id) || m.forward_from_message_id;
  return Number(mid) === Number(s.channelMsgId);
}
function isCommentToPost(m, s) {
  if (!m || !s || !s.rootId || String(m.chat.id) !== String(s.groupId)) return false;
  const r = m.reply_to_message;
  return (r && r.message_id === s.rootId) || m.message_thread_id === s.rootId;
}

function middleware() {
  return async (ctx, next) => {
    const s = st();
    if (!s || !ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) return next();

    // Кнопки переможця.
    if (ctx.updateType === 'callback_query') {
      const data = String(ctx.callbackQuery.data || '');
      if (!data.startsWith('fc:')) return next();
      const [, id, choice] = data.split(':');
      if (id !== s.id || !CHOICES[choice]) return ctx.answerCbQuery('Цей розіграш уже завершено').catch(() => {});
      if (!s.winner || String(ctx.from.id) !== String(s.winner.uid)) return ctx.answerCbQuery('Ці кнопки — для переможця 🙂 Стеж за наступними постами!', { show_alert: true }).catch(() => {});
      if (s.status === 'sent') return ctx.answerCbQuery('Подарунок уже надіслано 🎁').catch(() => {});
      if (s.status === 'sending') return ctx.answerCbQuery('⏳ Уже надсилаю…').catch(() => {});
      setSt({ status: 'sending', choice });                         // до await — подвійне натискання не надішле двічі
      await ctx.answerCbQuery('⏳ Надсилаю ' + CHOICES[choice] + '…').catch(() => {});
      const r = await sendGift(s.winner, choice);
      const who = s.winner.name;
      if (r.ok) {
        setSt({ status: 'sent', sentAt: Date.now() });
        const a = applications.create(s.winner.uid, choice, 'first_comment', { autoSent: true }, { silent: true });
        a.status = 'approved'; a.decidedAt = Date.now(); store.save();
        await ctx.editMessageText(withEmoji(`{:check} <b>${who}</b>, ${CHOICES[choice]} уже надіслано! Глянь у профілі Telegram → «Подарунки» {:giftBox}\n\nДякуємо, що ти з нами — стеж за наступними постами {:almost}`), { parse_mode: 'HTML' }).catch(() => {});
        // Дописуємо в пост каналу, хто забрав, — видно, що все чесно й реально.
        if (s.channelMsgId && s.channelId) {
          notify.tg.telegram.editMessageText(s.channelId, s.channelMsgId, undefined,
            withEmoji(s.text + `\n\n{:check} Забрав <b>${who}</b> — ${CHOICES[choice]} уже надіслано!`), { parse_mode: 'HTML' }).catch(() => {});
        }
        notify.admin(`🎁 Перший коментар: ${who} · <code>${s.winner.uid}</code> — надіслано ${CHOICES[choice]} (${r.via === 'account' ? 'від вашого акаунта' : 'від бота'})`);
      } else {
        setSt({ status: 'won', lastError: r.error });
        const bot = notify.tg.botUsername;
        await ctx.editMessageText(withEmoji(`{:warn} <b>${who}</b>, не вийшло надіслати автоматично.\n` +
          (bot ? `Запусти бота @${bot} і натисни кнопку ще раз 👇` : 'Спробуй ще раз за хвилину 👇')), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [btn(CHOICES.bear, `fc:${s.id}:bear`, 'success', 'teddyBear'), btn(CHOICES.heart, `fc:${s.id}:heart`, 'danger')],
          bot ? [{ text: '🤖 ЗАПУСТИТИ БОТА', url: 'https://t.me/' + bot }] : [],
        ].filter(r2 => r2.length) } }).catch(() => {});
        notify.admin(`⚠️ Перший коментар: не вдалось надіслати ${CHOICES[choice]} для ${who} · <code>${s.winner.uid}</code>\n<code>${esc(r.error)}</code>` +
          (r.lowBalance ? '\nСхоже, замало зірок на балансі бота.' : '\nМожливо, переможець ще не запускав бота.'));
      }
      return;
    }

    const m = ctx.message;
    if (!m) return next();
    // Копія нашого поста в групі обговорення — запам'ятовуємо корінь гілки.
    if (!s.rootId && isOurPostCopy(m, s)) {
      setSt({ rootId: m.message_id, groupId: m.chat.id });
      return next();
    }
    // Перший коментар від живої людини (не адмін, не від імені каналу).
    if (s.status === 'waiting' && isCommentToPost(m, s) && m.from && !m.from.is_bot && !m.sender_chat && !users.isAdmin(m.from.id)) {
      const cur = st();
      if (cur.status !== 'waiting') return next();
      const winner = { uid: String(m.from.id), username: m.from.username || null, name: nameOf(m.from), commentId: m.message_id, at: Date.now() };
      setSt({ status: 'won', winner });                               // синхронно: другий коментар уже не переможе
      users.ensure(m.from);
      await ctx.reply(withEmoji(`{:crown} <b>${winner.name}</b>, ти перший! {:lightning}\nОбирай подарунок — надішлю його одразу:`), {
        parse_mode: 'HTML', reply_to_message_id: m.message_id, allow_sending_without_reply: true,
        reply_markup: { inline_keyboard: [[btn(CHOICES.bear, `fc:${cur.id}:bear`, 'success', 'teddyBear'), btn(CHOICES.heart, `fc:${cur.id}:heart`, 'danger')]] },
      }).catch((e) => console.error('first comment reply:', e.message));
      notify.admin(`🏁 Перший коментар: ${winner.name} · <code>${winner.uid}</code> — обирає подарунок`);
    }
    return next();
  };
}

function register(bot) {
  bot.command('first_gift', async (ctx) => {
    if (!(ctx.from && users.isAdmin(ctx.from.id)) || (ctx.chat && ctx.chat.type !== 'private')) return;
    const arg = ctx.message.text.replace(/^\/first_gift(@\w+)?\s*/, '').trim();
    const s = st();
    if (arg === 'status') {
      if (!s) return ctx.reply('Зараз нічого не запущено.\n/first_gift — опублікувати пост у каналі.');
      const state = { waiting: '⏳ чекаю перший коментар', won: '🏁 переможець обирає подарунок', sending: '📤 надсилаю', sent: '✅ надіслано' }[s.status] || s.status;
      return ctx.reply(`🎁 Перший коментар: ${state}` + (s.winner ? `\nПереможець: ${s.winner.name.replace(/<[^>]+>/g, '')}` : '') +
        (s.rootId ? '' : '\n⚠️ Бот ще не побачив пост у групі обговорення — перевір, що канал має групу для коментарів і бот у ній адмін.'));
    }
    if (arg === 'cancel') {
      if (!s) return ctx.reply('Нічого скасовувати.');
      setSt(null);
      return ctx.reply('🚫 Скасовано. Пост у каналі лишився — видали його вручну, якщо треба.');
    }
    if (s && (s.status === 'waiting' || s.status === 'won' || s.status === 'sending')) {
      return ctx.reply('Попередній ще триває. /first_gift status — стан, /first_gift cancel — скасувати.');
    }
    const text = arg ? esc(arg) : POST_TEXT;
    let m;
    try { m = await ctx.telegram.sendMessage(config.CHANNEL_USERNAME, withEmoji(text), { parse_mode: 'HTML' }); }
    catch (e) { return ctx.reply('❌ Не вдалось написати в канал ' + config.CHANNEL_USERNAME + ': ' + e.message + '\nБот має бути адміном каналу з правом публікувати.'); }
    const id = crypto.randomBytes(3).toString('hex');
    store.setFeatureFlags({ firstComment: { id, status: 'waiting', text, channelId: (m.chat && m.chat.id) || config.CHANNEL_USERNAME, channelMsgId: m.message_id, rootId: null, groupId: null, winner: null, createdAt: Date.now() } });
    await ctx.reply('✅ Пост у каналі опубліковано. Чекаю перший коментар — бот відповість на нього сам.\n\n' +
      'Щоб бот бачив коментарі, він має бути адміном групи обговорення каналу.\n/first_gift status — стан · /first_gift cancel — скасувати');
  });
}

module.exports = { middleware, register };
