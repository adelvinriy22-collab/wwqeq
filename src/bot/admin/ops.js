// Адмін-операції: статистика, гравці, промокоди, техроботи, банк, ліга,
// тестовий режим, роздачі.
const config = require('../../config');
const store = require('../../store');
const users = require('../../core/users');
const progress = require('../../core/progress');
const notify = require('../../core/notify');
const E = require('../../economy');
const time = require('../../lib/time');
const admin = require('../../features/admin');
const bank = require('../../features/bank');
const league = require('../../features/league');
const promo = require('../../features/promo');
const maintenance = require('../../features/maintenance');
const goal = require('../../features/goal');
const reminders = require('../../features/reminders');
const wheels = require('../../features/wheels');
const ui = require('../ui');
const { isAdminCtx, ask, takePending, broadcast, audience, argsOf, yes } = require('./shared');
const { fmtStars, esc, round2 } = require('../../lib/util');

const HELP = `<b>Адмін</b> — найзручніше в застосунку (вкладка «Адмін»).

<b>Заявки</b>: /apps · /requests [pending|approved|rejected] · /approve 1 2 · /reject 1 2 · /reopen N · /inactive 2 · /cancel_inactive 2 так · /reset_requests · /all_requests
<b>Гравці</b>: /user @нік · /adjust @нік 10 [білети] [причина] · /spins @нік 1 [платні] · /punish_user @нік · /top50 · /active_today · /dbstats
<b>Зловживання</b>: /wheel_abuse_check · /wheel_abuse_punish так · /wheel_log 30
<b>Промокоди</b>: /promo КОД 10з 3б 2с 50 (або КОД авто 1 — автовидача) · /promo_list · /promo_del КОД
<b>Техроботи</b>: /maint · /maint withdraw|full|off · /maint 2г · /maint text …
<b>Баланс</b>: /stars @нік 10 · /stars @нік -10 · /tickets @нік 5 · /tickets @нік -5 (у кінці можна дописати причину)
<b>Банк</b>: /bank_start 2026-10-01 21:00 · /bank_cancel · /bank_auto on 21 · /bank_verify
<b>Ліга</b>: /league on|off · /league_stats · /league_hide @нік · /league_unhide @нік · /league_finalize W2026-09-28
<b>Перший коментар</b>: /first_gift — пост у канал «першому коментарю — гіфт за 15⭐», бот сам відповість першому й надішле 🧸/💝 · /first_gift status · /first_gift cancel
<b>Розіграш автовидачі</b>: /awd_giveaway 100 1 [@канал] — пост у каналі з «УЧАСТЬ» + розсилка, участь лише з підпискою на @Sanichkap; на 100 учасниках — переможцям промокод на автовидачу · /awd_giveaway status · cancel
<b>Автовивід</b>: /autowd @нік — бот сам надішле гравцю справжню 🧸 Мішку з його підписом (один раз) · /autowd — список
<b>Розсилки</b>: /broadcast (відповіддю) · <b>/say</b> — пост у чат від імені бота (текст, pin, кнопки, відповіддю — фото/відео) · /post_all · /chat_say · /chat_post · /send_reminders · /winback так · /gift_all 1 мітка так
<b>Події</b>: /event_status · /event_stop … · /giveaway_start · /giveaway_solo_start 21 00 · /joint_giveaway_start · /giveaway_stats · /deleteticket @нік 1 · /password_challenge_start · /external_ref_announce посилання · /unlock_event · /goal_reset · /goal_stats
<b>Завдання</b>: /accept @нік завдання · /task_check · /task_revoke @нік · /partner_stats · /partner_on · /partner_off · /partner_announce так · /top_refs
<b>Чат</b>: /chat_status · /chats · /chat_drop · /chat_boxes · /chat_quiz · /chat_word · /chat_top · /chat_contest 21:30 3 · /chat_contest_status · /chat_contest_end · /chat_pause · /chat_resume · /chat_debug · /jackpot (посилання) — 🧸 Мішка й 🎁 Подарунок видаються одразу подарунком Telegram
<b>Подарунок від мого акаунта (тест)</b>: /tg_login — вхід за QR · /tg_logout · /ugift @нік [bear|heart|rose…] [підпис] — картка-прев'ю, зміна підпису, надсилання від вашого акаунта, гравцю — привітання
<b>Інше</b>: /spin_notify on|off · /autowithdraw 73 · /test · /version · /season`;

function register(bot) {
  bot.command(['help_admin', 'admin'], async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    await ctx.reply(HELP, { parse_mode: 'HTML', ...ui.openApp('uk', 'admin') }).catch(() => {});
  });

  bot.command('dbstats', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const o = admin.overview();
    const f = store.getFeatureFlags() || {};
    await ctx.reply(
      `📊 <b>Зріз</b>\n\nГравців: <b>${o.users}</b> (пройшли старт: ${o.registered})\nНових сьогодні: ${o.newToday}\nАктивні 24 год / 7 днів: ${o.active24} / ${o.active7}\n\n` +
      `На балансах: <b>${fmtStars(o.balances.stars)}⭐</b> · ${o.balances.tickets}🎫\nПоповнено за весь час: ${fmtStars(o.deposited)}⭐\n\n` +
      `Заявок у черзі: <b>${o.pending}</b> (до виплати ${o.pendingPayout}⭐)\n` +
      `Банк: ${o.bank ? o.bank.pot + ' · ' + o.bank.players + ' гравців · ' + time.fmtKyiv(o.bank.drawAt) : 'немає'}\n` +
      `Ліга: ${o.league ? 'увімкнена' : 'вимкнена'} · Техроботи: ${o.maintenance.mode} · Спін-сповіщення: ${o.spinNotify ? 'так' : 'ні'}\n` +
      `Схема бази: v${(store.raw().meta || {}).schema} · Подія: ${f.eventUnlocked ? 'так' : 'ні'}`, { parse_mode: 'HTML' });
  });

  bot.command('top50', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const rows = Object.values(users.all()).filter(Boolean).sort((a, b) => (b.starBalance || 0) - (a.starBalance || 0)).slice(0, 50);
    await ui.replyLong(ctx, '⭐ Топ-50 за балансом:\n\n' + rows.map((u, i) => `${i + 1}. ${u.name || '—'} (${u.username ? '@' + u.username : u.id}) — ${fmtStars(u.starBalance || 0)}⭐ · ${u.tickets || 0}🎫`).join('\n'));
  });
  bot.command('active_today', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const cut = Date.now() - 86400000;
    const rows = Object.values(users.all()).filter(u => u && (u.lastActiveAt || 0) >= cut).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    await ui.replyLong(ctx, `🟢 Активні за 24 год: ${rows.length}\n\n` + rows.map((u, i) => `${i + 1}. ${u.name || '—'} (${u.username ? '@' + u.username : u.id}) — ${Math.round((Date.now() - u.lastActiveAt) / 60000)} хв тому`).join('\n'));
  });

  bot.command('user', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const info = admin.userInfo(argsOf(ctx)[0]);
    if (!info) return ctx.reply('Не знайшов. Формат: /user @нік або /user 123456');
    await ctx.reply(
      `👤 <b>${esc(info.name || '—')}</b> ${info.username ? '@' + info.username : ''} · <code>${info.id}</code>\n` +
      `⭐ ${fmtStars(info.stars)} · 🎫 ${info.tickets} · ${info.level.e} ${esc(info.level.t)} (${info.xp} XP)\n` +
      `Друзів: ${info.friends} · Спінів: ${info.spins} · Поповнень: ${info.deposits} (${fmtStars(info.deposited)}⭐)\n` +
      `Бонусних спінів: ${info.freeSpins} · Подарованих: ${info.gifted}\n` +
      `Останні рухи:\n` + info.tx.slice(0, 10).map(t => `  ${new Date(t.ts).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })} ${t.s ? (t.s > 0 ? '+' : '') + t.s + '⭐' : ''}${t.t ? ' ' + (t.t > 0 ? '+' : '') + t.t + '🎫' : ''} · ${t.r}`).join('\n'),
      { parse_mode: 'HTML' });
  });
  bot.command('adjust', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [q, s, t, ...note] = argsOf(ctx);
    const u = users.findByUsernameOrId(q);
    if (!u || (s == null)) return ctx.reply('Формат: /adjust @нік 10 [білети] [причина]\nВід\'ємні числа — списання.');
    const tickets = /^-?\d+$/.test(t || '') ? parseInt(t, 10) : 0;
    const why = (/^-?\d+$/.test(t || '') ? note : [t].concat(note)).filter(Boolean).join(' ');
    const r = admin.adjust(u.id, parseFloat(s) || 0, tickets, why);
    await ctx.reply(r.ok ? `✅ ${users.displayName(u)}: тепер ${fmtStars(r.stars)}⭐ · ${r.tickets}🎫` : '❌ ' + (r.error || 'помилка'));
  });
  // Нарахувати або забрати зірки / білети: /stars @нік 10 · /stars @нік -10 [причина].
  // Забрати більше, ніж є, не можна — тоді забирається все, що є.
  const balanceCmd = (cur) => async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const cmd = cur === 'stars' ? '/stars' : '/tickets';
    const unit = cur === 'stars' ? '⭐' : '🎫';
    const [q, amt, ...note] = argsOf(ctx);
    const u = users.findByUsernameOrId(q);
    const raw = String(amt || '').replace(',', '.').replace(/^\+/, '');
    const n = cur === 'stars' ? round2(parseFloat(raw)) : parseInt(raw, 10);
    if (!q || !Number.isFinite(n) || !n || !/^-?\d+([.]\d+)?$/.test(raw)) {
      return ctx.reply(`Формат:\n${cmd} @нік 10 — нарахувати\n${cmd} @нік -10 — забрати\n\nМожна дописати причину: ${cmd} @нік -10 помилкове нарахування\nЗамість ніка підійде id.`);
    }
    if (!u) return ctx.reply(`Не знайшов ${q}. Перевір нік або дай id.`);
    const have = cur === 'stars' ? users.stars(u) : users.tickets(u);
    const delta = n < 0 ? -Math.min(-n, have) : n;
    if (!delta) return ctx.reply(`У ${users.displayName(u)} 0${unit} — нема чого забирати.`);
    const why = note.join(' ').slice(0, 120);
    const r = users.move(u.id, { [cur]: delta }, 'admin', { note: why || (delta > 0 ? 'нарахування адміном' : 'списання адміном'), by: String(ctx.from.id) });
    if (!r.ok) return ctx.reply('❌ ' + (r.error || 'помилка'));
    const f = (v) => cur === 'stars' ? fmtStars(v) : String(v);
    const after = cur === 'stars' ? r.stars : r.tickets;
    if (delta > 0) notify.dm(u.id, `🎁 Тобі нараховано <b>+${f(delta)}${unit}</b>` + (why ? '\n' + esc(why) : ''));
    await ctx.reply(`✅ ${delta > 0 ? 'Нараховано' : 'Забрано'} ${users.displayName(u)}: ${delta > 0 ? '+' : '−'}${f(Math.abs(delta))}${unit}\n` +
      `Було ${f(have)}${unit} → стало ${f(after)}${unit}` + (n < 0 && -n > have ? `\n⚠️ Було лише ${f(have)}${unit} — забрано все.` : '') +
      (delta > 0 ? '\nГравцю надіслано повідомлення.' : ''));
  };
  bot.command('stars', balanceCmd('stars'));
  bot.command('tickets', balanceCmd('tickets'));

  bot.command('spins', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [q, free, paid] = argsOf(ctx);
    const u = users.findByUsernameOrId(q);
    if (!u) return ctx.reply('Формат: /spins @нік 1 [платні]');
    admin.giveSpins(u.id, free, paid);
    await ctx.reply(`✅ ${users.displayName(u)}: бонусних ${users.get(u.id).freeSpins || 0}, подарованих платних ${users.get(u.id).paidSpinsGifted || 0}`);
  });

  // Покарання: обнулити баланс і скасувати заявки без повернення.
  bot.command('punish_user', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const u = users.findByUsernameOrId(argsOf(ctx)[0]);
    if (!u) return ctx.reply('Формат: /punish_user @нік');
    const pend = store.listApplications('pending').filter(a => a.uid === u.id).length;
    await ask(ctx, 'punish', { uid: u.id }, `⚠️ Покарати ${users.displayName(u)} (id ${u.id})?\nБаланс ${fmtStars(users.stars(u))}⭐ → 0, заявок у черзі буде скасовано: ${pend} (без повернення).\n\nНапиши «так» для підтвердження.`);
  });

  bot.command('wheel_abuse_check', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const list = abusers();
    if (!list.length) return ctx.reply('Зловживань не знайдено.');
    await ui.replyLong(ctx, `⚠️ Звичайні щоденні спіни частіше, ніж раз на 23 год (бонусні не рахуються):\n\n` +
      list.map(([uid, n]) => { const u = users.get(uid) || {}; return `${u.name || '—'} (${u.username ? '@' + u.username : uid}) — порушень ${n}, баланс ${fmtStars(u.starBalance || 0)}⭐`; }).join('\n') +
      '\n\nОбнулити їм баланс: /wheel_abuse_punish так');
  });
  bot.command('wheel_abuse_punish', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const list = abusers();
    if (!list.length) return ctx.reply('Нікого карати.');
    if (!yes(ctx)) return ctx.reply(`⚠️ Обнулити баланс ${list.length} акаунтам? Підтверди: /wheel_abuse_punish так`);
    for (const [uid] of list) {
      const u = users.get(uid);
      if (u && users.stars(u) > 0) users.move(uid, { stars: -users.stars(u) }, 'punish', { why: 'wheel_abuse' });
      notify.dm(uid, '⚠️ Виявлено зловживання помилкою щоденного колеса. Баланс зірок обнулено.');
    }
    await ctx.reply(`✅ Покарано: ${list.length}.`);
  });
  bot.command('wheel_log', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const n = Math.min(200, parseInt(argsOf(ctx)[0], 10) || 30);
    const log = store.getWheelLog().filter(e => e.kind === 'spin').slice(-n).reverse();
    if (!log.length) return ctx.reply('Журнал порожній.');
    await ui.replyLong(ctx, `🎰 Останні ${log.length} спінів:\n\n` + log.map(e => `${new Date(e.ts).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' })} [${e.wheel}] ${e.extra && e.extra.outcomeId}${e.extra && e.extra.bonus ? ' (бонус)' : ''} · ${e.name || '—'}${e.username ? ' @' + e.username : ''}`).join('\n'));
  });

  // ─── Промокоди ────────────────────────────────────────────────────────
  bot.command(['promo', 'addpromo'], async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx);
    if (a.length < 2) return ctx.reply('Формат: /promo КОД 10з 3б 2с 50\nз — зірки, б — білети, с — бонусні спіни, число без літери — кількість активацій.\nСписок: /promo_list');
    // Старий формат /addpromo КОД 50 [ліміт]
    const r = /^\d+$/.test(a[1]) && ctx.message.text.startsWith('/addpromo')
      ? { stars: parseInt(a[1], 10), tickets: 0, spins: 0, uses: a[2] ? parseInt(a[2], 10) : null }
      : promo.parseRewards(a.slice(1));
    const out = promo.create(a[0], r);
    if (!out.ok) return ctx.reply(out.error === 'exists' ? 'Такий код уже є. /promo_del ' + a[0].toUpperCase() : out.error === 'no_reward' ? 'Не вказано нагороди.' : 'Некоректний код.');
    await ctx.reply(`✅ Промокод <code>${out.code}</code>: ${promo.what({ amount: r.stars, tickets: r.tickets, spins: r.spins })} · активацій: ${r.uses || '∞'}`, { parse_mode: 'HTML' });
  });
  bot.command('promo_list', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const l = promo.list();
    await ui.replyLong(ctx, l.length ? '🎟 Промокоди:\n\n' + l.map(p => `${p.code} — ${p.what} · ${p.used}/${p.limit || '∞'}`).join('\n') : 'Промокодів немає.');
  });
  bot.command(['promo_del', 'delpromo'], async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    await ctx.reply(promo.remove(argsOf(ctx)[0]) ? '✅ Видалено.' : 'Не знайдено.');
  });

  // ─── Техроботи ────────────────────────────────────────────────────────
  bot.command('maint', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx);
    const names = { off: 'вимкнено', withdraw: 'лише вивід', full: 'весь застосунок' };
    const arg = (a[0] || '').toLowerCase();
    if (!arg) {
      const m = maintenance.state();
      return ctx.reply(`🛠 Техроботи: <b>${names[m.mode]}</b>${m.until ? '\nЛишилось: ' + time.humanLeft(m.left) : ''}\nТекст: <i>${esc(m.text)}</i>\n\n/maint withdraw · /maint full · /maint off · /maint 2г · /maint text …`, { parse_mode: 'HTML' });
    }
    if (arg === 'text') {
      const txt = a.slice(1).join(' ').trim();
      if (!txt) return ctx.reply('Формат: /maint text Повернемось за годину');
      maintenance.set({ text: txt });
      return ctx.reply('✅ Текст оновлено.');
    }
    let mode = arg, dur = time.parseDuration(a.slice(1).join(''));
    if (!names[arg]) { dur = time.parseDuration(a.join('')); mode = 'full'; if (!dur) return ctx.reply('Доступно: off, withdraw, full, text або час: /maint 2г'); }
    const m = maintenance.set({ mode, until: mode === 'off' ? 0 : (dur ? Date.now() + dur : 0) });
    await ctx.reply(`🛠 Техроботи: <b>${names[m.mode]}</b>` + (m.until ? `\nЗавершаться за ${time.humanLeft(m.left)}` : ''), { parse_mode: 'HTML' });
  });

  // ─── Банк ─────────────────────────────────────────────────────────────
  bot.command('bank_start', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const ts = time.parseKyiv(argsOf(ctx).join(' '));
    const r = bank.start(ts);
    if (!r.ok) return ctx.reply(r.error === 'already_open' ? 'Уже є відкритий банк. Спершу /bank_cancel.' : 'Формат: /bank_start 2026-10-01 21:00 (Київ, щонайменше за хвилину)');
    await ctx.reply(`🏦 Банк відкрито. Розіграш: ${time.fmtKyiv(r.bank.drawAt)}\n\nВідбиток seed (опублікуй ДО ставок):\n<code>${r.bank.seedHash}</code>`, { parse_mode: 'HTML' });
  });
  bot.command('bank_cancel', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const r = bank.cancel('');
    await ctx.reply(r.ok ? `Скасовано. Повернуто ${fmtStars(r.stars)}⭐ і ${r.tickets}🎫 для ${r.players} гравців.` : 'Активного банку немає.');
  });
  bot.command('bank_auto', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [on, hour] = argsOf(ctx);
    if (!on) { const a = bank.autoCfg(); return ctx.reply(`Автобанк: ${a.enabled ? 'щодня о ' + a.hour + ':00' : 'вимкнено'}\n/bank_auto on 21 · /bank_auto off`); }
    const a = bank.setAuto({ enabled: on === 'on', hour: Math.max(0, Math.min(23, parseInt(hour, 10) || 21)), minute: 0, everyDays: 1 });
    await ctx.reply(a.enabled ? `✅ Автобанк: щодня о ${a.hour}:00 (Київ). Після розіграшу одразу відкривається наступний.` : 'Автобанк вимкнено.');
  });
  bot.command('bank_verify', async (ctx) => {
    const b = bank.get();
    if (!b || b.status !== 'drawn') return ctx.reply('Розіграш ще не проводився.');
    const v = bank.core.verify(b);
    await ctx.reply(`🔍 <b>Перевірка банку</b>\n\nSeed:\n<code>${v.seed}</code>\nSHA-256 (показували до ставок):\n<code>${v.seedHash}</code> — ${v.seedOk ? 'збігається ✅' : 'НЕ збігається'}\n\nСтавки:\n<code>${esc(v.betLine.slice(0, 300))}</code>\nHMAC: <code>${v.hmac.slice(0, 32)}…</code>`, { parse_mode: 'HTML' });
  });

  // ─── Ліга ─────────────────────────────────────────────────────────────
  bot.command('league', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = (argsOf(ctx)[0] || '').toLowerCase();
    if (a === 'on' || a === 'off') league.setEnabled(a === 'on');
    await ctx.reply(`🏆 Ліга тижня: ${league.enabled() ? 'УВІМКНЕНА' : 'вимкнена'}\n\nПризи щопонеділка: ${E.LEAGUE.rewards.map(q => q.from + (q.to !== q.from ? '–' + q.to : '') + ': ' + league.rewardText(q.items, 'uk')).join('; ')}\n\n/league on · /league off`);
  });
  bot.command(['league_on', 'league_resume'], async (ctx) => { if (!isAdminCtx(ctx)) return; league.setEnabled(true); await ctx.reply('▶️ Ліга увімкнена.'); });
  bot.command(['league_off', 'league_pause'], async (ctx) => { if (!isAdminCtx(ctx)) return; league.setEnabled(false); await ctx.reply('⏸ Ліга вимкнена.'); });
  bot.command('league_stats', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const rows = league.standings();
    await ui.replyLong(ctx, `🏆 Ліга ${time.weekKey(Date.now())} · гравців ${rows.length} · ${league.enabled() ? 'увімкнена' : 'вимкнена'}\n\n` +
      rows.slice(0, 20).map(r => `#${r.rank} ${users.displayName(r.u)} — ${r.xp} XP`).join('\n'));
  });
  bot.command('league_hide', async (ctx) => { if (!isAdminCtx(ctx)) return; const u = users.findByUsernameOrId(argsOf(ctx)[0]); if (!u) return ctx.reply('Не знайшов.'); league.hide(u.id, true); await ctx.reply('🙈 Прибрано з ліги.'); });
  bot.command('league_unhide', async (ctx) => { if (!isAdminCtx(ctx)) return; const u = users.findByUsernameOrId(argsOf(ctx)[0]); if (!u) return ctx.reply('Не знайшов.'); league.hide(u.id, false); await ctx.reply('✅ Повернуто в лігу.'); });
  bot.command('league_finalize', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const wk = argsOf(ctx)[0];
    if (!wk) return ctx.reply('Формат: /league_finalize W2026-09-28');
    const r = await league.finalize(wk);
    await ctx.reply(r.ok ? `✅ Закрито: учасників ${r.players}, призерів ${r.winners}` : '⚠️ ' + r.error);
  });

  bot.command('spin_notify', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = (argsOf(ctx)[0] || '').toLowerCase();
    if (a === 'on' || a === 'off') admin.setSpinNotify(a === 'on');
    await ctx.reply('🎰 Сповіщення про кожен спін: ' + (!(store.getFeatureFlags() || {}).spinNotifyOff ? 'увімкнено' : 'вимкнено') + '\n/spin_notify on · /spin_notify off');
  });

  bot.command('season', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const sid = progress.seasonId(Date.now());
    let active = 0, premium = 0;
    for (const u of Object.values(users.all())) { if (progress.seasonXp(u) > 0) active++; if (u && u.pass && u.pass.season === sid && u.pass.premium) premium++; }
    await ctx.reply(`🎟 Сезон ${sid}\nЗакінчується: ${time.fmtKyiv(progress.seasonEndsAt(Date.now()))}\nКачають: ${active} · купили платну лінію: ${premium}`);
  });

  bot.command('goal_reset', async (ctx) => { if (!isAdminCtx(ctx)) return; goal.reset(); await ctx.reply(`🎯 Нова спільна ціль: ${E.GOAL.target} спінів.`); });
  bot.command('goal_stats', async (ctx) => { if (!isAdminCtx(ctx)) return; const g = goal.get(); await ctx.reply(`🎯 ${g.count}/${E.GOAL.target} · учасників ${g.participants.length} · ${g.done ? 'досягнуто' : 'триває'}`); });

  bot.command('send_reminders', async (ctx) => { if (!isAdminCtx(ctx)) return; const n = await reminders.run(); await ctx.reply('🔔 Надіслано нагадувань: ' + n); });

  bot.command('autowithdraw', async (ctx, next) => {
    if (!isAdminCtx(ctx) || !argsOf(ctx).length) return next();
    const m = ctx.message.text.replace(/^\/autowithdraw(@\w+)?\s*/, '').match(/^(\d{1,3})\s*%?\s*([\s\S]*)$/);
    if (!m) return ctx.reply('Формат: /autowithdraw 73 [підпис]');
    const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    const note = (m[2] || '').trim() === '-' ? null : ((m[2] || '').trim() || null);
    store.setFeatureFlags({ autowd: { pct, note, at: Date.now() } });
    await ctx.reply(`✅ Готовність автовиводу: ${pct}%` + (note ? '\n' + note : ''));
  });

  bot.command('version', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const up = Math.round(process.uptime() / 60);
    await ctx.reply(`📦 StarForge v3 · застосунок ${notify.tg.build || '—'}\n⏱ Працює: ${up < 60 ? up + ' хв' : Math.floor(up / 60) + ' год ' + (up % 60) + ' хв'}\n💬 Чат: ${notify.tg.chat && notify.tg.chat.chatId ? 'підключено' : 'не підключено'}\n🗄 Схема бази: v${(store.raw().meta || {}).schema}`);
  });

  // ─── Роздачі ──────────────────────────────────────────────────────────
  bot.command('winback', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const DAYS = 2, STARS = 3;
    const cut = Date.now() - DAYS * 86400000;
    const t = audience(u => !u.lastActiveAt || u.lastActiveAt < cut);
    if (!yes(ctx)) return ctx.reply(`Повернення сплячих (${DAYS}+ днів): ${t.length}\nКожному: бонусний спін + ${STARS}⭐\nЗапустити: /winback так`);
    await broadcast(ctx, t, async (uid, u) => {
      users.patch(uid, { freeSpins: (u.freeSpins || 0) + 1 });
      users.move(uid, { stars: STARS }, 'winback', {});
      await notify.tg.telegram.sendMessage(uid, `🎁 <b>Давно не бачились!</b>\n\nДаруємо бонусний спін і <b>+${STARS}⭐</b> на баланс.`, { parse_mode: 'HTML', ...ui.openApp(u.lang || 'uk', 'wheel') });
    }, 'Повернення сплячих');
  });
  bot.command('gift_all', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx);
    const amount = parseFloat(a[0]) || 1, tag = (a[1] || 'gift1').toLowerCase();
    const t = audience(u => !((u.giftsGot || {})[tag]));
    if (!yes(ctx)) return ctx.reply(`Роздача ${amount}⭐ з міткою «${tag}»: ${t.length} людей, разом ${round2(t.length * amount)}⭐\nЗапустити: /gift_all ${amount} ${tag} так`);
    await broadcast(ctx, t, async (uid, u) => {
      users.patch(uid, { giftsGot: { ...(u.giftsGot || {}), [tag]: Date.now() } });
      users.move(uid, { stars: amount }, 'gift_all', { tag });
      await notify.tg.telegram.sendMessage(uid, `🎁 <b>Тримай ${amount}⭐ просто так</b> — дякуємо, що ти з нами!`, { parse_mode: 'HTML', ...ui.openApp(u.lang || 'uk') });
    }, 'Роздача');
  });

  // ─── Тестовий режим (лише для власного акаунта адміна) ────────────────
  bot.command('test', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const uid = String(ctx.from.id);
    const [cmd, arg, arg2] = argsOf(ctx).map(s => s.toLowerCase());
    const f = store.getFeatureFlags() || {};
    const snap = f.testSnapshot;
    const help = '🧪 <b>Тестовий режим</b>\n/test on — знімок твоїх даних\n/test off — відновити\n/test balance 100 · /test tickets 50 · /test spins 5 · /test paid 3 · /test refs 5 · /test xp 500 · /test cooldown\n/test bank 5 — тестовий банк · /test draw';
    if (!cmd) return ctx.reply(help, { parse_mode: 'HTML' });
    const u = users.get(uid) || users.ensure(ctx.from);
    if (cmd === 'on') {
      if (snap && snap.active) return ctx.reply('Уже увімкнено. /test off');
      store.setFeatureFlags({ testSnapshot: { active: true, uid, at: Date.now(), data: JSON.parse(JSON.stringify(u)) } });
      return ctx.reply('🧪 Увімкнено. Ламай що завгодно — /test off поверне все.');
    }
    if (cmd === 'off') {
      if (!snap || !snap.active) return ctx.reply('Режим не був увімкнений.');
      store.raw().users[snap.uid] = snap.data;
      store.setFeatureFlags({ testSnapshot: null });
      return ctx.reply('↩️ Відновлено зі знімка.');
    }
    if (!snap || !snap.active) return ctx.reply('Спершу /test on.');
    const n = parseFloat(arg) || 0;
    if (cmd === 'balance') users.patch(uid, { starBalance: Math.max(0, n) });
    else if (cmd === 'tickets') users.patch(uid, { tickets: Math.max(0, Math.floor(n)) });
    else if (cmd === 'spins') users.patch(uid, { freeSpins: Math.max(0, Math.floor(n)) });
    else if (cmd === 'paid') users.patch(uid, { paidSpinsGifted: Math.max(0, Math.floor(n)) });
    else if (cmd === 'refs') users.patch(uid, { invitedIds: Array.from({ length: Math.floor(n) }, (_, i) => 'test_ref_' + i) });
    else if (cmd === 'xp') progress.addXp(uid, 'admin', n, { silent: true });
    else if (cmd === 'cooldown') users.patch(uid, { lastDailySpinAt: null });
    else if (cmd === 'bank') {
      const cur = bank.get();
      if (cur && cur.status === 'open' && !cur.isTest) return ctx.reply('Є реальний банк — спершу /bank_cancel.');
      const b = bank.core.create(Date.now() + 3600000);
      for (let i = 1; i <= Math.max(1, Math.min(20, Math.floor(n) || 5)); i++) bank.core.addBet(b, 'test_' + i, 10 * i, 0);
      b.isTest = true; bank.save(b);
      return ctx.reply(`🏦 Тестовий банк: ${bank.core.totalPot(b)}, гравців ${b.order.length}. Постав у застосунку й /test draw`);
    } else if (cmd === 'draw') {
      const b = bank.get();
      if (!b || b.status !== 'open') return ctx.reply('Відкритого банку немає.');
      b.drawAt = Date.now() - 1000; bank.save(b);
      await bank.tick();
      return ctx.reply('Розіграно. /bank_verify');
    } else return ctx.reply(help, { parse_mode: 'HTML' });
    const v = users.get(uid);
    await ctx.reply(`🧪 ⭐ ${fmtStars(users.stars(v))} · 🎫 ${users.tickets(v)} · бонусних ${v.freeSpins || 0} · подарованих ${v.paidSpinsGifted || 0} · друзів ${(v.invitedIds || []).length}` + (arg2 ? '' : ''));
  });
}

// Два ЗВИЧАЙНІ щоденні спіни ближче ніж за 23 год — зловживання.
function abusers() {
  const by = {};
  for (const ev of store.getWheelLog()) {
    if (ev.kind !== 'spin' || ev.wheel !== 'daily' || (ev.extra && ev.extra.bonus)) continue;
    (by[ev.uid] = by[ev.uid] || []).push(ev.ts || 0);
  }
  const out = [];
  for (const [uid, list] of Object.entries(by)) {
    list.sort((a, b) => a - b);
    let bad = 0;
    for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] < 23 * 3600000) bad++;
    if (bad) out.push([uid, bad]);
  }
  return out;
}

// Відповідь «так» на /punish_user.
function registerTextHooks(hooks) {
  hooks.onAdminText.push(async (ctx, text) => {
    const p = takePending(ctx.from.id, 'punish');
    if (!p) return false;
    if (text.trim().toLowerCase() !== 'так') { await ctx.reply('Скасовано.'); return true; }
    const u = users.get(p.data.uid);
    if (!u) { await ctx.reply('Гравця вже немає.'); return true; }
    const was = users.stars(u);
    if (was > 0) users.move(u.id, { stars: -was }, 'punish', {});
    const applications = require('../../features/applications');
    const pend = store.listApplications('pending').filter(a => a.uid === u.id);
    for (const a of pend) applications.reject(a.id, 'Зловживання — заявку скасовано адміністрацією.', { noRefund: true, silent: true });
    notify.dm(u.id, `⚠️ <b>Виявлено зловживання</b>\n\nБаланс обнулено (було ${fmtStars(was)}⭐), заявки в черзі скасовано (${pend.length}).\nНаступне порушення — блокування назавжди.`);
    await ctx.reply(`✅ Покарано ${users.displayName(u)}: ${fmtStars(was)}⭐ → 0, скасовано заявок ${pend.length}.`);
    return true;
  });
}

module.exports = { register, registerTextHooks, abusers, wheels, config };
