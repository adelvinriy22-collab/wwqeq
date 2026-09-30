// ==========================================================================
// ГОЛОВНЕ МЕНЮ В БОТІ — як у попередній версії: нагороди за друзів, ігри,
// спільний банк, поповнення, профіль, промокод, заявки, налаштування,
// активні розіграші й події. Усе те саме є й у застосунку.
//
// Оформлення — як у старому боті: преміум-емодзі в тексті ({:ключ} → анімований
// емодзі з src/emoji.js), кольорові кнопки великими літерами з преміум-іконкою,
// на кожному екрані «🔙 НАЗАД», а під полем вводу — постійна кнопка «Назад».
// ==========================================================================
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const time = require('../lib/time');
const bank = require('../features/bank');
const wallet = require('../features/wallet');
const profile = require('../features/profile');
const referrals = require('../features/referrals');
const applications = require('../features/applications');
const ui = require('./ui');
const { EMOJI, withEmoji } = require('../emoji');
const { esc, fmtStars } = require('../lib/util');

const T = {
  uk: {
    hi: '{:lightning} <b>Привіт, {name}!</b>', lead: 'Колеса удачі, ігри на зірки, спільний банк і <b>справжні Telegram-подарунки</b> {:giftBox}',
    bal: '{:starIcon} Баланс: <b>{s}</b> ⭐', tix: '🎫 Білети: <b>{t}</b>', lvl: '{:crown} Рівень {n}: <b>{e} {title}</b>',
    bankLine: '{:almost} У банку <b>{p}⭐</b> — розіграш {when}', tease: '<i>А що буде далі...</i> {:eye}',
    open: 'ВІДКРИТИ STARFORGE', rewards: 'МОЇ НАГОРОДИ', games: '🎲 ІГРИ НА ЗІРКИ', bank: '🏦 СПІЛЬНИЙ БАНК — {p}⭐', topup: 'ПОПОВНИТИ БАЛАНС',
    profile: 'МІЙ ПРОФІЛЬ', promo: 'ПРОМОКОД', withdraw: 'ВИВЕСТИ ЗІРКИ', settings: '⚙️ НАЛАШТУВАННЯ', apps: 'МОЇ ЗАЯВКИ',
    giveaway: 'РОЗІГРАШ: {n}', extref: 'ШАНС НА МІШКУ ({w}/{m})', event: 'ПОДІЯ: ЗАПРОСИ ДРУЗІВ', admin: 'АДМІН-ПАНЕЛЬ',
    rwTitle: 'МОЇ НАГОРОДИ', rwInvited: '👥 Запрошено друзів: <b>{n}</b>', rwLink: '{:lightning} Твоє посилання:',
    rwFoot: 'Друг рахується, коли підписався на канал. Кожна сходинка — один раз, видача вручну.',
    share: 'ПОДІЛИТИСЯ ПОСИЛАННЯМ', claim: 'ЗАБРАТИ: {name}', stDone: '{:check} видано', stPend: '{:pendingIcon} в черзі', stRej: '{:redCircle} відхилено', stOk: '{:greenCircle} <b>можна забрати!</b>', stLock: '{:lockIcon} ще {n}',
    claimed: '{:check} <b>Заявку #{id} створено</b>\n{name} — видамо найближчим часом.', claimErr: { already: 'Заявка на цей приз уже є.', need_username: 'Спершу додай @username у налаштуваннях Telegram.', not_enough_friends: 'Поки не вистачає друзів.' },
    pfTitle: 'МІЙ ПРОФІЛЬ', pfSpins: '🎰 Спінів: <b>{spins}</b> (платних {paid})', pfPrizes: '{:giftBox} Призів: <b>{prizes}</b>', pfBest: '{:trophy} Найкращий виграш: <b>{best}</b>',
    pfBal: '{:starIcon} Баланс: <b>{s}⭐</b> · 🎫 <b>{t}</b>', pfEarned: '{:statsIcon} Виграно за весь час: <b>{earned}⭐</b>', pfGames: '🎲 Ігор: <b>{games}</b>',
    pfStreak: '{:almost} Серія: <b>{streak}</b> дн. (рекорд {best2})', pfFriends: '👥 Друзів: <b>{friends}</b>', pfLvl: '{:crown} {lvl} · {xp} XP',
    lastWins: '{:inventoryBag} <b>Останні виграші:</b>', nothing: 'ще нічого',
    apTitle: 'МОЇ ЗАЯВКИ', apNone: 'Тут поки порожньо.', fPend: 'В ЧЕРЗІ', fOk: 'ВИДАНІ', fRej: 'ВІДХИЛЕНІ',
    stTitle: 'НАЛАШТУВАННЯ', stLead: 'Тут можна змінити мову, анонімність і сповіщення.',
    lang: 'МОВА: {l}', anon: 'АНОНІМНО В ТАБЛИЦЯХ: {v}', ref: 'ПРО НОВИХ ДРУЗІВ: {v}', rem: 'НАГАДУВАННЯ ПРО СПІН: {v}', on: 'ТАК', off: 'НІ',
    bkTitle: 'СПІЛЬНИЙ БАНК', bkNone: 'Зараз банку немає — новий відкриється скоро.', bkPot: '{:starIcon} У банку: <b>{p}⭐</b>{tx}', bkPlayers: '👥 Учасників: <b>{n}</b>',
    bkWhen: '{:clockIcon} Розіграш: <b>{when}</b> (через {left})', bkMine: '{:check} Твоя ставка: <b>{w}</b> → шанс <b>{c}%</b>', bkNotIn: '{:lightning} Ти ще не в грі — що більша ставка, то більший твій сектор.',
    bkTop: '{:trophy} <b>Сектори:</b>', bkFoot: 'Колесо крутиться один раз — переможець забирає весь банк. Кожен учасник отримує втішні білети.',
    bkOwn: 'СВОЯ СТАВКА', bkApp: 'КОЛЕСО БАНКУ', bkAsk: '{:starIcon} Напиши ставку зірками числом.\nБаланс: <b>{b}⭐</b>',
    bkOk: '{:check} Поставлено <b>{s}⭐</b>\nШанс: <b>{c}%</b> · банк: <b>{p}⭐</b>', bkErr: { no_bank: 'Зараз розіграшу немає.', too_late: 'Прийом ставок закрито — колесо ось-ось крутиться.', not_enough_stars: 'Замало зірок.', bad_amount: 'Вкажи ставку числом.' },
    tpTitle: 'ПОПОВНЕННЯ', tpBal: '{:starIcon} Баланс: <b>{b}⭐</b>', tpLead: 'Оплата — реальними Telegram Stars, зараховується одразу.',
    tpBonus: '{:giftBox} Бонус <b>+{p}%</b> ще на {n} поповнення.', tpLvl: '{:crown} Бонус твого рівня: <b>+{p}%</b> до кожного поповнення.', tpPick: 'Обери суму 👇', tpOwn: 'СВОЯ СУМА',
    tpAsk: '{:starIcon} Напиши суму числом, наприклад <code>75</code>.', tpPay: 'ОПЛАТИТИ {a}⭐', tpReady: '{:check} Рахунок на <b>{a}⭐</b> готовий:', tpErr: 'Не вдалось створити рахунок, спробуй ще раз.',
    evTitle: 'ПОДІЯ: ЗАПРОСИ ДРУЗІВ', evWhen: '{:clockIcon} До {when}', evMine: '👥 Твоїх нових друзів: <b>{mine}</b>', evFoot: 'Топ-3 отримають 🚀 Ракету, 🎁 Подарунок і 🧸 Мішку.',
    wdLead: '{:withdrawBox} Вивід зірок — у застосунку: там видно комісію й умови.',
    backHint: '👇 Кнопка «Назад» унизу завжди поверне в меню', backKey: 'Назад',
  },
  en: {
    hi: '{:lightning} <b>Hi, {name}!</b>', lead: 'Wheels of luck, star games, a shared bank and <b>real Telegram gifts</b> {:giftBox}',
    bal: '{:starIcon} Balance: <b>{s}</b> ⭐', tix: '🎫 Tickets: <b>{t}</b>', lvl: '{:crown} Level {n}: <b>{e} {title}</b>',
    bankLine: '{:almost} The bank holds <b>{p}⭐</b> — draw {when}', tease: '<i>What comes next...</i> {:eye}',
    open: 'OPEN STARFORGE', rewards: 'MY REWARDS', games: '🎲 STAR GAMES', bank: '🏦 SHARED BANK — {p}⭐', topup: 'TOP UP',
    profile: 'MY PROFILE', promo: 'PROMO CODE', withdraw: 'WITHDRAW STARS', settings: '⚙️ SETTINGS', apps: 'MY REQUESTS',
    giveaway: 'GIVEAWAY: {n}', extref: 'TEDDY CHANCE ({w}/{m})', event: 'EVENT: INVITE FRIENDS', admin: 'ADMIN PANEL',
    rwTitle: 'MY REWARDS', rwInvited: '👥 Friends invited: <b>{n}</b>', rwLink: '{:lightning} Your link:',
    rwFoot: 'A friend counts once subscribed to the channel. Each step once, sent manually.',
    share: 'SHARE THE LINK', claim: 'CLAIM: {name}', stDone: '{:check} sent', stPend: '{:pendingIcon} queued', stRej: '{:redCircle} rejected', stOk: '{:greenCircle} <b>claim it!</b>', stLock: '{:lockIcon} {n} more',
    claimed: '{:check} <b>Request #{id} created</b>\n{name} — we’ll send it soon.', claimErr: { already: 'You already have a request for this prize.', need_username: 'Add a @username in Telegram settings first.', not_enough_friends: 'Not enough friends yet.' },
    pfTitle: 'MY PROFILE', pfSpins: '🎰 Spins: <b>{spins}</b> ({paid} paid)', pfPrizes: '{:giftBox} Prizes: <b>{prizes}</b>', pfBest: '{:trophy} Best win: <b>{best}</b>',
    pfBal: '{:starIcon} Balance: <b>{s}⭐</b> · 🎫 <b>{t}</b>', pfEarned: '{:statsIcon} Won in total: <b>{earned}⭐</b>', pfGames: '🎲 Games: <b>{games}</b>',
    pfStreak: '{:almost} Streak: <b>{streak}</b> days (best {best2})', pfFriends: '👥 Friends: <b>{friends}</b>', pfLvl: '{:crown} {lvl} · {xp} XP',
    lastWins: '{:inventoryBag} <b>Latest wins:</b>', nothing: 'nothing yet',
    apTitle: 'MY REQUESTS', apNone: 'Nothing here yet.', fPend: 'QUEUED', fOk: 'SENT', fRej: 'REJECTED',
    stTitle: 'SETTINGS', stLead: 'Change your language, anonymity and notifications here.',
    lang: 'LANGUAGE: {l}', anon: 'ANONYMOUS IN TABLES: {v}', ref: 'NEW FRIENDS ALERTS: {v}', rem: 'SPIN REMINDERS: {v}', on: 'ON', off: 'OFF',
    bkTitle: 'SHARED BANK', bkNone: 'No bank right now — a new one opens soon.', bkPot: '{:starIcon} In the bank: <b>{p}⭐</b>{tx}', bkPlayers: '👥 Players: <b>{n}</b>',
    bkWhen: '{:clockIcon} Draw: <b>{when}</b> (in {left})', bkMine: '{:check} Your bet: <b>{w}</b> → chance <b>{c}%</b>', bkNotIn: '{:lightning} You’re not in yet — a bigger bet means a bigger sector.',
    bkTop: '{:trophy} <b>Sectors:</b>', bkFoot: 'The wheel spins once — the winner takes the whole bank. Every player gets consolation tickets.',
    bkOwn: 'CUSTOM BET', bkApp: 'BANK WHEEL', bkAsk: '{:starIcon} Send your bet in stars as a number.\nBalance: <b>{b}⭐</b>',
    bkOk: '{:check} Bet <b>{s}⭐</b> placed\nChance: <b>{c}%</b> · bank: <b>{p}⭐</b>', bkErr: { no_bank: 'No draw right now.', too_late: 'Bets are closed — the wheel is about to spin.', not_enough_stars: 'Not enough stars.', bad_amount: 'Send the bet as a number.' },
    tpTitle: 'TOP UP', tpBal: '{:starIcon} Balance: <b>{b}⭐</b>', tpLead: 'Paid with real Telegram Stars, credited instantly.',
    tpBonus: '{:giftBox} <b>+{p}%</b> bonus for {n} more top-ups.', tpLvl: '{:crown} Your level bonus: <b>+{p}%</b> on every top-up.', tpPick: 'Pick an amount 👇', tpOwn: 'CUSTOM AMOUNT',
    tpAsk: '{:starIcon} Send the amount as a number, e.g. <code>75</code>.', tpPay: 'PAY {a}⭐', tpReady: '{:check} Invoice for <b>{a}⭐</b> is ready:', tpErr: 'Couldn’t create the invoice, please try again.',
    evTitle: 'EVENT: INVITE FRIENDS', evWhen: '{:clockIcon} Until {when}', evMine: '👥 Your new friends: <b>{mine}</b>', evFoot: 'Top 3 get a 🚀 Rocket, 🎁 Gift and 🧸 Teddy.',
    wdLead: '{:withdrawBox} Withdrawals are in the app — fees and rules are shown there.',
    backHint: '👇 The “Back” button below always returns to the menu', backKey: 'Back',
  },
  ru: {
    hi: '{:lightning} <b>Привет, {name}!</b>', lead: 'Колёса удачи, игры на звёзды, общий банк и <b>настоящие Telegram-подарки</b> {:giftBox}',
    bal: '{:starIcon} Баланс: <b>{s}</b> ⭐', tix: '🎫 Билеты: <b>{t}</b>', lvl: '{:crown} Уровень {n}: <b>{e} {title}</b>',
    bankLine: '{:almost} В банке <b>{p}⭐</b> — розыгрыш {when}', tease: '<i>А что будет дальше...</i> {:eye}',
    open: 'ОТКРЫТЬ STARFORGE', rewards: 'МОИ НАГРАДЫ', games: '🎲 ИГРЫ НА ЗВЁЗДЫ', bank: '🏦 ОБЩИЙ БАНК — {p}⭐', topup: 'ПОПОЛНИТЬ БАЛАНС',
    profile: 'МОЙ ПРОФИЛЬ', promo: 'ПРОМОКОД', withdraw: 'ВЫВЕСТИ ЗВЁЗДЫ', settings: '⚙️ НАСТРОЙКИ', apps: 'МОИ ЗАЯВКИ',
    giveaway: 'РОЗЫГРЫШ: {n}', extref: 'ШАНС НА МИШКУ ({w}/{m})', event: 'СОБЫТИЕ: ПРИГЛАСИ ДРУЗЕЙ', admin: 'АДМИН-ПАНЕЛЬ',
    rwTitle: 'МОИ НАГРАДЫ', rwInvited: '👥 Приглашено друзей: <b>{n}</b>', rwLink: '{:lightning} Твоя ссылка:',
    rwFoot: 'Друг засчитывается, когда подписался на канал. Каждая ступень — один раз, выдача вручную.',
    share: 'ПОДЕЛИТЬСЯ ССЫЛКОЙ', claim: 'ЗАБРАТЬ: {name}', stDone: '{:check} выдано', stPend: '{:pendingIcon} в очереди', stRej: '{:redCircle} отклонено', stOk: '{:greenCircle} <b>можно забрать!</b>', stLock: '{:lockIcon} ещё {n}',
    claimed: '{:check} <b>Заявка #{id} создана</b>\n{name} — выдадим в ближайшее время.', claimErr: { already: 'Заявка на этот приз уже есть.', need_username: 'Сначала добавь @username в настройках Telegram.', not_enough_friends: 'Пока не хватает друзей.' },
    pfTitle: 'МОЙ ПРОФИЛЬ', pfSpins: '🎰 Спинов: <b>{spins}</b> (платных {paid})', pfPrizes: '{:giftBox} Призов: <b>{prizes}</b>', pfBest: '{:trophy} Лучший выигрыш: <b>{best}</b>',
    pfBal: '{:starIcon} Баланс: <b>{s}⭐</b> · 🎫 <b>{t}</b>', pfEarned: '{:statsIcon} Выиграно за всё время: <b>{earned}⭐</b>', pfGames: '🎲 Игр: <b>{games}</b>',
    pfStreak: '{:almost} Серия: <b>{streak}</b> дн. (рекорд {best2})', pfFriends: '👥 Друзей: <b>{friends}</b>', pfLvl: '{:crown} {lvl} · {xp} XP',
    lastWins: '{:inventoryBag} <b>Последние выигрыши:</b>', nothing: 'пока ничего',
    apTitle: 'МОИ ЗАЯВКИ', apNone: 'Пока пусто.', fPend: 'В ОЧЕРЕДИ', fOk: 'ВЫДАНЫ', fRej: 'ОТКЛОНЕНЫ',
    stTitle: 'НАСТРОЙКИ', stLead: 'Здесь можно сменить язык, анонимность и уведомления.',
    lang: 'ЯЗЫК: {l}', anon: 'АНОНИМНО В ТАБЛИЦАХ: {v}', ref: 'О НОВЫХ ДРУЗЬЯХ: {v}', rem: 'НАПОМИНАНИЯ О СПИНЕ: {v}', on: 'ДА', off: 'НЕТ',
    bkTitle: 'ОБЩИЙ БАНК', bkNone: 'Сейчас банка нет — новый откроется скоро.', bkPot: '{:starIcon} В банке: <b>{p}⭐</b>{tx}', bkPlayers: '👥 Участников: <b>{n}</b>',
    bkWhen: '{:clockIcon} Розыгрыш: <b>{when}</b> (через {left})', bkMine: '{:check} Твоя ставка: <b>{w}</b> → шанс <b>{c}%</b>', bkNotIn: '{:lightning} Ты ещё не в игре — чем больше ставка, тем больше твой сектор.',
    bkTop: '{:trophy} <b>Секторы:</b>', bkFoot: 'Колесо крутится один раз — победитель забирает весь банк. Каждый участник получает утешительные билеты.',
    bkOwn: 'СВОЯ СТАВКА', bkApp: 'КОЛЕСО БАНКА', bkAsk: '{:starIcon} Напиши ставку звёздами числом.\nБаланс: <b>{b}⭐</b>',
    bkOk: '{:check} Поставлено <b>{s}⭐</b>\nШанс: <b>{c}%</b> · банк: <b>{p}⭐</b>', bkErr: { no_bank: 'Сейчас розыгрыша нет.', too_late: 'Приём ставок закрыт — колесо вот-вот крутится.', not_enough_stars: 'Мало звёзд.', bad_amount: 'Укажи ставку числом.' },
    tpTitle: 'ПОПОЛНЕНИЕ', tpBal: '{:starIcon} Баланс: <b>{b}⭐</b>', tpLead: 'Оплата — реальными Telegram Stars, зачисляется сразу.',
    tpBonus: '{:giftBox} Бонус <b>+{p}%</b> ещё на {n} пополнения.', tpLvl: '{:crown} Бонус твоего уровня: <b>+{p}%</b> к каждому пополнению.', tpPick: 'Выбери сумму 👇', tpOwn: 'СВОЯ СУММА',
    tpAsk: '{:starIcon} Напиши сумму числом, например <code>75</code>.', tpPay: 'ОПЛАТИТЬ {a}⭐', tpReady: '{:check} Счёт на <b>{a}⭐</b> готов:', tpErr: 'Не удалось создать счёт, попробуй ещё раз.',
    evTitle: 'СОБЫТИЕ: ПРИГЛАСИ ДРУЗЕЙ', evWhen: '{:clockIcon} До {when}', evMine: '👥 Твоих новых друзей: <b>{mine}</b>', evFoot: 'Топ-3 получат 🚀 Ракету, 🎁 Подарок и 🧸 Мишку.',
    wdLead: '{:withdrawBox} Вывод звёзд — в приложении: там видно комиссию и условия.',
    backHint: '👇 Кнопка «Назад» внизу всегда вернёт в меню', backKey: 'Назад',
  },
};
const L = (uid) => { const l = (users.get(uid) || {}).lang; return T[l] ? l : 'uk'; };
// Текст повідомлення: {параметри} і {:преміум-емодзі}.
const tt = (lang, k, p) => { const v = (T[lang] || T.uk)[k]; return withEmoji(String(v === undefined ? T.uk[k] : v).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m))); };
// Підпис кнопки — без HTML (кнопки його не розуміють).
const bt = (lang, k, p) => { const v = (T[lang] || T.uk)[k]; return String(v === undefined ? T.uk[k] : v).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m)); };
const whenOf = (ts, lang) => time.fmtKyiv(ts, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }, lang);
// Преміум-емодзі призу (для кнопок і рядків сходинки).
const TIER_ICON = { bear: 'teddyBear', gift: 'giftBox', rocket: 'rocket', trophy: 'trophy', xmas_stocking: 'xmasStocking', wheel_stocking: 'xmasStocking', fresh_socks: 'freshSocks', diamond_ring: 'diamondRing', ring: 'diamondRing', premium3m: 'premium' };
const tierIcon = (id) => TIER_ICON[id] || 'giftBox';
const tierEmoji = (id, fallback) => { const k = TIER_ICON[id]; return k && EMOJI[k] && EMOJI[k].id ? withEmoji('{:' + k + '}') : fallback; };
const screen = (icon, title, lines, foot) => ui.card(icon, title, lines, foot);
const html = (text, rows, more) => ({ text, extra: { parse_mode: 'HTML', disable_web_page_preview: true, ...(more || {}), ...ui.kb(rows) } });

const awaiting = new Map();   // uid -> { kind: 'bank' | 'topup', at }

// ─── Головне меню ───────────────────────────────────────────────────────
function mainMenu(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const lv = progress.view(u, lang).level;
  const b = bank.get();
  const bankOpen = b && b.status === 'open' && b.drawAt > Date.now();
  const f = store.getFeatureFlags() || {};
  const lines = [
    tt(lang, 'hi', { name: esc(u.name || u.username || '') }), '',
    tt(lang, 'lead'), '',
    tt(lang, 'bal', { s: fmtStars(users.stars(u)) }), tt(lang, 'tix', { t: users.tickets(u) }),
    tt(lang, 'lvl', { e: lv.e, title: esc(lv.t), n: lv.n }),
  ];
  if (bankOpen) lines.push('', tt(lang, 'bankLine', { p: fmtStars(bank.prizeOf(b).stars), when: whenOf(b.drawAt, lang) }));
  lines.push('', tt(lang, 'tease'));
  const rows = [
    [ui.app(bt(lang, 'open'), null, 'success', 'rocket')],
    [ui.cb(bt(lang, 'rewards'), 'rewards', 'primary', 'giftBox')],
    [ui.cb(bt(lang, 'games'), 'dice_menu', 'danger', 'starIcon')],
    bankOpen ? [ui.cb(bt(lang, 'bank', { p: fmtStars(bank.prizeOf(b).stars) }), 'bank_show', 'danger', 'almost')] : null,
    [ui.cb(bt(lang, 'topup'), 'topup_menu', 'success', 'starIcon')],
    [require('./levels').menuButton(u)],
    [ui.cb(bt(lang, 'profile'), 'my_profile', 'primary', 'statsIcon'), ui.cb(bt(lang, 'promo'), 'promo_code_start', 'success', 'promoCode')],
    [ui.app(bt(lang, 'withdraw'), 'withdraw', users.stars(u) >= E.WITHDRAW.min ? 'success' : undefined, 'withdrawBox')],
  ];
  for (const [gid, g] of Object.entries(store.listGiveaways() || {})) {
    if (g && g.active && Date.now() < g.endsAt) {
      rows.push([ui.cb(bt(lang, 'giveaway', { n: (g.winnersCount > 1 ? g.winnersCount + '× ' : '') + E.tierName(g.tierId, lang).toUpperCase() }), 'ga_join_' + gid, 'danger', tierIcon(g.tierId))]);
    }
  }
  const pool = store.getExternalRefPool();
  if (pool && pool.active) rows.push([ui.cb(bt(lang, 'extref', { w: pool.wonCount || 0, m: pool.winnersCount || 3 }), 'ext_ref_join', 'danger', 'teddyBear')]);
  const ev = store.getEvent();
  if (f.eventUnlocked && ev && ev.active && Date.now() < ev.endsAt) rows.push([ui.cb(bt(lang, 'event'), 'event_view', 'success', 'trophy')]);
  rows.push([ui.cb(bt(lang, 'settings'), 'settings', 'primary')]);
  if (users.isAdmin(uid)) rows.push([ui.app(bt(lang, 'admin'), 'admin', undefined, 'lockIcon')]);
  return html(lines.join('\n'), rows);
}
const backRow = (lang, data) => [ui.back(lang, data)];

// ─── Нагороди за друзів ─────────────────────────────────────────────────
function rewardsView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const lad = referrals.ladder(u, lang);
  const link = lad.link || '';
  const stIcon = { approved: 'stDone', pending: 'stPend', rejected: 'stRej', claimable: 'stOk' };
  const lines = [tt(lang, 'rwInvited', { n: lad.count }), ''];
  const rows = [];
  for (const s of lad.steps) {
    const st = stIcon[s.state] ? tt(lang, stIcon[s.state]) : tt(lang, 'stLock', { n: s.left });
    lines.push(`${tierEmoji(s.id, s.emoji)} <b>${esc(s.name)}</b> — ${s.need} 👥 · ${st}`);
    if (s.state === 'claimable') rows.push([ui.cb(bt(lang, 'claim', { name: s.name.toUpperCase() }), 'claim_' + s.id, 'success', tierIcon(s.id))]);
  }
  if (link) lines.push('', tt(lang, 'rwLink'), '<code>' + esc(link) + '</code>');
  const share = link ? 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent({ uk: 'Заходь у StarForge — колеса удачі, ігри й справжні Telegram-подарунки 🎁', en: 'Join StarForge — wheels of luck, games and real Telegram gifts 🎁', ru: 'Заходи в StarForge — колёса удачи, игры и настоящие Telegram-подарки 🎁' }[lang]) : null;
  if (share) rows.unshift([ui.url(bt(lang, 'share'), share, 'primary', 'lightning')]);
  rows.push(backRow(lang));
  return html(screen('giftBox', tt(lang, 'rwTitle'), lines, bt(lang, 'rwFoot')), rows);
}

// ─── Профіль і заявки ───────────────────────────────────────────────────
function profileView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const p = profile.view(u, lang);
  const st = p.stats;
  const lines = [
    tt(lang, 'pfBal', { s: fmtStars(users.stars(u)), t: users.tickets(u) }),
    tt(lang, 'pfLvl', { lvl: p.level.e + ' ' + esc(p.level.t) + ' · ' + p.level.n, xp: Math.floor(p.level.xp) }),
    '',
    tt(lang, 'pfSpins', { spins: st.spins, paid: st.paidSpins }), tt(lang, 'pfPrizes', { prizes: st.prizes }),
    tt(lang, 'pfBest', { best: esc(st.bestWin || bt(lang, 'nothing')) }), tt(lang, 'pfEarned', { earned: fmtStars(st.earned) }),
    tt(lang, 'pfGames', { games: st.games }), tt(lang, 'pfStreak', { streak: st.streak, best2: st.bestStreak }), tt(lang, 'pfFriends', { friends: st.friends }),
  ];
  if (p.history.length) {
    lines.push('', tt(lang, 'lastWins'));
    for (const h of p.history.slice(0, 8)) lines.push('  ' + esc(h.title) + ' · ' + time.fmtKyiv(h.at, { day: 'numeric', month: 'short' }));
  }
  return html(screen('statsIcon', tt(lang, 'pfTitle'), lines), [
    [require('./levels').menuButton(u)],
    [ui.cb(bt(lang, 'apps'), 'my_applications', 'primary', 'applicationsIcon')],
    backRow(lang),
  ]);
}
function appsView(uid, filter) {
  const lang = L(uid);
  const all = applications.listFor(uid);
  const cnt = (s) => all.filter(a => a.status === s).length;
  const list = all.filter(a => a.status === filter).slice(0, 25).map(a => applications.publicView(a, lang));
  const lines = [];
  if (!list.length) lines.push('<i>' + esc(bt(lang, 'apNone')) + '</i>');
  const mark = { pending: '{:pendingIcon}', approved: '{:check}', rejected: '{:redCircle}' }[filter];
  for (const a of list) lines.push(withEmoji(mark) + ` ${esc(a.title)} · #${a.id} · ${time.fmtKyiv(a.createdAt, { day: 'numeric', month: 'short' })}` + (a.reason ? ' · ' + esc(a.reason) : ''));
  const btn = (s, k, icon) => ui.cb(`${bt(lang, k)} (${cnt(s)})`, 'myapp_' + s, filter === s ? 'primary' : undefined, icon);
  return html(screen('applicationsIcon', tt(lang, 'apTitle'), lines), [
    [btn('pending', 'fPend', 'pendingIcon'), btn('approved', 'fOk', 'check')],
    [btn('rejected', 'fRej', 'redCircle')],
    backRow(lang),
  ]);
}

// ─── Налаштування ───────────────────────────────────────────────────────
function settingsView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const yn = (v) => bt(lang, v ? 'on' : 'off');
  const langName = { uk: 'УКРАЇНСЬКА', en: 'ENGLISH', ru: 'РУССКИЙ' }[u.lang || 'uk'];
  const flag = { uk: 'flagUk', en: 'flagEn', ru: 'flagRu' }[u.lang || 'uk'];
  const anon = !!u.anonymous, ref = u.notifyOnReferral !== false, rem = !u.remindersOff;
  const toggle = (k, v, data, icon) => ui.cb(bt(lang, k, { v: yn(v) }), data, v ? 'success' : 'danger', icon || (v ? 'greenCircle' : 'redCircle'));
  return html(screen('⚙️', tt(lang, 'stTitle'), [esc(bt(lang, 'stLead'))]), [
    [ui.cb(bt(lang, 'lang', { l: langName }), 'lang_menu', 'primary', flag)],
    [toggle('anon', anon, 'toggle_anon', anon ? 'anonymityIcon' : null)],
    [toggle('ref', ref, 'toggle_ref_notify')],
    [toggle('rem', rem, 'toggle_reminders')],
    [ui.cb(bt(lang, 'apps'), 'my_applications', 'primary', 'applicationsIcon')],
    backRow(lang),
  ]);
}

// ─── Банк у боті ────────────────────────────────────────────────────────
function bankView(uid) {
  const lang = L(uid);
  const v = bank.view(uid);
  const rows = [];
  if (!v.active || v.status !== 'open') {
    rows.push([ui.app(bt(lang, 'bkApp'), 'bank', 'primary', 'eye')], backRow(lang));
    return html(screen('🏦', tt(lang, 'bkTitle'), [esc(bt(lang, 'bkNone'))]), rows);
  }
  const medal = ['{:goldMedal}', '{:silverMedal}', '{:bronzeMedal}'];
  const top = v.sectors.slice(0, 6).map((s, i) => `${withEmoji(medal[i] || '')}${medal[i] ? '' : (i + 1) + '.'} ${esc(s.name)} — <b>${s.percent}%</b>`);
  const lines = [
    tt(lang, 'bkPot', { p: fmtStars(v.prize.stars), tx: v.prize.tickets ? ' + ' + v.prize.tickets + '🎫' : '' }),
    tt(lang, 'bkPlayers', { n: v.players }),
    tt(lang, 'bkWhen', { when: whenOf(v.drawAt, lang), left: time.humanLeft(Math.max(0, v.drawAt - Date.now())) }),
    '',
    v.mine.weight > 0 ? tt(lang, 'bkMine', { w: fmtStars(v.mine.weight), c: v.mine.chance }) : tt(lang, 'bkNotIn'),
  ];
  if (top.length) lines.push('', tt(lang, 'bkTop'), ...top);
  const bets = [5, 10, 25, 50, 100].filter(n => n <= v.balance);
  for (let i = 0; i < bets.length; i += 3) rows.push(bets.slice(i, i + 3).map(n => ui.cb(n + '⭐', 'bank_bet_' + n, 'success', 'starIcon')));
  rows.push([ui.cb(bt(lang, 'bkOwn'), 'bank_own', 'primary', 'lightning')]);
  rows.push([ui.app(bt(lang, 'bkApp'), 'bank', undefined, 'eye')]);
  rows.push(backRow(lang));
  return html(screen('🏦', tt(lang, 'bkTitle'), lines, bt(lang, 'bkFoot')), rows);
}
async function placeBet(ctx, uid, amount) {
  const lang = L(uid);
  const r = await bank.bet(uid, amount, 0);
  if (!r.ok) return ctx.reply((T[lang].bkErr || T.uk.bkErr)[r.error] || T.uk.bkErr.bad_amount, ui.kb([backRow(lang, 'bank_show')])).catch(() => {});
  await ctx.reply(tt(lang, 'bkOk', { s: Math.floor(Number(amount)), c: r.chance, p: fmtStars(r.pot) }), { parse_mode: 'HTML', ...ui.kb([
    [ui.cb(bt(lang, 'bkTitle'), 'bank_show', 'primary', 'almost'), ui.app(bt(lang, 'bkApp'), 'bank', undefined, 'eye')],
    backRow(lang),
  ]) }).catch(() => {});
}

// ─── Поповнення ─────────────────────────────────────────────────────────
function topupView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const info = wallet.topupInfo(u);
  const rows = [];
  const ps = info.presets;
  for (let i = 0; i < ps.length; i += 3) rows.push(ps.slice(i, i + 3).map(n => ui.cb(n + '⭐', 'topup_' + n, 'success', 'starIcon')));
  rows.push([ui.cb(bt(lang, 'tpOwn'), 'topup_own', 'primary', 'lightning')], backRow(lang));
  // +10% на перші поповнення або постійний бонус рівня — діє більший.
  const lvl = info.levelBonusPercent || 0;
  const bonus = info.bonusLeft && info.bonusPercent >= lvl ? tt(lang, 'tpBonus', { p: info.bonusPercent, n: info.bonusLeft })
    : lvl ? tt(lang, 'tpLvl', { p: lvl }) : null;
  return html(screen('starIcon', tt(lang, 'tpTitle'), [tt(lang, 'tpBal', { b: fmtStars(users.stars(u)) }), esc(bt(lang, 'tpLead')), bonus], bt(lang, 'tpPick')), rows);
}
async function sendInvoice(ctx, uid, amount) {
  const lang = L(uid);
  const r = await wallet.invoiceLink(uid, 'topup', amount);
  if (!r.ok) return ctx.reply(bt(lang, 'tpErr'), ui.kb([backRow(lang, 'topup_menu')])).catch(() => {});
  await ctx.reply(tt(lang, 'tpReady', { a: r.price }), { parse_mode: 'HTML', ...ui.kb([[ui.url(bt(lang, 'tpPay', { a: r.price }), r.link, 'success', 'commission')], backRow(lang)]) }).catch(() => {});
}

// ─── Подія ──────────────────────────────────────────────────────────────
function eventView(uid) {
  const lang = L(uid);
  const ev = store.getEvent();
  const u = users.get(uid) || {};
  const ranked = Object.values(users.all()).filter(x => x && (x.eventReferrals || 0) > 0 && !users.isAdmin(x.id)).sort((a, b) => b.eventReferrals - a.eventReferrals).slice(0, 10);
  const medal = ['{:goldMedal}', '{:silverMedal}', '{:bronzeMedal}'];
  const top = ranked.map((x, i) => (medal[i] ? withEmoji(medal[i]) : (i + 1) + '.') + ` ${esc(users.displayName(x))} — <b>${x.eventReferrals}</b>`);
  return html(screen('trophy', tt(lang, 'evTitle'), [tt(lang, 'evWhen', { when: ev ? whenOf(ev.endsAt, lang) : '—' }), tt(lang, 'evMine', { mine: u.eventReferrals || 0 }), top.length ? '' : null, ...top], bt(lang, 'evFoot')),
    [[ui.cb(bt(lang, 'rewards'), 'rewards', 'primary', 'giftBox')], backRow(lang)]);
}

// ─── «Назад» під полем вводу ────────────────────────────────────────────
// Постійна кнопка внизу (як у попередній версії): із будь-якого екрана чи
// очікування вводу (ставка, промокод, сума) повертає в головне меню.
const BACK_KB_V = 1;
function backKeyboard(lang) {
  const b = { text: bt(lang, 'backKey') };
  if (EMOJI.back && EMOJI.back.id) b.icon_custom_emoji_id = EMOJI.back.id;
  return { reply_markup: { keyboard: [[b]], resize_keyboard: true, is_persistent: true } };
}
// Показуємо її один раз — далі Telegram тримає її сам.
async function ensureBackKeyboard(ctx, uid) {
  const u = users.get(uid);
  if (!u || u.backKb === BACK_KB_V) return;
  users.patch(uid, { backKb: BACK_KB_V });
  await ctx.reply(bt(L(uid), 'backHint'), backKeyboard(L(uid))).catch(() => {});
}
const BACK_WORDS = ['назад', 'back', 'меню', 'menu'];
const isBackText = (s) => BACK_WORDS.includes(String(s || '').replace(/^[^\p{L}]+/u, '').trim().toLowerCase());

function register(bot, hooks, gate) {
  const priv = (ctx) => !ctx.chat || ctx.chat.type === 'private';
  // sub — підекран: після нього (один раз) з'являється «Назад» під полем вводу.
  const send = (build, needGate, sub) => async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    if (needGate !== false && gate && !(await gate(ctx, uid))) return;
    const v = build(uid, ctx);
    await ctx.reply(v.text, v.extra).catch(() => {});
    if (sub !== false) await ensureBackKeyboard(ctx, uid);
  };
  const showMain = send(mainMenu, true, false);
  bot.command('menu', showMain);
  bot.action(['back_to_menu', 'menu_back'], async (ctx) => { await ctx.deleteMessage().catch(() => {}); return showMain(ctx); });
  // Кнопка «Назад» під полем вводу: скасувати будь-яке очікування вводу й показати меню.
  bot.hears((text) => isBackText(text), async (ctx, next) => {
    if (!priv(ctx)) return next();
    const uid = String(ctx.from.id);
    for (const h of hooks.onCommand) h(uid);
    return showMain(ctx);
  });

  bot.action('rewards', send(rewardsView));
  bot.action(/^claim_([a-z0-9_]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    const lang = L(uid);
    if (gate && !(await gate(ctx, uid))) return;
    const r = await referrals.claimLadder(uid, ctx.match[1]);
    if (!r.ok) return ctx.reply((T[lang].claimErr || T.uk.claimErr)[r.error] || T.uk.claimErr.not_enough_friends, ui.kb([backRow(lang, 'rewards')])).catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(tt(lang, 'claimed', { id: r.applicationId, name: tierEmoji(ctx.match[1], E.getTier(ctx.match[1]).emoji) + ' ' + esc(E.tierName(ctx.match[1], lang)) }), { parse_mode: 'HTML', ...ui.kb([
      [ui.cb(bt(lang, 'apps'), 'my_applications', 'primary', 'applicationsIcon')], backRow(lang),
    ]) }).catch(() => {});
  });
  bot.action('my_profile', send(profileView));
  bot.action('my_applications', send((uid) => appsView(uid, 'pending')));
  bot.action(/^myapp_(pending|approved|rejected)$/, send((uid, ctx) => appsView(uid, ctx.match[1])));
  bot.action('settings', send(settingsView, false));
  const toggle = (field) => async (ctx) => {
    await ctx.answerCbQuery('✅').catch(() => {});
    const uid = String(ctx.from.id);
    const u = users.get(uid) || {};
    const patch = field === 'anonymous' ? { anonymous: !u.anonymous } : field === 'ref' ? { notifyOnReferral: u.notifyOnReferral === false } : { reminders: !!u.remindersOff };
    profile.updateSettings(uid, patch);
    const v = settingsView(uid);
    await ctx.editMessageText(v.text, v.extra).catch(() => ctx.reply(v.text, v.extra).catch(() => {}));
  };
  bot.action('toggle_anon', toggle('anonymous'));
  bot.action('toggle_ref_notify', toggle('ref'));
  bot.action('toggle_reminders', toggle('reminders'));
  bot.action('toggle_back_hint', send(settingsView, false));
  bot.action('change_language', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await require('./start').sendLangPicker(ctx); });

  bot.command('bank', send(bankView));
  bot.action('bank_show', send(bankView));
  bot.action(/^bank_bet_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    if (gate && !(await gate(ctx, uid))) return;
    await placeBet(ctx, uid, parseInt(ctx.match[1], 10));
  });
  bot.action('bank_own', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    const lang = L(uid);
    awaiting.set(uid, { kind: 'bank', at: Date.now() });
    await ctx.reply(tt(lang, 'bkAsk', { b: fmtStars(users.stars(users.get(uid) || {})) }), { parse_mode: 'HTML', ...ui.kb([backRow(lang, 'bank_show')]) }).catch(() => {});
    await ensureBackKeyboard(ctx, uid);
  });

  bot.command('topup', send(topupView, false));
  bot.action('topup_menu', send(topupView, false));
  bot.action(/^topup_(\d+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendInvoice(ctx, String(ctx.from.id), ctx.match[1]); });
  bot.action('topup_own', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    const lang = L(uid);
    awaiting.set(uid, { kind: 'topup', at: Date.now() });
    await ctx.reply(tt(lang, 'tpAsk'), { parse_mode: 'HTML', ...ui.kb([backRow(lang, 'topup_menu')]) }).catch(() => {});
    await ensureBackKeyboard(ctx, uid);
  });
  // Вивід завжди був у застосунку — ведемо туди.
  bot.action(['withdraw_stars', 'withdraw_stars_custom'], async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lang = L(String(ctx.from.id));
    await ctx.reply(tt(lang, 'wdLead'), { parse_mode: 'HTML', ...ui.kb([[ui.app(bt(lang, 'withdraw'), 'withdraw', 'success', 'withdrawBox')], backRow(lang)]) }).catch(() => {});
  });
  bot.action('event_view', send(eventView));

  hooks.onText.push(async (ctx, uid, text) => {
    const w = awaiting.get(uid);
    if (!w) return false;
    awaiting.delete(uid);
    if (Date.now() - w.at > 10 * 60000) return false;
    const n = parseInt(String(text).replace(/\s/g, ''), 10);
    if (w.kind === 'bank') { if (gate && !(await gate(ctx, uid))) return true; await placeBet(ctx, uid, n); }
    else await sendInvoice(ctx, uid, n);
    return true;
  });
  hooks.onCommand.push((uid) => awaiting.delete(uid));
}

module.exports = { register, mainMenu, ensureBackKeyboard, backKeyboard, isBackText };
