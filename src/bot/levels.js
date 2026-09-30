// ==========================================================================
// РІВНІ В БОТІ. Замість одного довгого повідомлення — коротка картка з
// фото рівня й мотивацією, а подробиці на окремих сторінках (гортаються в
// тому самому повідомленні, без спаму):
//   🏅 Мій рівень      — де я, скільки до наступного, що він дасть, скільки
//                         XP ще можна набрати сьогодні, скількох я обганяю
//   ⚡ Як швидко апнути — за що XP і скільки лишилось на сьогодні + порада
//   👑 Мої привілеї     — що діє зараз і що відкриється далі
//   📈 Усі рівні        — сходинки по 5 на сторінку
// Картинки — web/img/levels (малює scripts/render-level-images.js).
// ==========================================================================
const fs = require('fs');
const path = require('path');
const E = require('../economy');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const i18n = require('../i18n');
const ui = require('./ui');
const { esc } = require('../lib/util');
const { withEmoji } = require('../emoji');

const T = {
  uk: {
    title: 'МІЙ РІВЕНЬ', lv: '{e} <b>{t}</b> — рівень {n} з {max}', xpLine: '{bar} <b>{xp}</b> / {to} XP',
    goal: '{:lightning} <b>Ще {left} XP — і ти {e} {t}!</b>', reward: '{:giftBox} Нагорода: <b>{reward}</b>', unlock: '{:starIcon} Відкриєш: <b>{list}</b>',
    today: '{:almost} Сьогодні ще можна набрати <b>до {n} XP</b>', todayOk: '— цього вистачить на новий рівень <b>уже сьогодні!</b>', todayNo: '— рівень ближче з кожною грою.',
    rank: '{:trophy} Ти випереджаєш <b>{p}%</b> гравців', top: '{:trophy} Ти на вершині — найвищий рівень StarForge!', topSub: 'Усі привілеї відкрито: вивід без комісії й +10% до кожного поповнення.',
    how: 'ЯК ШВИДКО АПНУТИ', perksB: 'МОЇ ПРИВІЛЕЇ', allB: 'УСІ РІВНІ', play: '🎲 ГРАТИ Й КАЧАТИСЬ', toLevel: 'ДО РІВНЯ',
    btn: 'РІВЕНЬ {n} · {e} {t}',
    hTitle: 'ЯК ШВИДКО АПНУТИ', hLead: 'За що дають XP і скільки ще можна набрати <b>сьогодні</b>:',
    hSpin: '🎰 Спін колеса: <b>+{per} XP</b> · лишилось {left} з {cap}', hWager: '🎲 Ставки (ігри, банк, платні спіни): <b>+{g} XP</b> за ⭐ · лишилось {left} з {cap}',
    hBank: '🏦 Перша ставка в банк: <b>+{per} XP</b>', hChat: '💬 Повідомлення в чаті: <b>+1 XP</b> · лишилось {left} з {cap}',
    hFriend: '👥 Друг: <b>+{per} XP</b> · лишилось {left} з {cap}', hDeposit: '💳 Поповнення: <b>+{per} XP</b>', hQuest: '📋 Завдання, питання дня, промокоди · лишилось {left} з {cap}',
    tip: '{:check} <b>Порада:</b> {text}', tipSpins: 'лише {k} спінів колеса — і новий рівень!', tipMix: '{k} спінів + ставки на {s}⭐ в іграх — і новий рівень уже сьогодні!',
    tipLong: 'набирай скільки встигнеш — XP не згорає, а рівень лишається назавжди.', xpFoot: 'Ліміти на день оновлюються опівночі за Києвом.',
    games: 'ІГРИ', wheels: 'КОЛЕСА', bank: 'БАНК', friends: 'ДРУЗІ',
    pTitle: 'МОЇ ПРИВІЛЕЇ', pNow: '<b>Діють зараз</b> ({e} {t}):', fee: '{:commission} Комісія виводу: <b>{f}%</b>', feeBase: ' (звичайна {b}%)',
    topupOn: '{:starIcon} Бонус до кожного поповнення: <b>+{p}%</b>', topupOff: '{:lockIcon} Бонус до кожного поповнення — з рівня {n}',
    chatOn: '{:giftBox} Щоденний бонус у чаті: <b>+{n}🎫</b>', chatOff: '{:lockIcon} Більший бонус у чаті — з рівня {n}',
    pNext: '<b>Що відкриється далі:</b>', pNextLine: '{:lightning} {e} <b>{t}</b> (рівень {n}, ще {left} XP) — {list}', pAll: '{:trophy} Усі привілеї вже твої!',
    aTitle: 'УСІ РІВНІ', aLine: '{mark} <b>{n}. {e} {t}</b> · {at} XP', aSub: '      {list}', aFoot: 'Нагорода за рівень видається один раз, привілеї діють назавжди.',
  },
  en: {
    title: 'MY LEVEL', lv: '{e} <b>{t}</b> — level {n} of {max}', xpLine: '{bar} <b>{xp}</b> / {to} XP',
    goal: '{:lightning} <b>{left} XP more — and you are {e} {t}!</b>', reward: '{:giftBox} Reward: <b>{reward}</b>', unlock: '{:starIcon} Unlocks: <b>{list}</b>',
    today: '{:almost} You can still earn <b>up to {n} XP</b> today', todayOk: '— enough for a new level <b>today!</b>', todayNo: '— every game brings the level closer.',
    rank: '{:trophy} You are ahead of <b>{p}%</b> of players', top: '{:trophy} You are at the top — the highest StarForge level!', topSub: 'All perks unlocked: fee-free withdrawals and +10% on every top-up.',
    how: 'HOW TO LEVEL UP FAST', perksB: 'MY PERKS', allB: 'ALL LEVELS', play: '🎲 PLAY AND LEVEL UP', toLevel: 'TO MY LEVEL',
    btn: 'LEVEL {n} · {e} {t}',
    hTitle: 'HOW TO LEVEL UP FAST', hLead: 'What gives XP and how much you can still earn <b>today</b>:',
    hSpin: '🎰 Wheel spin: <b>+{per} XP</b> · {left} of {cap} left', hWager: '🎲 Bets (games, bank, paid spins): <b>+{g} XP</b> per ⭐ · {left} of {cap} left',
    hBank: '🏦 First bet in the bank: <b>+{per} XP</b>', hChat: '💬 Chat message: <b>+1 XP</b> · {left} of {cap} left',
    hFriend: '👥 Friend: <b>+{per} XP</b> · {left} of {cap} left', hDeposit: '💳 Top-up: <b>+{per} XP</b>', hQuest: '📋 Quests, question of the day, promo codes · {left} of {cap} left',
    tip: '{:check} <b>Tip:</b> {text}', tipSpins: 'just {k} wheel spins — and a new level!', tipMix: '{k} spins + bets of {s}⭐ in games — and a new level today!',
    tipLong: 'earn what you can — XP never resets and your level stays forever.', xpFoot: 'Daily limits reset at midnight Kyiv time.',
    games: 'GAMES', wheels: 'WHEELS', bank: 'BANK', friends: 'FRIENDS',
    pTitle: 'MY PERKS', pNow: '<b>Active now</b> ({e} {t}):', fee: '{:commission} Withdrawal fee: <b>{f}%</b>', feeBase: ' (normally {b}%)',
    topupOn: '{:starIcon} Bonus on every top-up: <b>+{p}%</b>', topupOff: '{:lockIcon} Bonus on every top-up — from level {n}',
    chatOn: '{:giftBox} Daily chat bonus: <b>+{n}🎫</b>', chatOff: '{:lockIcon} Bigger chat bonus — from level {n}',
    pNext: '<b>Unlocking next:</b>', pNextLine: '{:lightning} {e} <b>{t}</b> (level {n}, {left} XP to go) — {list}', pAll: '{:trophy} Every perk is already yours!',
    aTitle: 'ALL LEVELS', aLine: '{mark} <b>{n}. {e} {t}</b> · {at} XP', aSub: '      {list}', aFoot: 'The level reward is paid once, perks stay forever.',
  },
  ru: {
    title: 'МОЙ УРОВЕНЬ', lv: '{e} <b>{t}</b> — уровень {n} из {max}', xpLine: '{bar} <b>{xp}</b> / {to} XP',
    goal: '{:lightning} <b>Ещё {left} XP — и ты {e} {t}!</b>', reward: '{:giftBox} Награда: <b>{reward}</b>', unlock: '{:starIcon} Откроешь: <b>{list}</b>',
    today: '{:almost} Сегодня ещё можно набрать <b>до {n} XP</b>', todayOk: '— этого хватит на новый уровень <b>уже сегодня!</b>', todayNo: '— уровень ближе с каждой игрой.',
    rank: '{:trophy} Ты опережаешь <b>{p}%</b> игроков', top: '{:trophy} Ты на вершине — высший уровень StarForge!', topSub: 'Все привилегии открыты: вывод без комиссии и +10% к каждому пополнению.',
    how: 'КАК БЫСТРО АПНУТЬ', perksB: 'МОИ ПРИВИЛЕГИИ', allB: 'ВСЕ УРОВНИ', play: '🎲 ИГРАТЬ И КАЧАТЬСЯ', toLevel: 'К УРОВНЮ',
    btn: 'УРОВЕНЬ {n} · {e} {t}',
    hTitle: 'КАК БЫСТРО АПНУТЬ', hLead: 'За что дают XP и сколько ещё можно набрать <b>сегодня</b>:',
    hSpin: '🎰 Спин колеса: <b>+{per} XP</b> · осталось {left} из {cap}', hWager: '🎲 Ставки (игры, банк, платные спины): <b>+{g} XP</b> за ⭐ · осталось {left} из {cap}',
    hBank: '🏦 Первая ставка в банк: <b>+{per} XP</b>', hChat: '💬 Сообщение в чате: <b>+1 XP</b> · осталось {left} из {cap}',
    hFriend: '👥 Друг: <b>+{per} XP</b> · осталось {left} из {cap}', hDeposit: '💳 Пополнение: <b>+{per} XP</b>', hQuest: '📋 Задания, вопрос дня, промокоды · осталось {left} из {cap}',
    tip: '{:check} <b>Совет:</b> {text}', tipSpins: 'всего {k} спинов колеса — и новый уровень!', tipMix: '{k} спинов + ставки на {s}⭐ в играх — и новый уровень уже сегодня!',
    tipLong: 'набирай сколько успеешь — XP не сгорает, а уровень остаётся навсегда.', xpFoot: 'Лимиты на день обновляются в полночь по Киеву.',
    games: 'ИГРЫ', wheels: 'КОЛЁСА', bank: 'БАНК', friends: 'ДРУЗЬЯ',
    pTitle: 'МОИ ПРИВИЛЕГИИ', pNow: '<b>Действуют сейчас</b> ({e} {t}):', fee: '{:commission} Комиссия вывода: <b>{f}%</b>', feeBase: ' (обычная {b}%)',
    topupOn: '{:starIcon} Бонус к каждому пополнению: <b>+{p}%</b>', topupOff: '{:lockIcon} Бонус к каждому пополнению — с уровня {n}',
    chatOn: '{:giftBox} Ежедневный бонус в чате: <b>+{n}🎫</b>', chatOff: '{:lockIcon} Больше бонус в чате — с уровня {n}',
    pNext: '<b>Что откроется дальше:</b>', pNextLine: '{:lightning} {e} <b>{t}</b> (уровень {n}, ещё {left} XP) — {list}', pAll: '{:trophy} Все привилегии уже твои!',
    aTitle: 'ВСЕ УРОВНИ', aLine: '{mark} <b>{n}. {e} {t}</b> · {at} XP', aSub: '      {list}', aFoot: 'Награда за уровень выдаётся один раз, привилегии действуют навсегда.',
  },
};
const langOf = (u) => (u && T[u.lang] ? u.lang : 'uk');
const fill = (lang, k, p) => String((T[lang] || T.uk)[k] || T.uk[k]).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m));
const tt = (lang, k, p) => withEmoji(fill(lang, k, p));     // текст повідомлення з преміум-емодзі
const bt = fill;                                           // підпис кнопки

function rewardText(rw) {
  return [rw && rw.tickets ? '+' + rw.tickets + '🎫' : null, rw && rw.stars ? '+' + rw.stars + '⭐' : null].filter(Boolean).join(' ');
}
// Що відкриває рівень: «комісія виводу 3% · +2% до кожного поповнення».
function unlockText(lang, un) {
  const out = [];
  if (un.withdrawFee != null) out.push(i18n.t(lang, 'perk.fee', { f: un.withdrawFee }));
  if (un.topupBonus != null) out.push(i18n.t(lang, 'perk.topup', { p: un.topupBonus }));
  if (un.chatBonus != null) out.push(i18n.t(lang, 'perk.chat', { n: un.chatBonus }));
  return out.join(' · ');
}
const firstLevelWith = (key) => { const x = E.LEVEL_PERKS[key].find(([, v]) => v > 0); return x ? x[0] : null; };
const bar = (pct) => { const k = Math.round(Math.max(0, Math.min(100, pct)) / 10); return '▰'.repeat(k) + '▱'.repeat(10 - k); };

// Що відкрилось на рівнях from…to (стрибок може бути на кілька рівнів).
function unlockedBetween(from, to) {
  const out = {};
  for (let n = from || to; n <= to; n++) Object.assign(out, E.perksUnlockedAt(n));
  return out;
}

// ─── Фото ───────────────────────────────────────────────────────────────
// Файл вантажимо в Telegram один раз, далі шлемо за file_id.
const IMG_DIR = path.join(__dirname, '..', '..', 'web', 'img', 'levels');
const fileIds = new Map();
const imgFor = (n) => 'lvl-' + Math.max(1, Math.min(E.LEVELS.length, n)) + '.jpg';
const hasImg = (name) => fileIds.has(name) || fs.existsSync(path.join(IMG_DIR, name));
const media = (name) => fileIds.get(name) || { source: path.join(IMG_DIR, name) };
function remember(name, msg) {
  const ph = msg && msg.photo;
  if (Array.isArray(ph) && ph.length && ph[ph.length - 1].file_id) fileIds.set(name, ph[ph.length - 1].file_id);
}

// ─── Скільки XP ще можна набрати сьогодні ───────────────────────────────
function todayLeft(u) {
  const src = (progress.view(u).today) || {};
  const left = (k) => Math.max(0, Math.round((E.XP[k].dayCap || 0) - (src[k] || 0)));
  return { spin: left('spin'), wager: left('wager'), chat: left('chat'), friend: left('friend'), quest: left('quest') };
}
// Скількох гравців випереджає (за загальним XP).
function aheadPercent(uid) {
  const me = progress.xpOf(users.get(uid) || {}).total;
  let n = 0, lower = 0;
  for (const u of Object.values(users.all())) {
    if (!u || !u.lang || users.isAdmin(u.id) || String(u.id) === String(uid)) continue;
    n++;
    if (progress.xpOf(u).total < me) lower++;
  }
  return n ? Math.round(lower / n * 100) : 100;
}

// ─── Сторінки ───────────────────────────────────────────────────────────
const toLevelRow = (lang) => [ui.cb(bt(lang, 'toLevel'), 'lv:main', undefined, 'back')];

function mainPage(uid) {
  const u = users.get(uid) || {};
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  const lines = [tt(lang, 'lv', { e: lv.e, t: esc(lv.t), n: lv.n, max: lv.max })];
  if (lv.next) {
    lines.push(tt(lang, 'xpLine', { bar: bar(lv.pct), xp: Math.floor(lv.xp), to: lv.next.at }), '');
    lines.push(tt(lang, 'goal', { left: Math.ceil(lv.next.left), e: lv.next.e, t: esc(lv.next.t) }));
    if (rewardText(lv.next.reward)) lines.push(tt(lang, 'reward', { reward: rewardText(lv.next.reward) }));
    const un = unlockText(lang, lv.next.unlocks);
    if (un) lines.push(tt(lang, 'unlock', { list: un }));
    const d = todayLeft(u);
    const can = d.spin + d.wager + d.chat;       // те, що точно доступне сьогодні (завдань може й не бути)
    if (can > 0) lines.push('', tt(lang, 'today', { n: can }) + ' ' + tt(lang, can >= lv.next.left ? 'todayOk' : 'todayNo'));
    lines.push(tt(lang, 'rank', { p: aheadPercent(uid) }));
  } else {
    lines.push('', tt(lang, 'top'), esc(bt(lang, 'topSub')));
  }
  return {
    img: imgFor(lv.n),
    caption: ui.card('crown', tt(lang, 'title'), lines),
    rows: [
      lv.next ? [ui.cb(bt(lang, 'how'), 'lv:how', 'danger', 'lightning')] : null,
      [ui.cb(bt(lang, 'perksB'), 'lv:perks', 'primary', 'crown'), ui.cb(bt(lang, 'allB'), 'lv:all', 'primary', 'statsIcon')],
      [ui.cb(bt(lang, 'play'), 'dice_menu', 'success', 'starIcon')],
      [ui.back(lang)],
    ],
  };
}

function howPage(uid) {
  const u = users.get(uid) || {};
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  const d = todayLeft(u);
  const X = E.XP;
  const lines = [tt(lang, 'hLead'), '',
    tt(lang, 'hSpin', { per: X.spin.per, left: d.spin, cap: X.spin.dayCap }),
    tt(lang, 'hWager', { g: E.XP_RATES.gamePerStar, left: d.wager, cap: X.wager.dayCap }),
    tt(lang, 'hBank', { per: X.bank.per }),
    tt(lang, 'hChat', { left: d.chat, cap: X.chat.dayCap }),
    tt(lang, 'hFriend', { per: X.friend.per, left: d.friend, cap: X.friend.dayCap }),
    tt(lang, 'hDeposit', { per: X.deposit.per }),
    tt(lang, 'hQuest', { left: d.quest, cap: X.quest.dayCap }),
  ];
  if (lv.next) {
    const need = Math.ceil(lv.next.left);
    const spinsNeed = Math.ceil(need / X.spin.per);
    let tip;
    if (need <= d.spin) tip = bt(lang, 'tipSpins', { k: spinsNeed });
    else if (need <= d.spin + d.wager) tip = bt(lang, 'tipMix', { k: Math.floor(d.spin / X.spin.per), s: Math.ceil((need - d.spin) / E.XP_RATES.gamePerStar) });
    else tip = bt(lang, 'tipLong');
    lines.push('', tt(lang, 'tip', { text: tip }));
  }
  return {
    img: 'xp.jpg',
    caption: ui.card('lightning', tt(lang, 'hTitle'), lines, bt(lang, 'xpFoot')),
    rows: [
      [ui.cb('🎲 ' + bt(lang, 'games'), 'dice_menu', 'success'), ui.app(bt(lang, 'wheels'), 'wheel', 'success', 'rocket')],
      [ui.cb(bt(lang, 'bank'), 'bank_show', 'primary', 'almost'), ui.cb(bt(lang, 'friends'), 'rewards', 'primary', 'giftBox')],
      toLevelRow(lang),
    ],
  };
}

function perksPage(uid) {
  const u = users.get(uid) || {};
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  const p = lv.perks;
  const lines = [tt(lang, 'pNow', { e: lv.e, t: esc(lv.t) }),
    tt(lang, 'fee', { f: p.withdrawFee }) + (p.withdrawFee < E.WITHDRAW.feePercent ? tt(lang, 'feeBase', { b: E.WITHDRAW.feePercent }) : ''),
    p.topupBonus ? tt(lang, 'topupOn', { p: p.topupBonus }) : tt(lang, 'topupOff', { n: firstLevelWith('topupBonus') }),
    p.chatBonus ? tt(lang, 'chatOn', { n: p.chatBonus }) : tt(lang, 'chatOff', { n: firstLevelWith('chatBonus') }),
    '',
  ];
  // Найближчі три рівні, що відкривають щось нове.
  const next = progress.ladder(u, lang).filter(L => !L.reached && Object.keys(L.unlocks).length).slice(0, 3);
  const tot = progress.xpOf(u).total;
  if (next.length) {
    lines.push(tt(lang, 'pNext'));
    for (const L of next) lines.push(tt(lang, 'pNextLine', { e: L.e, t: esc(L.t), n: L.n, left: Math.ceil(L.at - tot), list: unlockText(lang, L.unlocks) }));
  } else lines.push(tt(lang, 'pAll'));
  return {
    img: imgFor(next.length ? next[0].n : lv.n),
    caption: ui.card('crown', tt(lang, 'pTitle'), lines),
    rows: [lv.next ? [ui.cb(bt(lang, 'how'), 'lv:how', 'danger', 'lightning')] : null, toLevelRow(lang)],
  };
}

const PER_PAGE = 5;
function allPage(uid, page) {
  const u = users.get(uid) || {};
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  const pages = Math.ceil(E.LEVELS.length / PER_PAGE);
  const pg = page == null ? Math.floor((lv.n - 1) / PER_PAGE) : Math.max(0, Math.min(pages - 1, page));
  const mk = { cur: withEmoji('{:lightning}'), done: withEmoji('{:check}'), lock: withEmoji('{:lockIcon}') };
  const lines = [];
  for (const L of progress.ladder(u, lang).slice(pg * PER_PAGE, pg * PER_PAGE + PER_PAGE)) {
    const mark = L.n === lv.n ? mk.cur : L.reached ? mk.done : mk.lock;
    lines.push(tt(lang, 'aLine', { mark, n: L.n, e: L.e, t: esc(L.t), at: L.at }));
    const extra = [rewardText(L.reward), unlockText(lang, L.unlocks)].filter(Boolean).join(' · ');
    if (extra) lines.push(tt(lang, 'aSub', { list: extra }));
  }
  return {
    img: 'ladder.jpg',
    caption: ui.card('statsIcon', tt(lang, 'aTitle') + ' · ' + (pg + 1) + '/' + pages, lines, bt(lang, 'aFoot')),
    rows: [
      [pg > 0 ? ui.cb('◀️', 'lv:all:' + (pg - 1)) : null, ui.cb((pg + 1) + ' / ' + pages, 'lv:all:' + pg), pg < pages - 1 ? ui.cb('▶️', 'lv:all:' + (pg + 1)) : null],
      toLevelRow(lang),
    ],
  };
}

// Надіслати сторінку новим повідомленням (фото з підписом; без картинки — текстом).
async function sendPage(ctx, p) {
  const extra = { parse_mode: 'HTML', ...ui.kb(p.rows) };
  if (hasImg(p.img)) {
    try { const m = await ctx.replyWithPhoto(media(p.img), { caption: p.caption, ...extra }); remember(p.img, m); return; } catch (e) { /* далі текстом */ }
  }
  await ctx.reply(p.caption, extra).catch(() => {});
}
// Перегорнути сторінку в тому самому повідомленні.
async function editPage(ctx, p) {
  const extra = ui.kb(p.rows);
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  if (msg && msg.photo && hasImg(p.img)) {
    try {
      const m = await ctx.editMessageMedia({ type: 'photo', media: media(p.img), caption: p.caption, parse_mode: 'HTML' }, extra);
      remember(p.img, m);
      return;
    } catch (e) {
      if (/not modified/i.test(String(e && e.message))) return;
    }
  }
  if (msg && !msg.photo) {
    try { await ctx.editMessageText(p.caption, { parse_mode: 'HTML', ...extra }); return; } catch (e) { if (/not modified/i.test(String(e && e.message))) return; }
  }
  await sendPage(ctx, p);
}

// «🎉 НОВИЙ РІВЕНЬ!» — текст. rw — сума нагород за всі пройдені рівні.
function levelUpText(lang, info, rw, fromN) {
  const un = unlockText(lang, unlockedBetween(fromN, info.n));
  const nx = info.next;
  const next = nx
    ? i18n.t(lang, 'level.next', { e: nx.e, t: esc(nx.t), left: Math.ceil(nx.left), reward: rewardText(nx.reward) || '—', perks: unlockText(lang, nx.unlocks) ? ' · ' + unlockText(lang, nx.unlocks) : '' })
    : i18n.t(lang, 'level.max');
  return i18n.t(lang, 'level.up', {
    e: info.e, t: esc(info.t), n: info.n, max: E.LEVELS.length, reward: rewardText(rw) || '—',
    perks: un ? i18n.t(lang, 'level.perks', { list: un }) : '', next,
  });
}
// Новий рівень — особисте повідомлення з картинкою рівня.
async function sendLevelUp(uid, lang, info, rw, fromN) {
  const caption = levelUpText(lang, info, rw, fromN);
  const extra = notify.appKeyboard(i18n.t(lang, 'btn.open'), 'progress', [[ui.cb(i18n.t(lang, 'btn.levels'), 'lv:perks', 'primary', 'crown')]]);
  const img = imgFor(info.n);
  if (hasImg(img) && notify.tg.telegram) {
    const m = await notify.photo(uid, media(img), { caption, ...extra });
    if (m) { remember(img, m); return m; }
  }
  return notify.dm(uid, caption, extra);
}

function menuButton(u) {
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  return ui.cb(bt(lang, 'btn', { n: lv.n, e: lv.e, t: String(lv.t).toUpperCase() }), 'my_level', 'primary', 'crown');
}

function register(bot) {
  const priv = (ctx) => !ctx.chat || ctx.chat.type === 'private';
  const show = async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    users.ensure(ctx.from);
    const uid = String(ctx.from.id);
    await sendPage(ctx, mainPage(uid));
    await require('./menu').ensureBackKeyboard(ctx, uid);
  };
  bot.command(['level', 'levels', 'perks'], show);
  bot.action('my_level', show);
  bot.action(/^lv:(main|how|perks|all)(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    const k = ctx.match[1];
    const p = k === 'how' ? howPage(uid) : k === 'perks' ? perksPage(uid) : k === 'all' ? allPage(uid, ctx.match[2] != null ? Number(ctx.match[2]) : null) : mainPage(uid);
    await editPage(ctx, p);
  });
}

module.exports = { register, mainPage, howPage, perksPage, allPage, levelUpText, sendLevelUp, menuButton, rewardText, unlockedBetween };
