// Кнопки й оформлення повідомлень бота.
const { EMOJI, E } = require('../emoji');
const notify = require('../core/notify');
const i18n = require('../i18n');

// Кольорові кнопки (Bot API 9.4): style = success | danger | primary.
function cb(text, data, style, emojiKey) {
  const b = { text, callback_data: data };
  if (style) b.style = style;
  if (emojiKey && EMOJI[emojiKey] && EMOJI[emojiKey].id) b.icon_custom_emoji_id = EMOJI[emojiKey].id;
  return b;
}
function url(text, href, style, emojiKey) {
  const b = { text, url: href };
  if (style) b.style = style;
  if (emojiKey && EMOJI[emojiKey] && EMOJI[emojiKey].id) b.icon_custom_emoji_id = EMOJI[emojiKey].id;
  return b;
}
function app(text, tab, style) {
  const b = notify.appButton(text, tab);
  if (b && style) b.style = style;
  return b;
}
function kb(rows) {
  const clean = rows.map(r => r.filter(Boolean)).filter(r => r.length);
  return clean.length ? { reply_markup: { inline_keyboard: clean } } : {};
}
function openApp(lang, tab, extraRows) {
  return kb([[app(i18n.t(lang, 'btn.open'), tab, 'success')]].concat(extraRows || []));
}

const LINE = '━━━━━━━━━━━━━━';
function card(icon, title, lines, foot) {
  return E(icon, icon) + ' <b>' + title + '</b>\n' + LINE + '\n' +
    lines.filter(l => l !== null && l !== undefined && l !== false).join('\n') + (foot ? '\n\n<i>' + foot + '</i>' : '');
}

// Надіслати довгий текст частинами (ліміт Telegram — 4096 символів).
async function replyLong(ctx, text, extra) {
  let t = String(text);
  while (t.length) {
    let cut = t.length > 3900 ? t.lastIndexOf('\n', 3900) : t.length;
    if (cut < 1000) cut = Math.min(3900, t.length);
    await ctx.reply(t.slice(0, cut), extra).catch(() => {});
    t = t.slice(cut);
  }
}

module.exports = { cb, url, app, kb, openApp, card, replyLong, E, LINE };
