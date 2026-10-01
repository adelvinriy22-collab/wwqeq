// ==========================================================================
// МЕГА-РОЗІГРАШ (колишній розіграш автовидачі). Адмін: /awd_giveaway [учасників=100] [@канал…].
// Призи за місцями — E.AWD_GIVEAWAY.places (1-ше: 🚀 + 🎁 … 25-те; autowd у місці — промокод на автовидачу).
// Участь — лише з підпискою на канали g.mustSub (за замовчуванням AWD_SUB_CHANNELS).
// Бот публікує пост у каналі з кнопкою «УЧАСТЬ» (веде в бота) і розсилає
// анонс усім. Лічильник у пості оновлюється. Щойно набирається потрібна
// кількість учасників — результати: переможцям особисті промокоди
// (forUid, 1 активація), які відкривають автовидачу (bot/autogift.js),
// пост із переможцями в каналі, решті — повідомлення, адміну — звіт.
// Стан — featureFlags.awdGiveaway; «done» ставиться синхронно, до await.
// ==========================================================================
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const users = require('../core/users');
const notify = require('../core/notify');
const promo = require('../features/promo');
const subscription = require('../core/subscription');
const ui = require('./ui');
const { withEmoji } = require('../emoji');
const { esc, sleep } = require('../lib/util');
const { broadcast, audience, argsOf } = require('./admin/shared');
const E = require('../economy');
const progress = require('../core/progress');
const tggifts = require('../features/tggifts');
const usergifts = require('../features/usergifts');
const applications = require('../features/applications');

const PLACES = () => E.AWD_GIVEAWAY.places;
const placesTotal = () => PLACES().reduce((m, p) => Math.max(m, p.to), 0);
const placeOf = (n) => PLACES().find(p => n >= p.from && n <= p.to);
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const GIFT_NAME = { rocket: '🚀 Ракета', gift: '🎁 Подарунок', bear: '🧸 Мішка' };
// Опис призу: «🧸 Автовидача + 🚀 Ракета + 15⭐».
function prizeText(p) {
  const out = [];
  if (p.autowd) out.push('🧸 <b>АВТОВИДАЧА</b>');
  if (p.gift) out.push('<b>' + GIFT_NAME[p.gift] + '</b>');
  if (p.gift2) out.push('<b>' + GIFT_NAME[p.gift2] + '</b>');
  if (p.stars) out.push('<b>' + p.stars + '⭐</b>');
  if (p.tickets) out.push(p.tickets + '🎫');
  if (p.xp) out.push(p.xp + ' XP');
  return out.join(' + ');
}
// «*» — приз нараховується на баланс у боті (зірки, білети, XP), а не подарунком.
const inBot = (p) => !p.gift && !p.gift2 && !p.autowd;
function prizeTable() {
  return PLACES().map(p => (p.from === p.to ? (MEDAL[p.from] || p.from + '.') : p.from + '–' + p.to + '.') + ' ' + prizeText(p) + (inBot(p) ? ' *' : '')).join('\n');
}

const st = () => (store.getFeatureFlags() || {}).awdGiveaway || null;
const setSt = (v) => store.setFeatureFlags({ awdGiveaway: v });
const count = (g) => Object.keys(g.participants || {}).length;
const nameOf = (u) => u && u.username ? '@' + esc(u.username) : esc((u && u.name) || 'гравець');
const joinUrl = () => 'https://t.me/' + notify.tg.botUsername + '?start=awdga';

function bar(n, need) {
  const f = Math.min(10, Math.round(n / need * 10));
  return '▰'.repeat(f) + '▱'.repeat(10 - f);
}
function postText(g) {
  const n = count(g), subs = (g.mustSub || []).map(esc).join(', ');
  return withEmoji(ui.card('giftBox', 'МЕГА-РОЗІГРАШ STARFORGE — ' + placesTotal() + ' ПРИЗІВ', [
    '{:crown} <b>Головний приз — 🚀 Ракета + 🎁 Подарунок</b> — справжні подарунки Telegram прямо в твій профіль!',
    '',
    '{:trophy} <b>Призи:</b>',
    prizeTable(),
    '',
    '{:lightning} <b>Як узяти участь (1 хвилина):</b>',
    subs ? '1️⃣ Підпишись на ' + subs : null,
    (subs ? '2️⃣' : '1️⃣') + ' Тисни «УЧАСТЬ» нижче — відкриється бот',
    (subs ? '3️⃣' : '2️⃣') + ' Готово! Щойно нас буде <b>' + g.need + '</b> — бот сам розіграє місця',
    '',
    '<i>* ці нагороди видаються в боті @' + esc(notify.tg.botUsername || 'StarForgeX_bot') + ' — на твій баланс: зірки там крутять у колесах, міняють і виводять подарунками.</i>',
    '',
    '👥 Учасників: <b>' + n + '/' + g.need + '</b>',
    bar(n, g.need),
  ], 'Шанс — у кожного. Клич друзів: що швидше 100 — то швидше результати!'));
}
function doneText(g, winners) {
  return withEmoji(ui.card('trophy', 'РЕЗУЛЬТАТИ МЕГА-РОЗІГРАШУ', [
    '👥 Учасників: <b>' + count(g) + '</b>',
    '',
    winners.map((id, i) => {
      const n = i + 1, p = placeOf(n);
      return (MEDAL[n] || n + '.') + ' ' + nameOf(users.get(id)) + ' — ' + prizeText(p);
    }).join('\n'),
    '',
    '{:check} Подарунки 🚀 🎁 🧸 — уже надсилаються, а нагороди з * — нараховано на баланс у боті @' + esc(notify.tg.botUsername || 'StarForgeX_bot') + '.',
  ], 'Дякуємо всім! Наступний розіграш уже скоро 👀'));
}

let editTimer = null;
function refreshPost() {
  if (editTimer) return;
  editTimer = setTimeout(() => {
    editTimer = null;
    const g = st();
    if (!g || g.status !== 'open' || !g.channelMsgId) return;
    notify.tg.telegram.editMessageText(g.channelId, g.channelMsgId, undefined, postText(g),
      { parse_mode: 'HTML', ...ui.kb([[ui.url('УЧАСТЬ', joinUrl(), 'success', 'giftBox')]]) }).catch(() => {});
  }, 3000);
}

const genCode = () => 'AWD' + crypto.randomBytes(3).toString('hex').toUpperCase();

// Подарунок Telegram: від акаунта власника → від бота → заявка адміну.
async function giveGift(uid, tier) {
  const u = users.get(uid) || {};
  if (usergifts.accountReady()) {
    const r = await usergifts.send(u.username ? '@' + u.username : uid, tier, '🏆 Приз мега-розіграшу StarForge');
    if (r.ok) return 'sent';
  }
  const b = await tggifts.send(uid, tier, '🏆 Приз мега-розіграшу StarForge');
  if (b.ok) return 'sent';
  const a = applications.create(uid, tier, 'awd_giveaway', {}, { silent: true });
  return 'app#' + a.id;
}

async function finish(g) {
  const ids = Object.keys(g.participants || {});
  const pool = ids.slice(), winners = [];
  for (let i = 0; i < placesTotal() && pool.length; i++) winners.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  // Спершу все, що синхронно: коди, зірки, білети, XP — і стан «done».
  const codes = {}, log = [];
  winners.forEach((w, i) => {
    const p = placeOf(i + 1);
    if (p.autowd) {
      let code = genCode();
      while (store.getPromoCode(code)) code = genCode();
      store.setPromoCode(code, { amount: 0, tickets: 0, spins: 0, autowd: true, forUid: w, usesLeft: 1, usedBy: [], createdAt: Date.now() });
      codes[w] = code;
    }
    if (p.stars || p.tickets) users.move(w, { stars: p.stars || 0, tickets: p.tickets || 0 }, 'giveaway', { awd: g.id, place: i + 1 });
    if (p.xp) progress.addXp(w, 'admin', p.xp, { why: 'awd_giveaway' });
  });
  setSt({ ...g, status: 'done', finishedAt: Date.now(), winnerIds: winners, codes });
  if (g.channelMsgId) {
    notify.tg.telegram.editMessageText(g.channelId, g.channelMsgId, undefined, doneText(g, winners), { parse_mode: 'HTML' }).catch(() => {});
    notify.tg.telegram.sendMessage(g.channelId, doneText(g, winners), { parse_mode: 'HTML', reply_to_message_id: g.channelMsgId, allow_sending_without_reply: true }).catch(e => console.error('awdga results:', e.message));
  }
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i], n = i + 1, p = placeOf(n);
    const gift = p.gift ? await giveGift(w, p.gift) : null;
    const gift2 = p.gift2 ? await giveGift(w, p.gift2) : null;
    log.push((MEDAL[n] || n + '.') + ' ' + nameOf(users.get(w)) + ' · <code>' + w + '</code> — ' + prizeText(p) +
      (codes[w] ? ' · код <code>' + codes[w] + '</code>' : '') + (gift && gift !== 'sent' ? ' · ⚠️ подарунок заявкою ' + gift : '') + (gift2 && gift2 !== 'sent' ? ' · ⚠️ подарунок заявкою ' + gift2 : ''));
    await notify.dm(w, withEmoji(ui.card(n <= 3 ? 'crown' : 'giftBox', (MEDAL[n] || '🏅') + ' ТИ ПОСІВ ' + n + ' МІСЦЕ!', [
      'Твій приз: ' + prizeText(p),
      '',
      p.stars || p.tickets || p.xp ? '{:check} Зірки, білети й XP уже на балансі.' : null,
      ...[[p.gift, gift], [p.gift2, gift2]].filter(([t]) => t).map(([t, r]) => r === 'sent' ? '{:check} ' + GIFT_NAME[t] + ' уже в профілі Telegram → «Подарунки».' : '⏳ ' + GIFT_NAME[t] + ' — адмін надішле найближчим часом.'),
      codes[w] ? '\n{:lightning} Твій промокод на <b>АВТОВИДАЧУ</b>: <code>' + codes[w] + '</code>\nТисни кнопку — і бот сам надішле тобі 🧸 з твоїм підписом.' : null,
    ], 'Вітаємо! Грай далі в StarForge — призів ще багато')), { parse_mode: 'HTML', ...ui.kb([
      codes[w] ? [ui.cb('АКТИВУВАТИ АВТОВИДАЧУ', 'awdga:code', 'success', 'teddyBear')] : null,
      [ui.app('ВІДКРИТИ STARFORGE', null, 'primary', 'rocket')],
    ]) });
    await sleep(60);
  }
  notify.admin('🏁 <b>Мега-розіграш завершено</b> (' + count(g) + ' учасників)\n\n' + log.join('\n'));
  for (const id of ids) {
    if (winners.includes(id)) continue;
    await notify.dm(id, withEmoji('{:giftBox} <b>Мега-розіграш завершено!</b>\nЦього разу без призу — але в боті щодня безкоштовне колесо, завдання й нові розіграші {:eye}'),
      { parse_mode: 'HTML', ...ui.kb([[ui.app('ВІДКРИТИ STARFORGE', null, 'success', 'rocket')]]) });
    await sleep(60);
  }
}

// Участь. → 'joined' | 'already' | 'closed' | 'nosub' (missing — канали без підписки)
async function join(uid) {
  const g0 = st();
  if (!g0 || g0.status !== 'open') return { r: 'closed' };
  if (!g0.participants[uid]) {
    const missing = [];
    for (const ch of g0.mustSub || []) if ((await subscription.check(uid, ch)) !== true) missing.push(ch);
    if (missing.length) return { r: 'nosub', missing };
  }
  // Далі — синхронно: стан міг змінитись, поки перевіряли підписку.
  const g = st();
  if (!g || g.status !== 'open') return { r: 'closed' };
  if (g.participants[uid]) return { r: 'already', g };
  g.participants[uid] = { at: Date.now() };
  // Набрали — закриваємо синхронно, до будь-якого await: зайвий учасник не пройде.
  if (count(g) >= g.need) { g.status = 'drawing'; setSt(g); finish(g).catch(e => console.error('awdga finish:', e.message)); }
  else { setSt(g); refreshPost(); }
  return { r: 'joined', g };
}
function joinReply(res) {
  if (res.r === 'nosub') {
    return [withEmoji(ui.card('warn', 'СПЕРШУ ПІДПИШИСЬ', [
      'Щоб узяти участь у мега-розіграші, підпишись на:',
      res.missing.map(ch => '• <b>' + esc(ch) + '</b>').join('\n'),
      '',
      'Потім натисни «ПЕРЕВІРИТИ» {:check}',
    ])), ui.kb(res.missing.map(ch => [ui.url('ПІДПИСАТИСЬ — ' + ch, 'https://t.me/' + ch.replace(/^@/, ''), 'primary')])
      .concat([[ui.cb('ПЕРЕВІРИТИ', 'awdga:join', 'success', 'check')]]))];
  }
  return [joinText(res), {}];
}
function joinText(res) {
  if (res.r === 'closed') return withEmoji('{:warn} Цей розіграш уже завершено. Стеж за каналом — наступний скоро {:eye}');
  const g = res.g, n = count(g);
  return withEmoji(ui.card('check', res.r === 'joined' ? 'ТИ В ГРІ!' : 'ТИ ВЖЕ БЕРЕШ УЧАСТЬ', [
    '{:giftBox} Мега-розіграш — <b>' + placesTotal() + ' призів</b>, 1-ше місце: 🚀 Ракета + 🎁 Подарунок',
    '{:lightning} Учасників: <b>' + n + '/' + g.need + '</b>',
    bar(n, g.need),
    '',
    'Поки чекаєш — крути безкоштовне колесо в боті {:lightning}',
  ], 'Результати — щойно нас буде ' + g.need + '. Клич друзів!'));
}

function register(bot, hooks) {
  const isAdm = (ctx) => !!(ctx.from && users.isAdmin(ctx.from.id));

  bot.command('awd_giveaway', async (ctx) => {
    if (!isAdm(ctx)) return;
    const a = argsOf(ctx);
    const g0 = st();
    if (a[0] === 'status') {
      if (!g0) return ctx.reply('Мега-розіграшу ще не було.').catch(() => {});
      return ctx.reply(`🎁 Мега-розіграш: ${g0.status === 'open' ? 'триває' : 'завершено'}\nУчасників: ${count(g0)}/${g0.need}` +
        (g0.winnerIds ? '\n' + g0.winnerIds.map((w, i) => (i + 1) + '. ' + nameOf(users.get(w)) + (g0.codes[w] ? ' — ' + g0.codes[w] + (((users.get(w) || {}).autoGift || {}).status === 'sent' ? ' ✅ забрав' : '') : '')).join('\n') : ''), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (a[0] === 'cancel') {
      if (!g0 || g0.status !== 'open') return ctx.reply('Нічого скасовувати.').catch(() => {});
      setSt({ ...g0, status: 'cancelled' });
      if (g0.channelMsgId) notify.tg.telegram.editMessageText(g0.channelId, g0.channelMsgId, undefined, withEmoji('{:warn} <b>Мега-розіграш скасовано.</b>'), { parse_mode: 'HTML' }).catch(() => {});
      return ctx.reply('🚫 Скасовано, пост у каналі оновлено.').catch(() => {});
    }
    if (g0 && g0.status === 'open') return ctx.reply(`Уже триває: ${count(g0)}/${g0.need}. /awd_giveaway status · /awd_giveaway cancel`).catch(() => {});
    const nums = a.filter(x => /^\d+$/.test(x)).map(Number);
    const subs = a.filter(x => /^@\w{4,}$/.test(x));
    const need = Math.max(2, nums[0] || E.AWD_GIVEAWAY.need);
    const mustSub = subs.length ? subs : config.AWD_SUB_CHANNELS;
    const g = { id: Date.now().toString(36), status: 'open', need, participants: {}, mustSub, startedAt: Date.now(), channelId: config.CHANNEL_USERNAME };
    setSt(g);
    try {
      const m = await notify.tg.telegram.sendMessage(config.CHANNEL_USERNAME, postText(g), { parse_mode: 'HTML', ...ui.kb([[ui.url('УЧАСТЬ', joinUrl(), 'success', 'giftBox')]]) });
      const cur = st(); setSt({ ...cur, channelMsgId: m.message_id, channelId: m.chat.id });
      await ctx.reply('✅ Пост у каналі ' + config.CHANNEL_USERNAME + ' опубліковано.').catch(() => {});
    } catch (e) {
      await ctx.reply('⚠️ Канал: ' + e.message + '\nРозіграш однаково запущено — участь через розсилку.').catch(() => {});
    }
    await broadcast(ctx, audience(), (uid) => notify.tg.telegram.sendMessage(uid, postText(st() || g),
      { parse_mode: 'HTML', ...ui.kb([[ui.cb('УЧАСТЬ', 'awdga:join', 'success', 'giftBox')]]) }), 'Розсилка мега-розіграшу');
  });

  bot.action('awdga:join', async (ctx) => {
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    const res = await join(uid);
    await ctx.answerCbQuery({ joined: '✅ Ти в грі!', already: 'Ти вже береш участь', nosub: 'Спершу підпишись', closed: 'Розіграш завершено' }[res.r]).catch(() => {});
    const [text, kb] = joinReply(res);
    await ctx.reply(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
  });

  // Активувати свій промокод однією кнопкою.
  bot.action('awdga:code', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id), g = st();
    const code = g && g.codes && g.codes[uid];
    if (!code) return ctx.reply('Промокоду для тебе немає.').catch(() => {});
    const r = await promo.redeem(uid, code);
    if (!r.ok) return ctx.reply(r.error === 'used' ? withEmoji('{:check} Промокод уже активовано — автовидача відкрита (повідомлення вище).') : 'Код не діє.', { parse_mode: 'HTML' }).catch(() => {});
  });

  // Кнопка «УЧАСТЬ» у каналі веде сюди: /start awdga.
  hooks.onStartPayload.push(async (ctx, uid, payload) => {
    if (payload !== 'awdga') return false;
    users.ensure(ctx.from);
    const res = await join(uid);
    const [text, kb] = joinReply(res);
    await ctx.reply(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
    return false;   // далі — звичайний старт (меню / реєстрація новачка)
  });
}

module.exports = { register, join, postText, prizeText };
