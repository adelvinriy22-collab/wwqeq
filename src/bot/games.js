// ==========================================================================
// ІГРИ НА ЗІРКИ В ЧАТІ З БОТОМ — як у попередній версії: меню ігор, ставки
// кнопками або своєю сумою, Telegram сам кидає кубик (анімація, підробити
// неможливо), після анімації — результат, реакція на кубику й «Ще раз».
// ==========================================================================
const E = require('../economy');
const users = require('../core/users');
const notify = require('../core/notify');
const games = require('../features/games');
const ui = require('./ui');
const { fmtStars, esc, sleep, whoOf } = require('../lib/util');
const { withEmoji } = require('../emoji');

const T = {
  uk: {
    title: 'ІГРИ НА ЗІРКИ', balance: '{:starIcon} Баланс: <b>{b}⭐</b>',
    fair: '{:check} Telegram сам кидає кубик — результат чесний, підробити неможливо.', xp: '{:lightning} Кожна ⭐ ставки — {x} XP до рівня й пасу, навіть якщо не пощастило.',
    pickGame: 'Обери гру 👇', pick: '{:lightning} Виграш: <b>{k}</b>', pickFoot: 'Обери ставку 👇', slotsK: '777 ×20 · три однакові ×6 · дві сімки ×2',
    own: 'СВОЯ СТАВКА', again: 'ЩЕ РАЗ ({s}⭐)', change: 'ЗМІНИТИ СТАВКУ', other: '🎲 ІНША ГРА',
    bank: 'СПІЛЬНИЙ БАНК', wheels: 'КОЛЕСА', ask: '{:starIcon} Напиши ставку числом — від {min} до {max}⭐.',
    badBet: '{:warn} Ставка — ціле число від {min} до {max}⭐.', noStars: '{:warn} Замало зірок: ставка {s}⭐, у тебе {b}⭐.', wait: '⏳ Зачекай, попередній кубик ще котиться.',
    won: 'ВИГРАШ!', wonLine: '{:starIcon} <b>+{p}⭐</b> (ставка {s}⭐ × {k})', lost: 'НЕ ПОЩАСТИЛО', lostLine: '{:redCircle} Ставка {s}⭐ згоріла', bal2: '{:starIcon} Баланс: <b>{b}⭐</b>',
    wonFoot: 'Кубик кидав Telegram — усе чесно', lostFoot: 'Наступного разу пощастить — XP за ставку вже твій',
    err: '{:warn} Кубик не надіслався — ставку повернуто.', topup: 'ПОПОВНИТИ', unknown: 'Ця гра недоступна.',
  },
  en: {
    title: 'STAR GAMES', balance: '{:starIcon} Balance: <b>{b}⭐</b>',
    fair: '{:check} Telegram rolls the dice itself — fair and impossible to fake.', xp: '{:lightning} Every ⭐ you bet gives {x} XP to your level and pass, even if you lose.',
    pickGame: 'Pick a game 👇', pick: '{:lightning} Win: <b>{k}</b>', pickFoot: 'Pick your bet 👇', slotsK: '777 ×20 · three of a kind ×6 · two sevens ×2',
    own: 'CUSTOM BET', again: 'AGAIN ({s}⭐)', change: 'CHANGE BET', other: '🎲 ANOTHER GAME',
    bank: 'SHARED BANK', wheels: 'WHEELS', ask: '{:starIcon} Send your bet as a number — from {min} to {max}⭐.',
    badBet: '{:warn} The bet is a whole number from {min} to {max}⭐.', noStars: '{:warn} Not enough stars: bet {s}⭐, you have {b}⭐.', wait: '⏳ Wait, the previous dice is still rolling.',
    won: 'YOU WON!', wonLine: '{:starIcon} <b>+{p}⭐</b> (bet {s}⭐ × {k})', lost: 'NO LUCK', lostLine: '{:redCircle} Bet {s}⭐ lost', bal2: '{:starIcon} Balance: <b>{b}⭐</b>',
    wonFoot: 'Telegram rolled the dice — all fair', lostFoot: 'Better luck next time — the XP for your bet is already yours',
    err: '{:warn} The dice wasn’t sent — your bet was returned.', topup: 'TOP UP', unknown: 'This game is unavailable.',
  },
  ru: {
    title: 'ИГРЫ НА ЗВЁЗДЫ', balance: '{:starIcon} Баланс: <b>{b}⭐</b>',
    fair: '{:check} Telegram сам бросает кубик — результат честный, подделать невозможно.', xp: '{:lightning} Каждая ⭐ ставки — {x} XP к уровню и пропуску, даже если не повезло.',
    pickGame: 'Выбери игру 👇', pick: '{:lightning} Выигрыш: <b>{k}</b>', pickFoot: 'Выбери ставку 👇', slotsK: '777 ×20 · три одинаковых ×6 · две семёрки ×2',
    own: 'СВОЯ СТАВКА', again: 'ЕЩЁ РАЗ ({s}⭐)', change: 'ИЗМЕНИТЬ СТАВКУ', other: '🎲 ДРУГАЯ ИГРА',
    bank: 'ОБЩИЙ БАНК', wheels: 'КОЛЁСА', ask: '{:starIcon} Напиши ставку числом — от {min} до {max}⭐.',
    badBet: '{:warn} Ставка — целое число от {min} до {max}⭐.', noStars: '{:warn} Мало звёзд: ставка {s}⭐, у тебя {b}⭐.', wait: '⏳ Подожди, предыдущий кубик ещё катится.',
    won: 'ВЫИГРЫШ!', wonLine: '{:starIcon} <b>+{p}⭐</b> (ставка {s}⭐ × {k})', lost: 'НЕ ПОВЕЗЛО', lostLine: '{:redCircle} Ставка {s}⭐ сгорела', bal2: '{:starIcon} Баланс: <b>{b}⭐</b>',
    wonFoot: 'Кубик бросал Telegram — всё честно', lostFoot: 'В следующий раз повезёт — XP за ставку уже твой',
    err: '{:warn} Кубик не отправился — ставка возвращена.', topup: 'ПОПОЛНИТЬ', unknown: 'Эта игра недоступна.',
  },
};
const fill = (lang, k, p) => String((T[lang] || T.uk)[k] || T.uk[k]).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m));
const tt = (lang, k, p) => withEmoji(fill(lang, k, p));   // текст повідомлення (HTML, преміум-емодзі)
const bt = fill;                                         // підпис кнопки / відповідь на натискання
const html = (text, rows) => ({ parse_mode: 'HTML', ...ui.kb(rows) });

// Що означає число з кубика Telegram (у футболі 5 значень, у слоті — 64).
const SLOT = ['BAR', '🍇', '🍋', '7️⃣'];
function resultText(lang, gameId, value, reels) {
  const L = { uk: 0, en: 1, ru: 2 }[lang] || 0;
  const pick = (a) => a[L];
  switch (gameId) {
    case 'dice': return pick(['випало ', 'rolled ', 'выпало ']) + value;
    case 'football': return value >= 3 ? pick(['ГОЛ', 'GOAL', 'ГОЛ']) : pick(['повз ворота', 'missed', 'мимо ворот']);
    case 'basket': return value >= 4 ? pick(['влучив у кільце', 'scored', 'попал в кольцо']) : pick(['мимо кільця', 'missed the hoop', 'мимо кольца']);
    case 'darts': return value === 6 ? pick(['у яблучко', 'bullseye', 'в яблочко']) : pick(['сектор ', 'ring ', 'сектор ']) + value + pick([' з 6', ' of 6', ' из 6']);
    case 'bowling': return value === 6 ? pick(['СТРАЙК', 'STRIKE', 'СТРАЙК']) : value === 1 ? pick(['мимо кеглів', 'missed the pins', 'мимо кеглей']) : pick(['збито не всі кеглі', 'not all pins down', 'сбиты не все кегли']);
    case 'slots': return (reels || []).map(r => SLOT[r]).join(' ');
    default: return String(value);
  }
}
// Скільки чекати, поки анімація кубика зупиниться.
const ANIM_MS = { '🎰': 2300, '🎲': 3800, '🎯': 3600, '🎳': 4200, '🏀': 4400, '⚽': 4400 };
const PRESETS = [1, 5, 10, 25, 50, 100];

const inFlight = new Set();
const awaitingStake = new Map();   // uid -> { game, bet, at }

function langOf(uid) { return (users.get(uid) || {}).lang || 'uk'; }
function kLabel(b) { return b.slots ? '×2–20' : '×' + b.k; }

function menu(uid) {
  const lang = langOf(uid);
  const b = (g, bid, style) => {
    const gm = E.GAMES[g], bet = gm.bets[bid];
    const name = bet.slots ? (gm.title[lang] || gm.title.uk) : (bet.title[lang] || bet.title.uk);
    return ui.cb(gm.emoji + ' ' + name.toUpperCase() + ' ' + kLabel(bet), 'dg:' + g + ':' + bid, style);
  };
  const rows = [
    [b('dice', 'even', 'primary'), b('dice', 'odd', 'primary')],
    [b('dice', 'high', 'primary'), b('dice', 'low', 'primary')],
    [b('dice', 'six', 'danger')],
    [b('football', 'goal', 'success'), b('football', 'miss', 'success')],
    [b('basket', 'hit', 'success')],
    [b('darts', 'bull', 'danger'), b('bowling', 'strike', 'danger')],
    [b('slots', 'spin', 'danger')],
    [ui.cb(bt(lang, 'bank'), 'bank_show', undefined, 'almost'), ui.app(bt(lang, 'wheels'), 'wheel', undefined, 'rocket')],
    [ui.back(lang)],
  ];
  const u = users.get(uid) || {};
  const text = ui.card('🎲', tt(lang, 'title'), [
    tt(lang, 'balance', { b: fmtStars(users.stars(u)) }), '',
    tt(lang, 'fair'), tt(lang, 'xp', { x: E.XP_RATES.gamePerStar }),
  ], bt(lang, 'pickGame'));
  return { text, extra: html(text, rows) };
}

function stakeMenu(uid, gameId, betId) {
  const lang = langOf(uid);
  const f = games.findBet(gameId, betId);
  const bal = users.stars(users.get(uid) || {});
  const k = f.b.slots ? null : f.b.k;
  const rows = [];
  const opts = PRESETS.filter(n => n <= bal && n <= E.GAME_BET.max);
  for (let i = 0; i < opts.length; i += 2) {
    rows.push(opts.slice(i, i + 2).map(n => ui.cb(n + '⭐' + (k ? ' → ' + fmtStars(n * k) + '⭐' : ''), `dp:${gameId}:${betId}:${n}`, 'success')));
  }
  rows.push([ui.cb(bt(lang, 'own'), `do:${gameId}:${betId}`, 'primary', 'lightning')]);
  if (!opts.length) rows.unshift([ui.app(bt(lang, 'topup'), 'topup', 'success', 'starIcon')]);
  rows.push([ui.back(lang, 'dice_menu')]);
  const title = ((f.g.title[lang] || f.g.title.uk) + ' — ' + (f.b.title[lang] || f.b.title.uk)).toUpperCase();
  const text = ui.card(f.g.emoji, esc(title), [
    tt(lang, 'pick', { k: f.b.slots ? bt(lang, 'slotsK') : '×' + f.b.k }),
    tt(lang, 'balance', { b: fmtStars(bal) }),
  ], bt(lang, 'pickFoot'));
  return { text, extra: html(text, rows) };
}

async function play(ctx, uid, gameId, betId, stake) {
  const lang = langOf(uid);
  if (inFlight.has(uid)) return ctx.reply(bt(lang, 'wait')).catch(() => {});
  inFlight.add(uid);
  try {
    const st = await games.botStake(uid, gameId, betId, stake);
    if (!st.ok) {
      if (st.error === 'not_enough_stars') {
        return ctx.reply(tt(lang, 'noStars', { s: stake, b: fmtStars(st.have || 0) }), html(null, [[ui.app(bt(lang, 'topup'), 'topup', 'success', 'starIcon')], [ui.cb(bt(lang, 'other'), 'dice_menu')], [ui.back(lang)]])).catch(() => {});
      }
      return ctx.reply(st.error === 'bad_bet' ? tt(lang, 'badBet', { min: E.GAME_BET.min, max: E.GAME_BET.max }) : bt(lang, 'unknown'), html(null, [[ui.back(lang, 'dice_menu')]])).catch(() => {});
    }
    let dm = null;
    try { dm = await ctx.telegram.sendDice(ctx.chat.id, { emoji: st.emoji }); } catch (e) { dm = null; }
    if (!dm || !dm.dice) { games.botRefund(uid, gameId, st.stake); return ctx.reply(tt(lang, 'err'), html(null, [[ui.back(lang, 'dice_menu')]])).catch(() => {}); }
    await sleep(ANIM_MS[st.emoji] || 4000);   // чекаємо, поки кубик зупиниться
    const r = await games.botSettle(uid, gameId, betId, st.stake, dm.dice.value);
    const k = r.k;
    // Реакція на кубику: виграш — 🎉 (великий — 🔥), програш — 😢.
    ctx.telegram.callApi('setMessageReaction', {
      chat_id: ctx.chat.id, message_id: dm.message_id,
      reaction: [{ type: 'emoji', emoji: r.won ? (k >= 5 ? '🔥' : '🎉') : '😢' }],
    }).catch(() => {});
    const e = E.GAMES[gameId].emoji;
    const res = resultText(lang, gameId, r.value, r.reels);
    const text = r.won
      ? ui.card('giftBox', tt(lang, 'won') + ' ' + e + ' ' + esc(res), [
        tt(lang, 'wonLine', { p: fmtStars(r.payout), s: st.stake, k }), tt(lang, 'bal2', { b: fmtStars(r.balance) }),
      ], bt(lang, 'wonFoot'))
      : ui.card(e, tt(lang, 'lost') + ' · ' + esc(res), [
        tt(lang, 'lostLine', { s: st.stake }), tt(lang, 'bal2', { b: fmtStars(r.balance) }),
      ], bt(lang, 'lostFoot'));
    await ctx.reply(text, { reply_to_message_id: dm.message_id, allow_sending_without_reply: true, ...html(text, [
      [ui.cb(bt(lang, 'again', { s: st.stake }), `dp:${gameId}:${betId}:${st.stake}`, 'success', 'lightning')],
      [ui.cb(bt(lang, 'change'), `dg:${gameId}:${betId}`, 'primary'), ui.cb(bt(lang, 'other'), 'dice_menu')],
      [ui.back(lang)],
    ]) }).catch(() => {});
    // Великий виграш — у чат, щоб інші теж захотіли.
    if (r.won && (k >= 5 || r.payout >= 50)) {
      const u = users.get(uid);
      notify.announce(`${e} <b>${whoOf(u)}</b> виграв <b>+${fmtStars(r.payout)}⭐</b> у грі «${esc(E.GAMES[gameId].title.uk)}» (×${k})!`);
    }
  } finally {
    inFlight.delete(uid);
  }
}

function register(bot, hooks, gate) {
  const priv = (ctx) => !ctx.chat || ctx.chat.type === 'private';
  const showMenu = async (ctx) => {
    if (!priv(ctx)) return;
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    if (gate && !(await gate(ctx, uid))) return;
    const m = menu(uid);
    await ctx.reply(m.text, m.extra).catch(() => {});
    await require('./menu').ensureBackKeyboard(ctx, uid);
  };
  bot.command(['games', 'dice', 'play'], showMenu);
  // dice_menu і старі кнопки попередньої версії (dice_g_…, dice_b_…, dice_own_…).
  bot.action(/^dice_(menu|g_\w+|b_\w+|own_\w+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await showMenu(ctx); });
  hooks.onStartPayload.push(async (ctx, uid, payload) => {
    if (payload !== 'games' && payload !== 'dice') return false;
    if (gate && !(await gate(ctx, uid))) return true;
    const m = menu(uid);
    await ctx.reply(m.text, m.extra).catch(() => {});
    return true;
  });

  bot.action(/^dg:(\w+):(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    if (!games.findBet(ctx.match[1], ctx.match[2])) return ctx.reply(bt(langOf(uid), 'unknown'), html(null, [[ui.back(langOf(uid), 'dice_menu')]])).catch(() => {});
    const m = stakeMenu(uid, ctx.match[1], ctx.match[2]);
    await ctx.reply(m.text, m.extra).catch(() => {});
  });
  bot.action(/^dp:(\w+):(\w+):(\d+)$/, async (ctx) => {
    const uid = String(ctx.from.id);
    if (inFlight.has(uid)) return ctx.answerCbQuery(bt(langOf(uid), 'wait'), { show_alert: false }).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    if (gate && !(await gate(ctx, uid))) return;
    await play(ctx, uid, ctx.match[1], ctx.match[2], parseInt(ctx.match[3], 10));
  });
  bot.action(/^do:(\w+):(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    if (!games.findBet(ctx.match[1], ctx.match[2])) return;
    awaitingStake.set(uid, { game: ctx.match[1], bet: ctx.match[2], at: Date.now() });
    const lang = langOf(uid);
    await ctx.reply(tt(lang, 'ask', { min: E.GAME_BET.min, max: E.GAME_BET.max }), html(null, [[ui.back(lang, `dg:${ctx.match[1]}:${ctx.match[2]}`)]])).catch(() => {});
  });
  hooks.onText.push(async (ctx, uid, text) => {
    const w = awaitingStake.get(uid);
    if (!w) return false;
    awaitingStake.delete(uid);
    if (Date.now() - w.at > 10 * 60000) return false;
    const n = Number(String(text).trim().replace(',', '.'));
    if (!Number.isInteger(n) || n < E.GAME_BET.min || n > E.GAME_BET.max) {
      await ctx.reply(tt(langOf(uid), 'badBet', { min: E.GAME_BET.min, max: E.GAME_BET.max }), html(null, [[ui.back(langOf(uid), `dg:${w.game}:${w.bet}`)]])).catch(() => {});
      return true;
    }
    if (gate && !(await gate(ctx, uid))) return true;
    await play(ctx, uid, w.game, w.bet, n);
    return true;
  });
  hooks.onCommand.push((uid) => awaitingStake.delete(uid));
}

module.exports = { register, menu, resultText };
