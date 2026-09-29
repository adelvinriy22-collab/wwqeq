// ==========================================================================
// Повідомлення з сервісів. Сервіси (колеса, заявки, банк…) не знають про
// Telegraf — вони кличуть notify.*, а бот при старті підставляє сюди свій
// клієнт Telegram. Так логіку можна тестувати без бота.
// ==========================================================================
const config = require('../config');
const store = require('../store');

const tg = { telegram: null, botUsername: null, chat: null };

function webAppUrl(tab) {
  const base = config.WEBAPP_URL;
  if (!base) return null;
  return tab ? base + (base.includes('?') ? '&' : '?') + 'tab=' + encodeURIComponent(tab) : base;
}
// Кнопка «відкрити застосунок» (лише якщо задано WEBAPP_URL — інакше Telegram
// відхилив би повідомлення цілком).
function appButton(text, tab) {
  const url = webAppUrl(tab);
  return url ? { text, web_app: { url } } : null;
}
function appKeyboard(text, tab, extraRows) {
  const b = appButton(text, tab);
  const rows = (b ? [[b]] : []).concat(extraRows || []);
  return rows.length ? { reply_markup: { inline_keyboard: rows } } : {};
}

function markBlocked(uid, e) {
  const m = String((e && e.message) || '');
  const code = e && (e.code || (e.response && e.response.error_code));
  if (code === 403 || m.includes('blocked') || m.includes('deactivated') || m.includes('chat not found')) {
    const u = store.getUser(String(uid));
    if (u && !u.remindersOff) store.upsertUser(String(uid), { remindersOff: true });
    return true;
  }
  return false;
}

// Особисте повідомлення. Помилки не прокидаються — повідомлення не критичне.
async function dm(uid, text, extra) {
  if (!tg.telegram || !uid) return null;
  try { return await tg.telegram.sendMessage(String(uid), text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); }
  catch (e) { markBlocked(uid, e); return null; }
}
async function photo(uid, src, extra) {
  if (!tg.telegram || !uid) return null;
  try { return await tg.telegram.sendPhoto(String(uid), src, { parse_mode: 'HTML', ...(extra || {}) }); }
  catch (e) { markBlocked(uid, e); return null; }
}
async function admin(text, extra) {
  if (!config.ADMIN_CHAT_ID) return null;
  return dm(config.ADMIN_CHAT_ID, text, extra);
}
// Оголошення в чаті (через модуль чату, з його лімітами).
async function announce(text) {
  if (!tg.chat) return null;
  try { return await tg.chat.announce(text); } catch (e) { return null; }
}

module.exports = { tg, dm, photo, admin, announce, webAppUrl, appButton, appKeyboard, markBlocked };
