// ==========================================================================
// КАМПАНІЇ, які запускає адмін: розіграші за квитками, спільний розіграш із
// партнером, пароль-челендж у каналі, «шанс на мішку» (зовнішній бот),
// подія-лідерборд за нових друзів. Перенесено з попередньої версії.
// ==========================================================================
const crypto = require('crypto');
const config = require('../../config');
const store = require('../../store');
const users = require('../../core/users');
const notify = require('../../core/notify');
const subscription = require('../../core/subscription');
const E = require('../../economy');
const time = require('../../lib/time');
const applications = require('../../features/applications');
const referrals = require('../../features/referrals');
const ui = require('../ui');
const { E: em } = require('../../emoji');
const { isAdminCtx, ask, takePending, broadcast, audience, argsOf } = require('./shared');
const { esc, sleep } = require('../../lib/util');

const PASSWORD_PAYLOAD = 'freemishka';
const guessAt = new Map();
const gaTimers = {};
let eventTimer = null;

// ─── Квитки розіграшів ──────────────────────────────────────────────────
function ticketsIn(p) { return p && p.tickets !== undefined ? p.tickets : 1; }
function adjustGiveawayTickets(uid, delta) {
  let changed = false;
  for (const [gid, g] of Object.entries(store.listGiveaways() || {})) {
    if (!g || !g.active || Date.now() >= g.endsAt) continue;
    const p = g.participants && g.participants[uid];
    if (p) { p.tickets = Math.max(0, ticketsIn(p) + delta); store.setGiveaway(gid, g); changed = true; }
  }
  return changed;
}

function scheduleGiveaway(gid) {
  clearTimeout(gaTimers[gid]);
  const g = store.getGiveaway(gid);
  if (!g || !g.active) return;
  gaTimers[gid] = setTimeout(() => finishGiveaway(gid).catch(e => console.error('giveaway:', e.message)), Math.max(1000, g.endsAt - Date.now()));
}
function scheduleAll() {
  for (const gid of Object.keys(store.listGiveaways() || {})) scheduleGiveaway(gid);
  scheduleEvent();
}

async function finishGiveaway(gid) {
  const g = store.getGiveaway(gid);
  if (!g || !g.active) return;
  const t = E.getTier(g.tierId);
  const parts = g.participants || {};
  let pool = Object.keys(parts);
  g.active = false; g.finishedAt = Date.now();
  if (!pool.length) { store.setGiveaway(gid, g); return notify.admin(`${t.emoji} Розіграш «${t.name.uk}» завершено — учасників не було.`); }
  const withNick = pool.filter(id => (users.get(id) || {}).username);
  if (withNick.length) pool = withNick;
  const winners = [];
  let rest = pool.slice();
  for (let i = 0; i < (g.winnersCount || 1) && rest.length; i++) {
    const total = rest.reduce((s, id) => s + ticketsIn(parts[id]), 0);
    let r = crypto.randomInt(1000000) / 1000000 * total, pick = rest[0];
    for (const id of rest) { r -= ticketsIn(parts[id]); if (r <= 0) { pick = id; break; } }
    winners.push(pick);
    rest = rest.filter(id => id !== pick);
  }
  g.winnerIds = winners; g.winnerId = winners[0] || null;
  store.setGiveaway(gid, g);
  for (const w of winners) {
    const a = applications.create(w, g.tierId, 'giveaway');
    notify.dm(w, `🎉 <b>Ти виграв у розіграші!</b>\n${t.emoji} ${esc(E.tierName(g.tierId, (users.get(w) || {}).lang))} — заявка #${a.id}, видамо найближчим часом.`);
  }
  for (const id of pool) {
    if (winners.includes(id)) continue;
    await notify.dm(id, `${t.emoji} Розіграш «${esc(E.tierName(g.tierId, (users.get(id) || {}).lang))}» завершено. Цього разу не пощастило — наступний уже скоро!`);
    await sleep(60);
  }
}

function giveawayCard(g, gid, uid) {
  const t = E.getTier(g.tierId);
  const p = (g.participants || {})[uid];
  const link = referrals.link(uid);
  return {
    text: `${t.emoji} <b>РОЗІГРАШ: ${g.winnersCount > 1 ? g.winnersCount + '× ' : ''}${esc(t.name.uk)}</b>\n\n` +
      (p ? `✅ Ти береш участь. Квитків: <b>${ticketsIn(p)}</b>\n` : '') +
      `⏰ Дедлайн: ${time.fmtKyiv(g.endsAt, { hour: '2-digit', minute: '2-digit' })} (Київ)\n\n` +
      `Кожен НОВИЙ друг після участі — <b>+1 квиток</b>. Скрін реакції чи репосту — ще +1 (перевіряє адмін).` +
      (link ? `\n\nТвоє посилання:\n<code>${link}</code>` : ''),
    extra: ui.kb([
      [p ? null : ui.cb('🎟 Взяти участь', 'ga_join_' + gid, 'danger')],
      [ui.cb('📸 Доказ реакції', 'ga_proof_' + gid, 'primary'), ui.cb('📸 Доказ репосту', 'ga_proof_repost_' + gid, 'primary')],
    ]),
  };
}

// ─── Подія (лідерборд за нових друзів) ──────────────────────────────────
function scheduleEvent() {
  clearTimeout(eventTimer);
  const ev = store.getEvent();
  if (!ev || !ev.active) return;
  eventTimer = setTimeout(() => finishEvent().catch(e => console.error('event:', e.message)), Math.max(1000, ev.endsAt - Date.now()));
}
async function finishEvent() {
  const ev = store.getEvent();
  if (!ev || !ev.active) return;
  ev.active = false; store.setEvent(ev);
  const ranked = Object.values(users.all()).filter(u => u && (u.eventReferrals || 0) > 0).sort((a, b) => b.eventReferrals - a.eventReferrals);
  const PRIZES = { 1: [{ id: 'rocket', qty: 1 }], 2: [{ id: 'gift', qty: 1 }], 3: [{ id: 'bear', qty: 1 }] };
  const lines = [];
  ranked.forEach((u, i) => {
    const place = i + 1;
    const prizes = PRIZES[place] || [];
    if (!prizes.length) return;
    for (const p of prizes) for (let k = 0; k < p.qty; k++) applications.create(u.id, p.id, 'event');
    lines.push(`${place}. ${users.displayName(u)} — ${u.eventReferrals} друзів`);
    notify.dm(u.id, `🏆 <b>Подія завершена! Твоє місце: ${place}</b>\nЗаявку на приз передано адміну.`);
  });
  notify.admin('🏁 Подія завершена.\n\n' + (lines.join('\n') || 'Учасників не було.'));
}

function register(bot, hooks) {
  // Тег бота в імені: +2 квитки в активних розіграшах (автоматично).
  bot.use(async (ctx, next) => {
    if (ctx.from && notify.tg.botUsername && ctx.chat && ctx.chat.type === 'private') {
      const u = users.get(ctx.from.id);
      if (u) {
        const full = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.toLowerCase();
        const has = full.includes(notify.tg.botUsername.toLowerCase());
        if (has !== !!u.hasNameTag) {
          users.patch(u.id, { hasNameTag: has });
          if (adjustGiveawayTickets(u.id, has ? 2 : -2)) {
            notify.dm(u.id, has ? `✅ Бачу @${notify.tg.botUsername} у твоєму імені — +2 квитки в розіграшах!` : `⚠️ Тег @${notify.tg.botUsername} прибрано з імені — −2 квитки.`);
          }
        }
      }
    }
    return next();
  });

  // Новий друг: +1 квиток у розіграшах, +1 у лідерборді події.
  referrals.hooks.onReferral.push((inviterId) => {
    adjustGiveawayTickets(inviterId, 1);
    const ev = store.getEvent();
    if (ev && ev.active && Date.now() < ev.endsAt) users.patch(inviterId, { eventReferrals: ((users.get(inviterId) || {}).eventReferrals || 0) + 1 });
  });

  // ─── Розіграші ────────────────────────────────────────────────────────
  async function startGiveaway(ctx, gid, def, hour, minute, announceToChannel) {
    const endsAt = time.todayAt(hour, minute);
    if (!endsAt || endsAt <= Date.now()) return ctx.reply('⚠️ Цей час сьогодні вже минув.');
    store.setGiveaway(gid, { ...def, active: true, participants: {}, startedAt: Date.now(), endsAt, winnerId: null });
    scheduleGiveaway(gid);
    const g = store.getGiveaway(gid);
    if (announceToChannel) {
      const t = E.getTier(g.tierId);
      await notify.tg.telegram.sendMessage(config.CHANNEL_USERNAME,
        `📣 <b>РОЗІГРАШ: ${g.winnersCount > 1 ? g.winnersCount + '× ' : ''}${t.emoji} ${esc(t.name.uk)}!</b>\n\nТисни «Участь» — і кожен новий друг дає +1 квиток.\n⏰ Дедлайн: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (Київ)`,
        { parse_mode: 'HTML', ...ui.kb([[ui.url('🎟 Участь', `https://t.me/${notify.tg.botUsername}?start=ga_${gid}`, 'danger')]]) })
        .then(() => ctx.reply('✅ Пост у каналі.')).catch(e => ctx.reply('⚠️ Канал: ' + e.message));
    }
    await broadcast(ctx, audience(), async (uid) => { const c = giveawayCard(g, gid, uid); await notify.tg.telegram.sendMessage(uid, c.text, { parse_mode: 'HTML', ...c.extra }); }, 'Анонс розіграшу');
  }
  bot.command('giveaway_start', async (ctx) => { if (!isAdminCtx(ctx)) return; const [h, m] = argsOf(ctx); await startGiveaway(ctx, 'ga_gift', { tierId: 'gift', winnersCount: 1 }, parseInt(h, 10) || 17, parseInt(m, 10) || 45, false); });
  bot.command('giveaway_solo_start', async (ctx) => { if (!isAdminCtx(ctx)) return; const [h, m] = argsOf(ctx); await startGiveaway(ctx, 'ga_solo_bear', { tierId: 'bear', winnersCount: 3 }, parseInt(h, 10) || 21, parseInt(m, 10) || 0, true); });
  bot.command('joint_giveaway_start', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    if (!config.PARTNER_CHANNEL_USERNAME) return ctx.reply('⚠️ Задай PARTNER_CHANNEL_USERNAME у змінних оточення.');
    const [h, m] = argsOf(ctx);
    await startGiveaway(ctx, 'ga_joint_bear', { tierId: 'bear', winnersCount: 4, requireChannels: [config.CHANNEL_USERNAME, config.PARTNER_CHANNEL_USERNAME] }, parseInt(h, 10) || 20, parseInt(m, 10) || 0, false);
  });
  bot.command('giveaway_stats', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const all = store.listGiveaways() || {};
    const ids = argsOf(ctx)[0] ? [argsOf(ctx)[0]] : Object.keys(all);
    if (!ids.length) return ctx.reply('Розіграшів ще не було.');
    await ui.replyLong(ctx, ids.filter(id => all[id]).map(id => {
      const g = all[id], parts = Object.entries(g.participants || {});
      return `${E.getTier(g.tierId).emoji} ${id} — ${g.active ? '🟢 активний' : '⏹ завершено'} · учасників ${parts.length}\n` +
        parts.map(([uid, p], i) => { const u = users.get(uid) || {}; return `  ${i + 1}. ${u.name || '—'} ${u.username ? '@' + u.username : '⚠️ без ніку'} · 🎫${ticketsIn(p)}${(g.winnerIds || []).includes(uid) ? ' 🏆' : ''}`; }).join('\n');
    }).join('\n\n'));
  });
  bot.command('deleteticket', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const a = argsOf(ctx);
    const [gidArg, who, nArg] = a.length === 3 ? a : [null, a[0], a[1]];
    const n = parseInt(nArg, 10);
    const u = users.findByUsernameOrId(who);
    if (!u || !(n > 0)) return ctx.reply('Формат: /deleteticket [ID] @нік кількість');
    const active = Object.keys(store.listGiveaways() || {}).filter(id => store.getGiveaway(id).active);
    const gid = gidArg || (active.length === 1 ? active[0] : null);
    const g = gid && store.getGiveaway(gid);
    if (!g || !(g.participants || {})[u.id]) return ctx.reply('Не знайшов участі. Активні: ' + active.join(', '));
    const before = ticketsIn(g.participants[u.id]);
    g.participants[u.id].tickets = Math.max(0, before - n);
    store.setGiveaway(gid, g);
    await ctx.reply(`✅ ${users.displayName(u)}: ${before} → ${g.participants[u.id].tickets} квитків.`);
  });

  bot.action(/^ga_join_(ga_[a-z0-9_]+)$/, async (ctx) => {
    const uid = String(ctx.from.id);
    const gid = ctx.match[1];
    const g = store.getGiveaway(gid);
    if (!g || !g.active || Date.now() >= g.endsAt) return ctx.answerCbQuery('Розіграш уже завершено', { show_alert: true }).catch(() => {});
    users.ensure(ctx.from);
    for (const ch of (g.requireChannels || [config.CHANNEL_USERNAME])) {
      if ((await subscription.check(uid, ch)) !== true) return ctx.answerCbQuery('Спершу підпишись на ' + ch, { show_alert: true }).catch(() => {});
    }
    g.participants = g.participants || {};
    if (!g.participants[uid]) {
      g.participants[uid] = { tickets: (users.get(uid) || {}).hasNameTag ? 3 : 1, joinedAt: Date.now() };
      store.setGiveaway(gid, g);
    }
    await ctx.answerCbQuery('✅').catch(() => {});
    const c = giveawayCard(g, gid, uid);
    await ctx.reply(c.text, { parse_mode: 'HTML', ...c.extra }).catch(() => {});
  });
  hooks.onStartPayload.push(async (ctx, uid, payload) => {
    if (!payload.startsWith('ga_ga_')) return false;
    const gid = payload.slice(3);
    const g = store.getGiveaway(gid);
    if (!g) return false;
    const c = giveawayCard(g, gid, uid);
    await ctx.reply(c.text, { parse_mode: 'HTML', ...c.extra }).catch(() => {});
    return true;
  });

  // Докази (скріни) — на перевірку адміну.
  bot.action(/^ga_proof_(ga_[a-z0-9_]+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); users.patch(String(ctx.from.id), { awaitingProofFor: ctx.match[1] + ':reaction' }); await ctx.reply('📸 Надішли сюди скріншот своєї реакції на пост.').catch(() => {}); });
  bot.action(/^ga_proof_repost_(ga_[a-z0-9_]+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); users.patch(String(ctx.from.id), { awaitingProofFor: ctx.match[1] + ':repost' }); await ctx.reply('📸 Надішли сюди скріншот репосту.').catch(() => {}); });
  bot.on('photo', async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return next();
    const uid = String(ctx.from.id);
    const u = users.get(uid);
    if (!u || !u.awaitingProofFor) return next();
    const [gid, kind] = u.awaitingProofFor.split(':');
    users.patch(uid, { awaitingProofFor: null });
    const ph = ctx.message.photo[ctx.message.photo.length - 1];
    await ctx.reply('✅ Скрін отримано, передав адміну.').catch(() => {});
    const who = `${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}`;
    if (kind === 'external_ref') {
      return notify.tg.telegram.sendPhoto(config.ADMIN_CHAT_ID, ph.file_id, { caption: `📸 Реєстрація за посиланням\n${who}`, ...ui.kb([[ui.cb('✅ Підтвердити', 'extproof_ok_' + uid, 'success'), ui.cb('❌ Відхилити', 'extproof_no_' + uid, 'danger')]]) }).catch(() => {});
    }
    await notify.tg.telegram.sendPhoto(config.ADMIN_CHAT_ID, ph.file_id, { caption: `📸 Доказ (${kind}) для ${gid}\n${who}`,
      ...ui.kb([[ui.cb('✅ +1 квиток', `proof_ok_${kind}_${gid}_${uid}`, 'success'), ui.cb('❌ Відхилити', `proof_no_${kind}_${gid}_${uid}`, 'danger')]]) }).catch(() => {});
  });
  bot.action(/^proof_ok_(reaction|repost)_(ga_[a-z0-9_]+)_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery('✅').catch(() => {});
    const [, , gid, uid] = ctx.match;
    const g = store.getGiveaway(gid);
    if (!g) return ctx.reply('Розіграш не знайдено.');
    g.participants = g.participants || {};
    const p = g.participants[uid] || { tickets: 0, joinedAt: Date.now() };
    p.tickets = ticketsIn(p) + 1; g.participants[uid] = p;
    store.setGiveaway(gid, g);
    notify.dm(uid, `✅ Доказ підтверджено — +1 квиток! Тепер у тебе: ${p.tickets}.`);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });
  bot.action(/^proof_no_(reaction|repost)_(ga_[a-z0-9_]+)_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    await ask(ctx, 'proof_no', { uid: ctx.match[3] }, 'Причина відхилення доказу (або «-»):');
  });

  // ─── Пароль-челендж ───────────────────────────────────────────────────
  bot.command('password_challenge_start', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const password = argsOf(ctx).join(' ').trim() || 'FREEMISHKAAA';
    store.setPasswordChallenge({ active: true, password, tierId: 'bear', winnerId: null, startedAt: Date.now() });
    const link = `https://t.me/${notify.tg.botUsername}?start=${PASSWORD_PAYLOAD}`;
    await notify.tg.telegram.sendMessage(config.CHANNEL_USERNAME, em('teddyBear', '🧸') + ' <b>Чек на мішку!</b>', { parse_mode: 'HTML', ...ui.kb([[ui.url('Отримати', link, 'danger')]]) })
      .then(() => ctx.reply(`✅ Пост у каналі. Пароль: «${password}»`)).catch(e => ctx.reply('⚠️ ' + e.message));
  });
  hooks.onStartPayload.push(async (ctx, uid, payload) => {
    if (payload !== PASSWORD_PAYLOAD) return false;
    const pc = store.getPasswordChallenge();
    if (pc && pc.active) { users.patch(uid, { awaitingPasswordChallenge: true }); await ctx.reply('🧸 Введи пароль, щоб отримати мішку:'); }
    else await ctx.reply('⚠️ Челендж уже завершено — стеж за наступним у каналі.');
    return true;
  });
  hooks.onText.push(async (ctx, uid, text) => {
    const u = users.get(uid);
    if (!u || !u.awaitingPasswordChallenge) return false;
    const pc = store.getPasswordChallenge();
    if (!pc || !pc.active) { users.patch(uid, { awaitingPasswordChallenge: false }); await ctx.reply('⚠️ Челендж уже завершено.'); return true; }
    if (Date.now() - (guessAt.get(uid) || 0) < 3000) { await ctx.reply('⏳ Одна спроба на 3 секунди.'); return true; }
    guessAt.set(uid, Date.now());
    if (text.trim().toLowerCase() !== String(pc.password).trim().toLowerCase()) { await ctx.reply('🔴 Невірний пароль, спробуй ще.'); return true; }
    pc.active = false; pc.winnerId = uid; store.setPasswordChallenge(pc);
    users.patch(uid, { awaitingPasswordChallenge: false });
    const a = applications.create(uid, pc.tierId, 'password_challenge');
    await ctx.reply(`🎉 ВІРНО! Ти перший — ${E.getTier(pc.tierId).emoji} твоя! Заявка #${a.id}.`);
    return true;
  });

  // ─── «Шанс на мішку»: реєстрація в зовнішньому боті ───────────────────
  bot.command('external_ref_announce', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const link = argsOf(ctx)[0];
    if (!link) return ctx.reply('Формат: /external_ref_announce <посилання>');
    const pos = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => crypto.randomInt(3) - 1).slice(0, 2).concat([10]);
    const pool = { active: true, poolCap: 10, winnersCount: 3, tierId: 'bear', participants: [], winningPositions: pos, wonCount: 0, link };
    store.setExternalRefPool(pool);
    await broadcast(ctx, audience(), async (uid) => notify.tg.telegram.sendMessage(uid,
      `🧸 <b>ШАНС НА МІШКУ</b>\n\nПерейди за посиланням, зроби скрін і надішли боту. 10-й учасник отримує мішку гарантовано!`,
      { parse_mode: 'HTML', ...ui.kb([[ui.url('Перейти', link, 'primary')], [ui.cb('Приєднатись', 'ext_ref_join', 'danger')]]) }), 'Шанс на мішку');
  });
  bot.action('ext_ref_join', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    const pool = store.getExternalRefPool();
    if (!pool || !pool.active) return ctx.reply('Ця можливість уже закрита.').catch(() => {});
    if ((pool.participants || []).includes(uid)) return ctx.reply('Ти вже в пулі — чекай результат.').catch(() => {});
    users.ensure(ctx.from);
    users.patch(uid, { awaitingProofFor: 'external:external_ref' });
    await ctx.reply('1️⃣ Відкрий бота за кнопкою\n2️⃣ Натисни /start\n3️⃣ Зроби скрін і надішли сюди', ui.kb([[ui.url('Перейти в бота', pool.link, 'primary')]])).catch(() => {});
  });
  bot.action(/^extproof_ok_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const uid = ctx.match[1];
    const pool = store.getExternalRefPool();
    if (!pool || !pool.active) return ctx.reply('Пул закрито.');
    if ((pool.participants || []).includes(uid)) return ctx.reply('Вже в пулі.');
    pool.participants = (pool.participants || []).concat([uid]);
    const position = pool.participants.length;
    if (pool.winningPositions.includes(position)) {
      pool.wonCount = (pool.wonCount || 0) + 1;
      const a = applications.create(uid, pool.tierId, 'external_ref');
      notify.dm(uid, `🎉 <b>Ти виграв мішку!</b> Заявка #${a.id}.`);
      await ctx.reply(`🎉 Позиція ${position}/10 — виграш, заявка #${a.id}.`);
    } else {
      notify.dm(uid, `Цього разу без призу (позиція ${position}/10) — буде ще багато шансів 🙂`);
      await ctx.reply(`Позиція ${position}/10 — без виграшу.`);
    }
    if (position >= pool.poolCap) pool.active = false;
    store.setExternalRefPool(pool);
  });
  bot.action(/^extproof_no_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    await ask(ctx, 'proof_no', { uid: ctx.match[1] }, 'Причина відхилення (або «-»):');
  });
  hooks.onAdminText.push(async (ctx, text) => {
    const p = takePending(ctx.from.id, 'proof_no');
    if (!p) return false;
    const reason = text.trim() === '-' ? '' : '\n\nПричина: ' + esc(text.trim());
    notify.dm(p.data.uid, '❌ Твій скрін не підтверджено адміном.' + reason);
    await ctx.reply('❌ Відхилено.');
    return true;
  });

  // ─── Подія-лідерборд ──────────────────────────────────────────────────
  bot.command('unlock_event', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    await ask(ctx, 'unlock', {}, (store.getFeatureFlags() || {}).eventUnlocked ? '🔐 Подія увімкнена. Пароль, щоб ВИМКНУТИ:' : '🔐 Пароль, щоб УВІМКНУТИ подію-лідерборд:');
  });
  hooks.onAdminText.push(async (ctx, text) => {
    const p = takePending(ctx.from.id, 'unlock');
    if (!p) return false;
    ctx.deleteMessage().catch(() => {});
    if (text.trim() !== config.ADVANCED_UNLOCK_PASSWORD) { await ctx.reply('❌ Невірний пароль.'); return true; }
    const on = !(store.getFeatureFlags() || {}).eventUnlocked;
    store.setFeatureFlags({ eventUnlocked: on });
    if (on && !(store.getEvent() && store.getEvent().active)) {
      const endsAt = Date.now() + 7 * time.DAY_MS;
      store.setEvent({ active: true, startedAt: Date.now(), endsAt });
      scheduleEvent();
      await broadcast(ctx, audience(), async (uid) => notify.tg.telegram.sendMessage(uid,
        `📣 <b>ПОДІЯ СТАРТУВАЛА!</b>\n\nЗапрошуй друзів — топ-3 отримають 🚀 Ракету, 🎁 Подарунок і 🧸 Мішку.\n⏰ До ${time.fmtKyiv(endsAt, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
        { parse_mode: 'HTML', ...ui.openApp((users.get(uid) || {}).lang || 'uk', 'friends') }), 'Анонс події');
    } else await ctx.reply(on ? '✅ Подію увімкнено.' : '⏹ Подію вимкнено.');
    return true;
  });

  // ─── Що зараз іде ─────────────────────────────────────────────────────
  function activeEvents() {
    const out = [];
    const ev = store.getEvent();
    if (ev && ev.active) out.push({ key: 'event', label: '🎉 Подія', info: 'до ' + time.fmtKyiv(ev.endsAt) });
    const pc = store.getPasswordChallenge();
    if (pc && pc.active) out.push({ key: 'password', label: '🔑 Пароль-челендж', info: 'пароль: ' + pc.password });
    const b = (store.getFeatureFlags() || {}).bank;
    if (b && b.status === 'open') out.push({ key: 'bank', label: '🏦 Банк', info: b.order.length + ' гравців, розіграш ' + time.fmtKyiv(b.drawAt) });
    const pool = store.getExternalRefPool();
    if (pool && pool.active) out.push({ key: 'extref', label: '🧸 Шанс на мішку', info: (pool.participants || []).length + '/10' });
    for (const [gid, g] of Object.entries(store.listGiveaways() || {})) if (g && g.active && g.endsAt > Date.now()) out.push({ key: 'giveaway:' + gid, label: '🎁 Розіграш ' + gid, info: Object.keys(g.participants || {}).length + ' учасників' });
    return out;
  }
  bot.command('event_status', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const l = activeEvents();
    await ctx.reply(l.length ? '🟢 Зараз іде:\n\n' + l.map(e => `${e.label} — ${e.info}\n   /event_stop ${e.key}`).join('\n') : 'Зараз нічого не запущено.');
  });
  bot.command('event_stop', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const key = argsOf(ctx)[0];
    if (!key) return ctx.reply('Що зупинити? /event_status');
    const done = [];
    const stop = (k) => {
      if (k === 'event') { const ev = store.getEvent(); if (ev) { ev.active = false; store.setEvent(ev); done.push('подію'); } }
      else if (k === 'password') { const pc = store.getPasswordChallenge(); if (pc) { pc.active = false; store.setPasswordChallenge(pc); done.push('челендж'); } }
      else if (k === 'extref') { const p = store.getExternalRefPool(); if (p) { p.active = false; store.setExternalRefPool(p); done.push('шанс на мішку'); } }
      else if (k === 'bank') { const r = require('../../features/bank').cancel('Банк скасовано адміністратором.'); if (r.ok) done.push('банк (повернуто ставки)'); }
      else if (k.startsWith('giveaway:')) { const gid = k.slice(9); const g = store.getGiveaway(gid); if (g) { g.active = false; store.setGiveaway(gid, g); done.push('розіграш ' + gid); } }
    };
    if (key === 'all') activeEvents().forEach(e => stop(e.key)); else stop(key);
    await ctx.reply(done.length ? '🛑 Зупинено: ' + done.join(', ') : 'Нічого не знайшов.');
  });
}

module.exports = { register, scheduleAll, finishGiveaway, adjustGiveawayTickets };
