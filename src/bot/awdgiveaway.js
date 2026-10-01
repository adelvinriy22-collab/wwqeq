// ==========================================================================
// РОЗІГРАШ АВТОВИДАЧІ. Адмін: /awd_giveaway [учасників=100] [переможців=1] [@канал…].
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
  const n = count(g);
  return withEmoji(ui.card('giftBox', 'РОЗІГРАШ АВТОВИДАЧІ', [
    '{:crown} Приз: <b>промокод на АВТОВИДАЧУ</b> — бот сам, без черги, надішле тобі справжню {:teddyBear} <b>Мішку</b> з твоїм підписом',
    '{:trophy} Переможців: <b>' + g.winners + '</b>',
    (g.mustSub || []).length ? '{:check} Умова: підписка на ' + g.mustSub.map(esc).join(', ') : null,
    '',
    '{:lightning} Учасників: <b>' + n + '/' + g.need + '</b>',
    bar(n, g.need),
    '',
    'Тисни «УЧАСТЬ» — результати одразу, щойно нас буде <b>' + g.need + '</b>!',
  ], 'Запрошуй друзів — швидше наберемо ' + g.need));
}
function doneText(g, winners) {
  return withEmoji(ui.card('check', 'РОЗІГРАШ АВТОВИДАЧІ — ЗАВЕРШЕНО', [
    '{:lightning} Учасників: <b>' + count(g) + '/' + g.need + '</b>',
    '',
    '{:crown} <b>Переможці:</b>',
    winners.map((id, i) => (i + 1) + '. ' + nameOf(users.get(id))).join('\n'),
    '',
    '{:teddyBear} Переможцям — промокод на автовидачу в особисті від бота',
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

async function finish(g) {
  const ids = Object.keys(g.participants || {});
  const pool = ids.slice(), winners = [];
  for (let i = 0; i < g.winners && pool.length; i++) winners.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  const codes = {};
  for (const w of winners) {
    let code = genCode();
    while (store.getPromoCode(code)) code = genCode();
    store.setPromoCode(code, { amount: 0, tickets: 0, spins: 0, autowd: true, forUid: w, usesLeft: 1, usedBy: [], createdAt: Date.now() });
    codes[w] = code;
  }
  setSt({ ...g, status: 'done', finishedAt: Date.now(), winnerIds: winners, codes });
  // Пост каналу — «завершено», плюс окремий пост із переможцями.
  if (g.channelMsgId) {
    notify.tg.telegram.editMessageText(g.channelId, g.channelMsgId, undefined, doneText(g, winners), { parse_mode: 'HTML' }).catch(() => {});
    notify.tg.telegram.sendMessage(g.channelId, doneText(g, winners), { parse_mode: 'HTML', reply_to_message_id: g.channelMsgId, allow_sending_without_reply: true }).catch(e => console.error('awdga results:', e.message));
  }
  for (const w of winners) {
    await notify.dm(w, withEmoji(ui.card('crown', 'ТИ ВИГРАВ АВТОВИДАЧУ!', [
      '{:giftBox} Твій особистий промокод:',
      '<code>' + codes[w] + '</code>',
      '',
      '{:lightning} Натисни кнопку нижче (або введи код у «Промокод») — відкриється автовидача, і бот сам надішле тобі {:teddyBear} <b>Мішку</b> з твоїм підписом.',
    ], 'Код діє лише для тебе · один раз')), { parse_mode: 'HTML', ...ui.kb([[ui.cb('АКТИВУВАТИ ПРОМОКОД', 'awdga:code', 'success', 'teddyBear')]]) });
  }
  notify.admin('🏁 <b>Розіграш автовидачі завершено</b> (' + count(g) + ' учасників)\n' +
    winners.map((w, i) => (i + 1) + '. ' + nameOf(users.get(w)) + ' · <code>' + w + '</code> — <code>' + codes[w] + '</code>').join('\n'));
  for (const id of ids) {
    if (winners.includes(id)) continue;
    await notify.dm(id, withEmoji('{:giftBox} <b>Розіграш автовидачі завершено!</b>\nПереможці: ' + winners.map(w => nameOf(users.get(w))).join(', ') +
      '\n\nЦього разу не пощастило — стеж за каналом, наступний уже скоро {:eye}'), { parse_mode: 'HTML' });
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
      'Щоб узяти участь у розіграші автовидачі, підпишись на:',
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
    '{:giftBox} Розіграш <b>автовидачі</b> — ' + g.winners + ' переможц' + (g.winners === 1 ? 'ь' : 'і'),
    '{:lightning} Учасників: <b>' + n + '/' + g.need + '</b>',
    bar(n, g.need),
  ], 'Результати — щойно нас буде ' + g.need + '. Клич друзів!'));
}

function register(bot, hooks) {
  const isAdm = (ctx) => !!(ctx.from && users.isAdmin(ctx.from.id));

  bot.command('awd_giveaway', async (ctx) => {
    if (!isAdm(ctx)) return;
    const a = argsOf(ctx);
    const g0 = st();
    if (a[0] === 'status') {
      if (!g0) return ctx.reply('Розіграшу автовидачі ще не було.').catch(() => {});
      return ctx.reply(`🎁 Розіграш автовидачі: ${g0.status === 'open' ? 'триває' : 'завершено'}\nУчасників: ${count(g0)}/${g0.need} · переможців: ${g0.winners}` +
        (g0.winnerIds ? '\n' + g0.winnerIds.map(w => nameOf(users.get(w)) + ' — ' + g0.codes[w] + (((users.get(w) || {}).autoGift || {}).status === 'sent' ? ' ✅ забрав' : '')).join('\n') : ''), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (a[0] === 'cancel') {
      if (!g0 || g0.status !== 'open') return ctx.reply('Нічого скасовувати.').catch(() => {});
      setSt({ ...g0, status: 'cancelled' });
      if (g0.channelMsgId) notify.tg.telegram.editMessageText(g0.channelId, g0.channelMsgId, undefined, withEmoji('{:warn} <b>Розіграш автовидачі скасовано.</b>'), { parse_mode: 'HTML' }).catch(() => {});
      return ctx.reply('🚫 Скасовано, пост у каналі оновлено.').catch(() => {});
    }
    if (g0 && g0.status === 'open') return ctx.reply(`Уже триває: ${count(g0)}/${g0.need}. /awd_giveaway status · /awd_giveaway cancel`).catch(() => {});
    const nums = a.filter(x => /^\d+$/.test(x)).map(Number);
    const subs = a.filter(x => /^@\w{4,}$/.test(x));
    const need = Math.max(2, nums[0] || 100);
    const winners = Math.max(1, Math.min(need, nums[1] || 1));
    const mustSub = subs.length ? subs : config.AWD_SUB_CHANNELS;
    const g = { id: Date.now().toString(36), status: 'open', need, winners, participants: {}, mustSub, startedAt: Date.now(), channelId: config.CHANNEL_USERNAME };
    setSt(g);
    try {
      const m = await notify.tg.telegram.sendMessage(config.CHANNEL_USERNAME, postText(g), { parse_mode: 'HTML', ...ui.kb([[ui.url('УЧАСТЬ', joinUrl(), 'success', 'giftBox')]]) });
      const cur = st(); setSt({ ...cur, channelMsgId: m.message_id, channelId: m.chat.id });
      await ctx.reply('✅ Пост у каналі ' + config.CHANNEL_USERNAME + ' опубліковано.').catch(() => {});
    } catch (e) {
      await ctx.reply('⚠️ Канал: ' + e.message + '\nРозіграш однаково запущено — участь через розсилку.').catch(() => {});
    }
    await broadcast(ctx, audience(), (uid) => notify.tg.telegram.sendMessage(uid, postText(st() || g),
      { parse_mode: 'HTML', ...ui.kb([[ui.cb('УЧАСТЬ', 'awdga:join', 'success', 'giftBox')]]) }), 'Розсилка розіграшу автовидачі');
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

module.exports = { register, join };
