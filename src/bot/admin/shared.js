// Спільне для адмін-модулів: перевірка адміна, покрокові діалоги, розсилки.
const users = require('../../core/users');
const notify = require('../../core/notify');
const { sleep } = require('../../lib/util');

const isAdminCtx = (ctx) => !!(ctx.from && users.isAdmin(ctx.from.id));

// Діалоги «напиши причину…» — чекаємо наступне текстове повідомлення адміна.
const pending = new Map();   // adminUid -> { kind, data, at }
function ask(ctx, kind, data, text) {
  pending.set(String(ctx.from.id), { kind, data, at: Date.now() });
  return ctx.reply(text).catch(() => {});
}
function takePending(uid, kind) {
  const p = pending.get(String(uid));
  if (!p || (kind && p.kind !== kind) || Date.now() - p.at > 15 * 60000) return null;
  pending.delete(String(uid));
  return p;
}
function peekPending(uid) {
  const p = pending.get(String(uid));
  return p && Date.now() - p.at <= 15 * 60000 ? p : null;
}

// Розсилка з лічильниками й звітом. sendOne(uid, u) → Promise.
async function broadcast(ctx, targets, sendOne, label) {
  await ctx.reply(`📣 ${label || 'Розсилка'}: ${targets.length} отримувачів…`).catch(() => {});
  let sent = 0, blocked = 0, failed = 0;
  for (const [uid, u] of targets) {
    try { await sendOne(uid, u); sent++; }
    catch (e) { if (notify.markBlocked(uid, e)) blocked++; else failed++; }
    await sleep(60);
  }
  await ctx.reply(`✅ ${label || 'Розсилка'} завершена\nДоставлено: ${sent}\nЗаблокували бота: ${blocked}\nІнші помилки: ${failed}`).catch(() => {});
  return { sent, blocked, failed };
}
// Хто отримує розсилки: пройшли старт, не блокували бота, не адмін.
function audience(filter) {
  return Object.entries(users.all()).filter(([id, u]) => u && u.lang && !u.remindersOff && !users.isAdmin(id) && (!filter || filter(u, id)));
}

const argsOf = (ctx) => String((ctx.message && ctx.message.text) || '').trim().split(/\s+/).slice(1);
const yes = (ctx) => /(^|\s)(так|yes)(\s|$)/i.test(String((ctx.message && ctx.message.text) || ''));

module.exports = { isAdminCtx, ask, takePending, peekPending, broadcast, audience, argsOf, yes };
