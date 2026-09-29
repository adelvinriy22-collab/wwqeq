// Заявки: кнопки під сповіщенням, команди черги, масові дії.
const store = require('../../store');
const users = require('../../core/users');
const E = require('../../economy');
const applications = require('../../features/applications');
const ui = require('../ui');
const { isAdminCtx, ask, takePending, argsOf, yes } = require('./shared');
const { fmtStars, esc } = require('../../lib/util');

function register(bot, hooks) {
  bot.action(/^admin_approve_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    const r = applications.approve(ctx.match[1]);
    await ctx.answerCbQuery(r.ok ? '✅ Підтверджено' : 'Вже оброблена').catch(() => {});
    if (r.ok) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    if (r.ok) await ctx.reply(`✅ Заявку #${ctx.match[1]} підтверджено.`).catch(() => {});
  });
  bot.action(/^admin_reject_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const a = store.getApplication(ctx.match[1]);
    if (!a || a.status !== 'pending') return ctx.reply('Заявка вже оброблена або не знайдена.').catch(() => {});
    const back = applications.refundable(a);
    await ask(ctx, 'reject', { id: a.id }, `Напиши причину відхилення заявки #${a.id} або «-» без причини.` + (back ? `\n↩️ Людині повернеться ${fmtStars(back)}⭐.` : ''));
  });
  hooks.onAdminText.push(async (ctx, text) => {
    const p = takePending(ctx.from.id, 'reject');
    if (!p) return false;
    const reason = text.trim() === '-' ? null : text.trim();
    const r = applications.reject(p.data.id, reason);
    await ctx.reply(r.ok ? `❌ Заявку #${p.data.id} відхилено${reason ? ' (причина: ' + reason + ')' : ''}.` + (r.refunded ? `\n↩️ Повернуто ${fmtStars(r.refunded)}⭐.` : '') : 'Заявка вже оброблена.').catch(() => {});
    return true;
  });

  const ids = (ctx) => String(ctx.message.text).split(/[\s,#]+/).slice(1).map(x => parseInt(x, 10)).filter(n => !isNaN(n));
  bot.command('approve', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const list = ids(ctx);
    if (!list.length) return ctx.reply('Формат: /approve 142 143');
    const out = list.map(id => { const r = applications.approve(id); return `#${id} ${r.ok ? '✅' : '⏭ ' + (r.status || r.error)}`; });
    await ctx.reply(out.join('\n'));
  });
  bot.command('reject', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const list = ids(ctx);
    if (!list.length) return ctx.reply('Формат: /reject 142 143 (без причини; за оплачені заявки зірки повертаються)');
    const out = list.map(id => { const r = applications.reject(id, null); return `#${id} ${r.ok ? '❌' + (r.refunded ? ' ↩️' + fmtStars(r.refunded) + '⭐' : '') : '⏭ ' + (r.status || r.error)}`; });
    await ctx.reply(out.join('\n'));
  });

  bot.command('apps', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const p = store.listApplications('pending');
    const by = {};
    for (const a of p) by[a.source || 'ladder'] = (by[a.source || 'ladder'] || 0) + 1;
    const payout = p.reduce((s, a) => s + (a.payoutStars || 0), 0);
    await ctx.reply(`📋 <b>Черга заявок</b>: ${p.length}\nДо виплати зірками: <b>${payout}⭐</b>\n\n` +
      Object.entries(by).map(([k, n]) => `• ${applications.sourceLabel(k, 'uk')}: ${n}`).join('\n') +
      '\n\nЗручніше — в адмін-панелі застосунку.', { parse_mode: 'HTML', ...ui.openApp('uk', 'admin') });
  });

  bot.command('requests', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const st = ({ pending: 'pending', approved: 'approved', closed: 'approved', rejected: 'rejected', cancelled: 'cancelled' })[(argsOf(ctx)[0] || 'pending').toLowerCase()] || 'pending';
    const list = store.listApplications(st);
    if (!list.length) return ctx.reply(`Заявок зі статусом «${st}» немає.`);
    await ui.replyLong(ctx, `📋 Заявки (${st}): ${list.length}\n\n` + list.map(a => {
      const u = users.get(a.uid) || {};
      return `#${a.id} · ${applications.label(a, 'uk')} · ${applications.sourceLabel(a.source, 'uk')} · ${u.username ? '@' + u.username : (u.name || a.uid)}`;
    }).join('\n'));
  });
  bot.command('all_requests', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const all = store.listApplications().slice().sort((a, b) => b.createdAt - a.createdAt);
    if (!all.length) return ctx.reply('Заявок немає.');
    const mark = { pending: '⏳', approved: '✅', rejected: '❌', cancelled: '🚫' };
    await ui.replyLong(ctx, `📋 Усі заявки: ${all.length}\n\n` + all.map(a => {
      const u = users.get(a.uid) || {};
      return `${mark[a.status] || '•'} #${a.id} ${applications.label(a, 'uk')} · ${a.source || '—'} · ${u.username ? '@' + u.username : (u.name || a.uid)} · ${new Date(a.createdAt).toLocaleDateString('uk-UA')}`;
    }).join('\n'));
  });
  bot.command('reopen', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = store.getApplication(argsOf(ctx)[0]);
    if (!a) return ctx.reply('Заявку не знайдено.');
    if (a.status !== 'rejected') return ctx.reply(`Заявка #${a.id} не відхилена (${a.status}).`);
    store.deleteApplication(a.id);
    await ctx.reply(`✅ Заявку #${a.id} прибрано — людина може подати її знову.`);
  });

  function inactive(days) {
    const cutoff = Date.now() - days * 86400000;
    return store.listApplications('pending').filter(a => { const u = users.get(a.uid) || {}; const seen = u.lastActiveAt || u.firstSeenAt || 0; return !seen || seen < cutoff; });
  }
  bot.command('inactive', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const days = Math.max(1, parseInt(argsOf(ctx)[0], 10) || 2);
    const hit = inactive(days);
    const refund = hit.reduce((s, a) => s + applications.refundable(a), 0);
    await ctx.reply(`🕓 Заявок від неактивних ${days}+ днів: ${hit.length}\nПовернеться при скасуванні: ${fmtStars(refund)}⭐\n\nСкасувати: /cancel_inactive ${days} так`);
  });
  bot.command('cancel_inactive', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const days = Math.max(1, parseInt(argsOf(ctx)[0], 10) || 2);
    const hit = inactive(days);
    if (!yes(ctx)) return ctx.reply(`⚠️ Скасувати ${hit.length} заявок від неактивних ${days}+ днів? Оплачене повернеться.\nПідтверди: /cancel_inactive ${days} так`);
    let refunded = 0;
    for (const a of hit) { const r = applications.cancel(a.id, `неактивний ${days}+ днів`); refunded += r.refunded || 0; }
    await ctx.reply(`✅ Скасовано: ${hit.length}. Повернуто: ${fmtStars(refunded)}⭐`);
  });
  bot.command('cancel_inactive_yes', async (ctx) => ctx.reply('Тепер так: /cancel_inactive 2 так'));

  bot.command('reset_requests', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const pending = store.listApplications('pending');
    if (!pending.length) return ctx.reply('Черга порожня.');
    const sum = pending.reduce((s, a) => s + applications.refundable(a), 0);
    if (!yes(ctx)) return ctx.reply(`Скинути всі ${pending.length} заявок у черзі? Оплачене (${fmtStars(sum)}⭐) повернеться людям.\nПідтверди: /reset_requests так`);
    let back = 0;
    for (const a of pending) { const r = applications.reject(a.id, 'Скидання черги через технічні роботи'); back += r.refunded || 0; }
    await ctx.reply(`✅ Черга скинута: ${pending.length} заявок, повернуто ${fmtStars(back)}⭐.`);
  });
  bot.command('wipe_requests', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    if (!yes(ctx)) return ctx.reply(`⚠️ Видалити ВСІ ${store.listApplications().length} заявок з бази? Зірки НЕ повертаються.\nПідтверди: /wipe_requests так`);
    await ctx.reply(`🗑 Видалено заявок: ${store.wipeApplications()}.`);
  });
  bot.command('clear_my', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    if (!yes(ctx)) return ctx.reply('Видалити всі ТВОЇ заявки? Підтверди: /clear_my так');
    await ctx.reply(`🗑 Видалено твоїх заявок: ${store.removeApplicationsByUid(String(ctx.from.id))}.`);
  });
}

module.exports = { register, E, esc };
