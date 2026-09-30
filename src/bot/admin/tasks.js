// ==========================================================================
// ПАРТНЕРСЬКІ ЗАВДАННЯ Й СЕКРЕТНЕ ЗАВДАННЯ: перевірка скрінів, ручне
// зарахування, статистика, розсилка. Плюс зведені списки гравців.
// ==========================================================================
const store = require('../../store');
const users = require('../../core/users');
const notify = require('../../core/notify');
const quests = require('../../features/quests');
const referrals = require('../../features/referrals');
const ui = require('../ui');
const { isAdminCtx, broadcast, audience, argsOf, yes } = require('./shared');
const { fmtStars, esc } = require('../../lib/util');

function register(bot) {
  // Скрін завдання з застосунку → кнопки під ним.
  bot.action(/^tproof_ok_(\w+?)_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const [, taskId, uid] = ctx.match;
    const r = quests.taskAccept(uid, taskId);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(r.ok ? `✅ Зараховано ${users.displayName(users.get(uid))}` + (r.apps.length ? ` · заявки #${r.apps.join(', #')}` : '') : (r.error === 'already' ? 'Вже зараховано.' : 'Не знайдено.'));
  });
  bot.action(/^tproof_no_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    notify.dm(ctx.match[1], '❌ Скрін не зараховано. Перевір, що видно перехід за посиланням, і надішли ще раз.');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply('Відхилено.');
  });

  bot.command('accept', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [who, task] = argsOf(ctx);
    const ids = Object.keys(quests.TASKS);
    if (!who || !task) return ctx.reply('Формат: /accept @username завдання\nДоступні: ' + ids.join(', '));
    if (!quests.TASKS[task.toLowerCase()]) return ctx.reply('Невідоме завдання. Доступні: ' + ids.join(', '));
    const u = users.findByUsernameOrId(who);
    if (!u) return ctx.reply(`Не знайшов ${who}. Перевір юзернейм або дай id.`);
    const r = quests.taskAccept(u.id, task.toLowerCase());
    await ctx.reply(r.ok ? `✅ ${users.displayName(u)} — ${quests.TASKS[task.toLowerCase()].label}` + (r.apps.length ? `\n🧸 Заявки: #${r.apps.join(', #')}` : '') : `${users.displayName(u)} вже отримував це завдання.`);
  });
  bot.command('task_check', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const rows = Object.entries(users.all()).filter(([, u]) => u && u.taskDone && Object.keys(u.taskDone).length)
      .map(([id, u]) => `${users.displayName(u)} · id ${id} · ${Object.keys(u.taskDone).join(', ')}`);
    if (!rows.length) return ctx.reply('Ще ніхто не виконував завдань.');
    await ui.replyLong(ctx, `Виконали завдання: ${rows.length}\n\n` + rows.join('\n') + '\n\nХто обманув — /task_revoke <id>');
  });
  bot.command('task_revoke', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const u = users.findByUsernameOrId(argsOf(ctx)[0]);
    if (!u) return ctx.reply('Формат: /task_revoke <id або @нік>');
    const done = { ...(u.taskDone || {}) };
    let back = 0;
    for (const [id, t] of Object.entries(quests.TASKS)) if (done[id]) { back += t.reward || 0; delete done[id]; }
    users.patch(u.id, { taskDone: done });
    const take = Math.min(back, users.stars(u));
    if (take > 0) users.move(u.id, { stars: -take }, 'task_revoke', {});
    notify.dm(u.id, `⚠️ Нагороду за завдання скасовано (−${fmtStars(take)}⭐).\nПеревірка показала, що умови не виконані. Виконай і забери знову.`);
    await ctx.reply(`Знято ${fmtStars(take)}⭐ у ${users.displayName(u)}. Баланс: ${fmtStars(users.stars(users.get(u.id)))}⭐`);
  });

  // ─── Секретне завдання партнера ───────────────────────────────────────
  bot.action(/^pk_(ok|no)_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const ok = ctx.match[1] === 'ok';
    const uid = ctx.match[2];
    const r = quests.partnerDecide(uid, ok);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    if (!r.ok) return ctx.reply(r.error === 'already' ? 'Вже нараховано раніше.' : 'Не знайдено.');
    if (!ok) return ctx.reply('Відхилено.');
    const u = users.get(uid);
    const P = quests.PARTNER;
    notify.announce(`🔓 <b>${esc(users.displayName(u))}</b> розгадав секретне завдання: <b>+${P.stars * r.mult}⭐ +${P.tickets * r.mult}🎫 +${P.xp * r.mult} XP</b>` + (r.mult > 1 ? ' (×2 для перших!)' : ''));
    await ctx.reply(`✅ ${users.displayName(u)}: +${P.stars * r.mult}⭐ +${P.tickets * r.mult}🎫 +${P.xp * r.mult} XP` + (r.mult > 1 ? ' (×2)' : '') + `\nВиконань: ${r.count}`);
  });
  bot.command('partner_stats', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    let pend = 0, done = 0, rej = 0;
    for (const u of Object.values(users.all())) {
      if (!u) continue;
      if (u.partnerStatus === 'pending') pend++; else if (u.partnerStatus === 'done') done++; else if (u.partnerStatus === 'rejected') rej++;
    }
    const f = quests.partnerFlags();
    await ctx.reply(`🔐 ${quests.PARTNER.name}\n\nЗараховано: ${done}\nНа перевірці: ${pend}\nВідхилено: ${rej}\n\n×2 лишилось: ${Math.max(0, quests.PARTNER.earlyCount - (f.approved || 0))}\nЗараз: ${f.enabled === true ? '👁 видно' : '🙈 сховано'}\n\n/partner_off · /partner_on · /partner_announce`);
  });
  bot.command('partner_off', async (ctx) => { if (!isAdminCtx(ctx)) return; store.setFeatureFlags({ partner: { ...quests.partnerFlags(), enabled: false } }); await ctx.reply('Секретне завдання сховано.'); });
  bot.command('partner_on', async (ctx) => { if (!isAdminCtx(ctx)) return; store.setFeatureFlags({ partner: { ...quests.partnerFlags(), enabled: true } }); await ctx.reply('Секретне завдання знову видно.'); });
  bot.command('partner_announce', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    if (quests.partnerFlags().enabled !== true) return ctx.reply('Секретне завдання зараз сховане — розсилати нема про що. Спершу /partner_on.');
    const targets = audience(u => !u.partnerStatus);
    if (!yes(ctx)) return ctx.reply(`Розсилка про секретне завдання\nОтримають: ${targets.length}\n\nЗапустити: /partner_announce так`);
    const P = quests.PARTNER;
    await broadcast(ctx, targets, (uid, u) => notify.tg.telegram.sendMessage(uid,
      `🔐 <b>У застосунку відкрилось СЕКРЕТНЕ ЗАВДАННЯ</b>\n\nКілька хвилин — і забираєш:\n⭐ <b>+${P.stars} зірок</b>\n🎫 <b>+${P.tickets} білетів</b>\n✨ <b>+${P.xp} XP</b>\n\n🔥 <b>Перші ${P.earlyCount} отримують усе ×2</b>`,
      { parse_mode: 'HTML', ...ui.openApp(u.lang || 'uk', 'quests') }), 'Секретне завдання');
  });

  // ─── Зведення по гравцях ──────────────────────────────────────────────
  bot.command('top50', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const rows = Object.values(users.all()).filter(Boolean).sort((a, b) => users.stars(b) - users.stars(a)).slice(0, 50);
    if (!rows.length) return ctx.reply('Гравців ще немає.');
    await ui.replyLong(ctx, '⭐ Топ-50 за балансом:\n\n' + rows.map((u, i) => `${i + 1}. ${u.name || '—'} (${u.username ? '@' + u.username : u.id}) — ${fmtStars(users.stars(u))}⭐ · ${users.tickets(u)}🎫`).join('\n'));
  });
  bot.command('top_refs', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const rows = Object.values(users.all()).filter(u => u && (u.invitedIds || []).length).sort((a, b) => b.invitedIds.length - a.invitedIds.length).slice(0, 30);
    if (!rows.length) return ctx.reply('Ще ніхто нікого не запросив.');
    await ui.replyLong(ctx, '👥 Топ за друзями:\n\n' + rows.map((u, i) => `${i + 1}. ${users.displayName(u)} — ${u.invitedIds.length}`).join('\n') + `\n\nПосилання виду: ${referrals.link('ID') || '—'}`);
  });
}

module.exports = { register };
