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

const T = {
  uk: {
    title: '🎲 <b>Ігри на зірки</b>', balance: 'Баланс: <b>{b}⭐</b>',
    lead: 'Telegram сам кидає кубик — результат чесний, підробити неможливо.\n⚡ Кожна ⭐ ставки — {x} XP до рівня й пасу, навіть якщо не пощастило.\n\nОбери гру:',
    pick: '{e} <b>{t}</b> · {k}\n\nОбери ставку:', slotsK: '777 ×20 · три однакові ×6 · дві сімки ×2',
    own: '✏️ Своя ставка', back: '⬅️ Назад', again: '🔁 Ще раз ({s}⭐)', change: '✏️ Змінити ставку', other: '🎲 Інша гра',
    bank: '🏦 Спільний банк', wheels: '🎰 Колеса', ask: 'Напиши ставку числом — від {min} до {max}⭐.',
    badBet: 'Ставка — ціле число від {min} до {max}⭐.', noStars: 'Замало зірок: ставка {s}⭐, у тебе {b}⭐.', wait: '⏳ Зачекай, попередній кубик ще котиться.',
    won: '🎉 <b>Виграш!</b> {e} {r}\n\n+{p}⭐ (ставка {s}⭐ × {k})\nБаланс: <b>{b}⭐</b>',
    lost: '😔 Не пощастило. {e} {r}\n\nСтавка {s}⭐ згоріла.\nБаланс: <b>{b}⭐</b>', err: '⚠️ Кубик не надіслався — ставку повернуто.',
    topup: '⭐ Поповнити', unknown: 'Ця гра недоступна.',
  },
  en: {
    title: '🎲 <b>Star games</b>', balance: 'Balance: <b>{b}⭐</b>',
    lead: 'Telegram rolls the dice itself — the result is fair and can’t be faked.\n⚡ Every ⭐ you bet gives {x} XP to your level and pass, even if you lose.\n\nPick a game:',
    pick: '{e} <b>{t}</b> · {k}\n\nPick your bet:', slotsK: '777 ×20 · three of a kind ×6 · two sevens ×2',
    own: '✏️ Custom bet', back: '⬅️ Back', again: '🔁 Again ({s}⭐)', change: '✏️ Change bet', other: '🎲 Another game',
    bank: '🏦 Shared bank', wheels: '🎰 Wheels', ask: 'Send your bet as a number — from {min} to {max}⭐.',
    badBet: 'The bet is a whole number from {min} to {max}⭐.', noStars: 'Not enough stars: bet {s}⭐, you have {b}⭐.', wait: '⏳ Wait, the previous dice is still rolling.',
    won: '🎉 <b>You won!</b> {e} {r}\n\n+{p}⭐ (bet {s}⭐ × {k})\nBalance: <b>{b}⭐</b>',
    lost: '😔 No luck. {e} {r}\n\nBet {s}⭐ lost.\nBalance: <b>{b}⭐</b>', err: '⚠️ The dice wasn’t sent — your bet was returned.',
    topup: '⭐ Top up', unknown: 'This game is unavailable.',
  },
  ru: {
    title: '🎲 <b>Игры на звёзды</b>', balance: 'Баланс: <b>{b}⭐</b>',
    lead: 'Telegram сам бросает кубик — результат честный, подделать невозможно.\n⚡ Каждая ⭐ ставки — {x} XP к уровню и пропуску, даже если не повезло.\n\nВыбери игру:',
    pick: '{e} <b>{t}</b> · {k}\n\nВыбери ставку:', slotsK: '777 ×20 · три одинаковых ×6 · две семёрки ×2',
    own: '✏️ Своя ставка', back: '⬅️ Назад', again: '🔁 Ещё раз ({s}⭐)', change: '✏️ Изменить ставку', other: '🎲 Другая игра',
    bank: '🏦 Общий банк', wheels: '🎰 Колёса', ask: 'Напиши ставку числом — от {min} до {max}⭐.',
    badBet: 'Ставка — целое число от {min} до {max}⭐.', noStars: 'Мало звёзд: ставка {s}⭐, у тебя {b}⭐.', wait: '⏳ Подожди, предыдущий кубик ещё катится.',
    won: '🎉 <b>Выигрыш!</b> {e} {r}\n\n+{p}⭐ (ставка {s}⭐ × {k})\nБаланс: <b>{b}⭐</b>',
    lost: '😔 Не повезло. {e} {r}\n\nСтавка {s}⭐ сгорела.\nБаланс: <b>{b}⭐</b>', err: '⚠️ Кубик не отправился — ставка возвращена.',
    topup: '⭐ Пополнить', unknown: 'Эта игра недоступна.',
  },
};
const tt = (lang, k, p) => String((T[lang] || T.uk)[k] || T.uk[k]).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m));

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
    const gm = E.GAMES[g], bt = gm.bets[bid];
    const name = bt.slots ? (gm.title[lang] || gm.title.uk) : (bt.title[lang] || bt.title.uk);
    return ui.cb(gm.emoji + ' ' + name + ' ' + kLabel(bt), 'dg:' + g + ':' + bid, style);
  };
  const rows = [
    [b('dice', 'even', 'primary'), b('dice', 'odd', 'primary')],
    [b('dice', 'high', 'primary'), b('dice', 'low', 'primary')],
    [b('dice', 'six', 'danger')],
    [b('football', 'goal', 'success'), b('football', 'miss', 'success')],
    [b('basket', 'hit', 'success')],
    [b('darts', 'bull', 'danger'), b('bowling', 'strike', 'danger')],
    [b('slots', 'spin', 'danger')],
    [ui.app(tt(lang, 'bank'), 'bank'), ui.app(tt(lang, 'wheels'), 'wheel')],
  ];
  const u = users.get(uid) || {};
  return {
    text: tt(lang, 'title') + '\n\n' + tt(lang, 'balance', { b: fmtStars(users.stars(u)) }) + '\n\n' + tt(lang, 'lead', { x: E.XP_RATES.gamePerStar }),
    extra: { parse_mode: 'HTML', ...ui.kb(rows) },
  };
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
  rows.push([ui.cb(tt(lang, 'own'), `do:${gameId}:${betId}`, 'primary')]);
  if (!opts.length) rows.unshift([ui.app(tt(lang, 'topup'), 'topup', 'success')]);
  rows.push([ui.cb(tt(lang, 'back'), 'dice_menu')]);
  const text = tt(lang, 'pick', { e: f.g.emoji, t: (f.g.title[lang] || f.g.title.uk) + ' — ' + (f.b.title[lang] || f.b.title.uk), k: f.b.slots ? tt(lang, 'slotsK') : '×' + f.b.k }) +
    '\n' + tt(lang, 'balance', { b: fmtStars(bal) });
  return { text, extra: { parse_mode: 'HTML', ...ui.kb(rows) } };
}

async function play(ctx, uid, gameId, betId, stake) {
  const lang = langOf(uid);
  if (inFlight.has(uid)) return ctx.reply(tt(lang, 'wait')).catch(() => {});
  inFlight.add(uid);
  try {
    const st = await games.botStake(uid, gameId, betId, stake);
    if (!st.ok) {
      if (st.error === 'not_enough_stars') {
        return ctx.reply(tt(lang, 'noStars', { s: stake, b: fmtStars(st.have || 0) }), ui.kb([[ui.app(tt(lang, 'topup'), 'topup', 'success')], [ui.cb(tt(lang, 'other'), 'dice_menu')]])).catch(() => {});
      }
      return ctx.reply(st.error === 'bad_bet' ? tt(lang, 'badBet', { min: E.GAME_BET.min, max: E.GAME_BET.max }) : tt(lang, 'unknown')).catch(() => {});
    }
    let dm = null;
    try { dm = await ctx.telegram.sendDice(ctx.chat.id, { emoji: st.emoji }); } catch (e) { dm = null; }
    if (!dm || !dm.dice) { games.botRefund(uid, gameId, st.stake); return ctx.reply(tt(lang, 'err')).catch(() => {}); }
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
      ? tt(lang, 'won', { e, r: esc(res), p: fmtStars(r.payout), s: st.stake, k, b: fmtStars(r.balance) })
      : tt(lang, 'lost', { e, r: esc(res), s: st.stake, b: fmtStars(r.balance) });
    await ctx.reply(text, { parse_mode: 'HTML', reply_to_message_id: dm.message_id, allow_sending_without_reply: true, ...ui.kb([
      [ui.cb(tt(lang, 'again', { s: st.stake }), `dp:${gameId}:${betId}:${st.stake}`, 'success')],
      [ui.cb(tt(lang, 'change'), `dg:${gameId}:${betId}`, 'primary'), ui.cb(tt(lang, 'other'), 'dice_menu')],
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
    if (!games.findBet(ctx.match[1], ctx.match[2])) return ctx.reply(tt(langOf(uid), 'unknown')).catch(() => {});
    const m = stakeMenu(uid, ctx.match[1], ctx.match[2]);
    await ctx.reply(m.text, m.extra).catch(() => {});
  });
  bot.action(/^dp:(\w+):(\w+):(\d+)$/, async (ctx) => {
    const uid = String(ctx.from.id);
    if (inFlight.has(uid)) return ctx.answerCbQuery(tt(langOf(uid), 'wait'), { show_alert: false }).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    if (gate && !(await gate(ctx, uid))) return;
    await play(ctx, uid, ctx.match[1], ctx.match[2], parseInt(ctx.match[3], 10));
  });
  bot.action(/^do:(\w+):(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    if (!games.findBet(ctx.match[1], ctx.match[2])) return;
    awaitingStake.set(uid, { game: ctx.match[1], bet: ctx.match[2], at: Date.now() });
    await ctx.reply(tt(langOf(uid), 'ask', { min: E.GAME_BET.min, max: E.GAME_BET.max })).catch(() => {});
  });
  hooks.onText.push(async (ctx, uid, text) => {
    const w = awaitingStake.get(uid);
    if (!w) return false;
    awaitingStake.delete(uid);
    if (Date.now() - w.at > 10 * 60000) return false;
    const n = Number(String(text).trim().replace(',', '.'));
    if (!Number.isInteger(n) || n < E.GAME_BET.min || n > E.GAME_BET.max) {
      await ctx.reply(tt(langOf(uid), 'badBet', { min: E.GAME_BET.min, max: E.GAME_BET.max })).catch(() => {});
      return true;
    }
    if (gate && !(await gate(ctx, uid))) return true;
    await play(ctx, uid, w.game, w.bet, n);
    return true;
  });
  hooks.onCommand.push((uid) => awaitingStake.delete(uid));
}

module.exports = { register, menu, resultText };
