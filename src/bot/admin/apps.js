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

  // ✂️ Урізати виплату (вивід подарунком): на дешевший подарунок або до нуля, з причиною.
  const CUT_HELP = 'Формат: <code>/cut N bear причина</code> — урізати до 🧸 Мішки\n<code>/cut N 0 причина</code> — скасувати виплату без повернення\nПодарунки: ' + E.WITHDRAW.gifts.join(', ');
  function doCut(id, args) {
    const [to, ...rest] = args;
    const zero = /^(0|нуль|нічого|none)$/i.test(to || '');
    if (!to || (!zero && !E.WITHDRAW.gifts.includes(to))) return { ok: false, error: 'format' };
    const reason = rest.join(' ').trim();
    if (!reason) return { ok: false, error: 'no_reason' };
    return applications.cut(id, zero ? null : to, reason);
  }
  const cutReply = (id, r) => r.ok ? (r.zero ? `✂️ Заявку #${id} урізано до нуля — відхилено без повернення.` : `✂️ Заявку #${id} урізано: ${r.from} → ${r.to}. Тепер підтвердіть її, коли надішлете подарунок.`)
    : r.error === 'format' ? CUT_HELP : r.error === 'no_reason' ? 'Додайте причину — гравець її побачить.' : r.error === 'not_cheaper' ? 'Можна урізати лише до дешевшого подарунка.'
    : r.error === 'not_withdrawal' ? 'Урізати можна лише вивід.' : 'Заявка вже оброблена або не знайдена.';
  bot.action(/^admin_cut_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const a = store.getApplication(ctx.match[1]);
    if (!a || a.status !== 'pending') return ctx.reply('Заявка вже оброблена або не знайдена.').catch(() => {});
    await ask(ctx, 'cut', { id: a.id }, `✂️ Урізати заявку #${a.id} (${applications.label(a, 'uk')}).\nНапишіть: подарунок і причину, напр. «bear зловживання рефералами», або «0 мультиакаунт» — скасувати без повернення.`);
  });
  hooks.onAdminText.push(async (ctx, text) => {
    const p = takePending(ctx.from.id, 'cut');
    if (!p) return false;
    await ctx.reply(cutReply(p.data.id, doCut(p.data.id, text.trim().split(/\s+/))), { parse_mode: 'HTML' }).catch(() => {});
    return true;
  });
  bot.command('cut', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [id, ...rest] = String(ctx.message.text).split(/\s+/).slice(1);
    if (!/^\d+$/.test(id || '')) return ctx.reply(CUT_HELP, { parse_mode: 'HTML' }).catch(() => {});
    await ctx.reply(cutReply(id, doCut(id, rest)), { parse_mode: 'HTML' }).catch(() => {});
  });

  const ids = (ctx) => String(ctx.message.text).split(/[\s,#]+/).slice(1).map(x => parseInt(x, 10)).filter(n => !isNaN(n));

  // 🎁 Автовиплата: бот сам надсилає подарунок(и) і підтверджує заявку (features/payouts.js).
  const payouts = require('../../features/payouts');
  const giftLine = (list) => list.map(id => E.getTier(id).emoji).join(' ');
  const whoApp = (a) => { const u = users.get(a.uid) || {}; return u.username ? '@' + u.username : (u.name || a.uid); };
  const payLine = (a, r) => `#${a.id} ${applications.label(a, 'uk')} → ${whoApp(a)}: ` + (r.ok
    ? `✅ надіслано ${giftLine(r.sent)}${r.via === 'bot' ? '' : ' (' + (r.via === 'account' ? 'від акаунта' : 'бот + акаунт') + ')'}`
    : r.error === 'manual_only' ? '✋ лише вручну (такий подарунок бот не надсилає)'
    : r.error === 'not_pending' ? '⏭ уже оброблена' : r.error === 'busy' ? '⏳ уже надсилається'
    : `❌ не вдалося${r.partial ? ` (надіслано ${r.partial} з ${r.plan.length})` : ''}: ${r.detail || r.error}${r.lowBalance ? ' — замало зірок на балансі бота' : ''}`);
  bot.action(/^admin_pay_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    const a = store.getApplication(ctx.match[1]);
    if (!a) return ctx.answerCbQuery('Заявку не знайдено').catch(() => {});
    await ctx.answerCbQuery('⏳ Надсилаю…').catch(() => {});
    const r = await payouts.pay(a.id);
    if (r.ok) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(payLine(a, r)).catch(() => {});
  });
  bot.command('pay', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const list = ids(ctx);
    if (!list.length) return ctx.reply('Формат: /pay 142 143 — бот надішле подарунки й підтвердить заявки.\nНайновіші невиплачені: /pay_new 8').catch(() => {});
    const out = [];
    for (const id of list) { const a = store.getApplication(id); out.push(a ? payLine(a, await payouts.pay(id)) : `#${id} — не знайдено`); }
    await ui.replyLong(ctx, '🎁 Автовиплата\n\n' + out.join('\n'));
  });
  bot.command('pay_new', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const n = Math.max(1, Math.min(50, parseInt(argsOf(ctx)[0], 10) || 8));
    const list = payouts.newestPayable(n);
    const manual = store.listApplications('pending').filter(a => !payouts.payable(a)).length;
    if (!list.length) return ctx.reply('Невиплачених заявок, які бот може надіслати сам, немає.' + (manual ? `\nЛише вручну: ${manual}.` : '')).catch(() => {});
    const cost = list.reduce((s, a) => s + payouts.planFor(a).reduce((x, g) => x + E.getTier(g).price, 0), 0);
    const plan = list.map(a => `#${a.id} ${applications.label(a, 'uk')} → ${whoApp(a)} · ${giftLine(payouts.planFor(a))}`).join('\n');
    if (!yes(ctx)) {
      return ui.replyLong(ctx, `🎁 Найновіші невиплачені (${list.length}):\n\n${plan}\n\nРазом ≈ ${cost}⭐ з балансу зірок бота.` +
        (manual ? `\nЩе ${manual} — лише вручну (NFT, Premium, нестандартні суми).` : '') + `\n\nНадіслати й підтвердити: /pay_new ${n} так`);
    }
    await ctx.reply(`⏳ Надсилаю ${list.length} заявок…`).catch(() => {});
    const out = [];
    for (const a of list) { out.push(payLine(a, await payouts.pay(a.id))); await new Promise(r => setTimeout(r, 300)); }
    const okN = out.filter(l => / ✅ /.test(l)).length;
    await ui.replyLong(ctx, `🎁 Автовиплата: ${okN} з ${list.length}\n\n` + out.join('\n'));
  });
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
