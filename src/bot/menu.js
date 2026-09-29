// ==========================================================================
// ГОЛОВНЕ МЕНЮ В БОТІ — як у попередній версії: нагороди за друзів, ігри,
// спільний банк, поповнення, профіль, промокод, заявки, налаштування,
// активні розіграші й події. Усе те саме є й у застосунку.
// ==========================================================================
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const time = require('../lib/time');
const bank = require('../features/bank');
const wallet = require('../features/wallet');
const profile = require('../features/profile');
const referrals = require('../features/referrals');
const applications = require('../features/applications');
const ui = require('./ui');
const { esc, fmtStars } = require('../lib/util');

const T = {
  uk: {
    hi: '👋 <b>Привіт, {name}!</b>', bal: '⭐ Баланс: <b>{s}</b> · 🎫 Білети: <b>{t}</b>', lvl: '{e} {title} · рівень {n}',
    bankLine: '🏦 У банку зараз <b>{p}⭐</b> — розіграш {when}', open: '🎰 Відкрити StarForge',
    rewards: '🎁 Нагороди за друзів', games: '🎲 Ігри на зірки', bank: '🏦 Спільний банк — {p}⭐', topup: '⭐ Поповнити баланс',
    profile: '👤 Мій профіль', promo: '🎟 Промокод', withdraw: '💸 Вивести зірки', settings: '⚙️ Налаштування', apps: '📦 Мої заявки',
    giveaway: '🎁 Розіграш: {n}', extref: '🧸 Шанс на мішку ({w}/{m})', event: '🏆 Подія: запроси друзів', admin: '🛠 Адмін-панель', back: '⬅️ Меню',
    rwTitle: '🎁 <b>Нагороди за друзів</b>\nЗапрошено: <b>{n}</b>\n\nТвоє посилання:\n<code>{link}</code>\n\nДруг рахується, коли підписався на канал. Кожна сходинка — один раз.',
    share: '⚡ Поділитися посиланням', claim: '✅ Забрати {name}', stDone: '✅ видано', stPend: '⏳ в черзі', stRej: '❌ відхилено', stOk: '🟢 можна забрати', stLock: 'ще {n}',
    claimed: '✅ Заявку #{id} на {name} створено — видамо найближчим часом.', claimErr: { already: 'Заявка на цей приз уже є.', need_username: 'Спершу додай @username у налаштуваннях Telegram.', not_enough_friends: 'Поки не вистачає друзів.' },
    pfTitle: '👤 <b>Твій профіль</b>', pf: '🎰 Спінів: <b>{spins}</b> (платних {paid})\n🎁 Призів: <b>{prizes}</b>\n💎 Найкращий виграш: <b>{best}</b>\n\n⭐ Баланс: <b>{s}</b> · 🎫 <b>{t}</b>\n📈 Виграно за весь час: <b>{earned}⭐</b>\n🎲 Ігор: <b>{games}</b>\n\n🔥 Серія: <b>{streak}</b> дн. (рекорд {best2})\n👥 Друзів: <b>{friends}</b>\n{lvl} · {xp} XP',
    lastWins: '📜 <b>Останні виграші:</b>', nothing: 'ще нічого',
    apTitle: '📦 <b>Мої заявки</b>', apNone: 'Тут поки порожньо.', fPend: '⏳ В черзі', fOk: '✅ Видані', fRej: '❌ Відхилені',
    stTitle: '⚙️ <b>Налаштування</b>', lang: '🌐 Мова: {l}', anon: '🕶 Анонімно в таблицях: {v}', ref: '🔔 Про нових друзів: {v}', rem: '⏰ Нагадування про спін: {v}', on: 'так', off: 'ні',
    bkTitle: '🏦 <b>Спільний банк</b>', bkNone: 'Зараз банку немає — новий відкриється скоро.', bk: 'У банку: <b>{p}⭐</b>{tx} · учасників: <b>{n}</b>\nРозіграш: <b>{when}</b> (через {left})\n\n{mine}\n{top}\nКолесо крутиться один раз — переможець забирає весь банк. Кожен учасник отримує втішні білети.',
    bkMine: 'Твоя ставка: <b>{w}</b> → шанс <b>{c}%</b>', bkNotIn: 'Ти ще не в грі — що більша ставка, то більший твій сектор.', bkTop: '<b>Сектори:</b>', bkOwn: '✏️ Своя ставка', bkApp: '🎡 Колесо банку в застосунку',
    bkAsk: 'Напиши ставку зірками числом. Баланс: <b>{b}⭐</b>', bkOk: '✅ Поставлено <b>{s}⭐</b>. Шанс: <b>{c}%</b>. Банк: <b>{p}⭐</b>', bkErr: { no_bank: 'Зараз розіграшу немає.', too_late: 'Прийом ставок закрито — колесо ось-ось крутиться.', not_enough_stars: 'Замало зірок.', bad_amount: 'Вкажи ставку числом.' },
    tpTitle: '⭐ <b>Поповнення</b>\n\nБаланс: <b>{b}⭐</b>\nОплата — реальними Telegram Stars.{bonus}\n\nОбери суму:', tpBonus: '\n🎁 Бонус <b>+{p}%</b> ще на {n} поповнення.', tpOwn: '✏️ Своя сума',
    tpAsk: 'Напиши суму числом, наприклад <code>75</code>.', tpPay: '💳 Оплатити {a}⭐', tpReady: '⭐ Рахунок на <b>{a}⭐</b> готовий:', tpErr: 'Не вдалось створити рахунок, спробуй ще раз.',
    evTitle: '🏆 <b>Подія: запроси друзів</b>', ev: 'До {when}.\nТвоїх нових друзів: <b>{mine}</b>\n\n{top}\n\nТоп-3 отримають 🚀 Ракету, 🎁 Подарунок і 🧸 Мішку.',
  },
  en: {
    hi: '👋 <b>Hi, {name}!</b>', bal: '⭐ Balance: <b>{s}</b> · 🎫 Tickets: <b>{t}</b>', lvl: '{e} {title} · level {n}',
    bankLine: '🏦 The bank holds <b>{p}⭐</b> — draw {when}', open: '🎰 Open StarForge',
    rewards: '🎁 Rewards for friends', games: '🎲 Star games', bank: '🏦 Shared bank — {p}⭐', topup: '⭐ Top up',
    profile: '👤 My profile', promo: '🎟 Promo code', withdraw: '💸 Withdraw stars', settings: '⚙️ Settings', apps: '📦 My requests',
    giveaway: '🎁 Giveaway: {n}', extref: '🧸 Teddy chance ({w}/{m})', event: '🏆 Event: invite friends', admin: '🛠 Admin panel', back: '⬅️ Menu',
    rwTitle: '🎁 <b>Rewards for friends</b>\nInvited: <b>{n}</b>\n\nYour link:\n<code>{link}</code>\n\nA friend counts once subscribed to the channel. Each step once.',
    share: '⚡ Share the link', claim: '✅ Claim {name}', stDone: '✅ sent', stPend: '⏳ queued', stRej: '❌ rejected', stOk: '🟢 claimable', stLock: '{n} more',
    claimed: '✅ Request #{id} for {name} created — we’ll send it soon.', claimErr: { already: 'You already have a request for this prize.', need_username: 'Add a @username in Telegram settings first.', not_enough_friends: 'Not enough friends yet.' },
    pfTitle: '👤 <b>Your profile</b>', pf: '🎰 Spins: <b>{spins}</b> ({paid} paid)\n🎁 Prizes: <b>{prizes}</b>\n💎 Best win: <b>{best}</b>\n\n⭐ Balance: <b>{s}</b> · 🎫 <b>{t}</b>\n📈 Won in total: <b>{earned}⭐</b>\n🎲 Games: <b>{games}</b>\n\n🔥 Streak: <b>{streak}</b> days (best {best2})\n👥 Friends: <b>{friends}</b>\n{lvl} · {xp} XP',
    lastWins: '📜 <b>Latest wins:</b>', nothing: 'nothing yet',
    apTitle: '📦 <b>My requests</b>', apNone: 'Nothing here yet.', fPend: '⏳ Queued', fOk: '✅ Sent', fRej: '❌ Rejected',
    stTitle: '⚙️ <b>Settings</b>', lang: '🌐 Language: {l}', anon: '🕶 Anonymous in tables: {v}', ref: '🔔 About new friends: {v}', rem: '⏰ Spin reminders: {v}', on: 'on', off: 'off',
    bkTitle: '🏦 <b>Shared bank</b>', bkNone: 'No bank right now — a new one opens soon.', bk: 'In the bank: <b>{p}⭐</b>{tx} · players: <b>{n}</b>\nDraw: <b>{when}</b> (in {left})\n\n{mine}\n{top}\nThe wheel spins once — the winner takes the whole bank. Every player gets consolation tickets.',
    bkMine: 'Your bet: <b>{w}</b> → chance <b>{c}%</b>', bkNotIn: 'You’re not in yet — a bigger bet means a bigger sector.', bkTop: '<b>Sectors:</b>', bkOwn: '✏️ Custom bet', bkApp: '🎡 Bank wheel in the app',
    bkAsk: 'Send your bet in stars as a number. Balance: <b>{b}⭐</b>', bkOk: '✅ Bet <b>{s}⭐</b> placed. Chance: <b>{c}%</b>. Bank: <b>{p}⭐</b>', bkErr: { no_bank: 'No draw right now.', too_late: 'Bets are closed — the wheel is about to spin.', not_enough_stars: 'Not enough stars.', bad_amount: 'Send the bet as a number.' },
    tpTitle: '⭐ <b>Top up</b>\n\nBalance: <b>{b}⭐</b>\nPaid with real Telegram Stars.{bonus}\n\nPick an amount:', tpBonus: '\n🎁 <b>+{p}%</b> bonus for {n} more top-ups.', tpOwn: '✏️ Custom amount',
    tpAsk: 'Send the amount as a number, e.g. <code>75</code>.', tpPay: '💳 Pay {a}⭐', tpReady: '⭐ Invoice for <b>{a}⭐</b> is ready:', tpErr: 'Couldn’t create the invoice, please try again.',
    evTitle: '🏆 <b>Event: invite friends</b>', ev: 'Until {when}.\nYour new friends: <b>{mine}</b>\n\n{top}\n\nTop 3 get a 🚀 Rocket, 🎁 Gift and 🧸 Teddy.',
  },
  ru: {
    hi: '👋 <b>Привет, {name}!</b>', bal: '⭐ Баланс: <b>{s}</b> · 🎫 Билеты: <b>{t}</b>', lvl: '{e} {title} · уровень {n}',
    bankLine: '🏦 В банке сейчас <b>{p}⭐</b> — розыгрыш {when}', open: '🎰 Открыть StarForge',
    rewards: '🎁 Награды за друзей', games: '🎲 Игры на звёзды', bank: '🏦 Общий банк — {p}⭐', topup: '⭐ Пополнить баланс',
    profile: '👤 Мой профиль', promo: '🎟 Промокод', withdraw: '💸 Вывести звёзды', settings: '⚙️ Настройки', apps: '📦 Мои заявки',
    giveaway: '🎁 Розыгрыш: {n}', extref: '🧸 Шанс на мишку ({w}/{m})', event: '🏆 Событие: пригласи друзей', admin: '🛠 Админ-панель', back: '⬅️ Меню',
    rwTitle: '🎁 <b>Награды за друзей</b>\nПриглашено: <b>{n}</b>\n\nТвоя ссылка:\n<code>{link}</code>\n\nДруг засчитывается, когда подписался на канал. Каждая ступень — один раз.',
    share: '⚡ Поделиться ссылкой', claim: '✅ Забрать {name}', stDone: '✅ выдано', stPend: '⏳ в очереди', stRej: '❌ отклонено', stOk: '🟢 можно забрать', stLock: 'ещё {n}',
    claimed: '✅ Заявка #{id} на {name} создана — выдадим в ближайшее время.', claimErr: { already: 'Заявка на этот приз уже есть.', need_username: 'Сначала добавь @username в настройках Telegram.', not_enough_friends: 'Пока не хватает друзей.' },
    pfTitle: '👤 <b>Твой профиль</b>', pf: '🎰 Спинов: <b>{spins}</b> (платных {paid})\n🎁 Призов: <b>{prizes}</b>\n💎 Лучший выигрыш: <b>{best}</b>\n\n⭐ Баланс: <b>{s}</b> · 🎫 <b>{t}</b>\n📈 Выиграно за всё время: <b>{earned}⭐</b>\n🎲 Игр: <b>{games}</b>\n\n🔥 Серия: <b>{streak}</b> дн. (рекорд {best2})\n👥 Друзей: <b>{friends}</b>\n{lvl} · {xp} XP',
    lastWins: '📜 <b>Последние выигрыши:</b>', nothing: 'пока ничего',
    apTitle: '📦 <b>Мои заявки</b>', apNone: 'Пока пусто.', fPend: '⏳ В очереди', fOk: '✅ Выданы', fRej: '❌ Отклонены',
    stTitle: '⚙️ <b>Настройки</b>', lang: '🌐 Язык: {l}', anon: '🕶 Анонимно в таблицах: {v}', ref: '🔔 О новых друзьях: {v}', rem: '⏰ Напоминания о спине: {v}', on: 'да', off: 'нет',
    bkTitle: '🏦 <b>Общий банк</b>', bkNone: 'Сейчас банка нет — новый откроется скоро.', bk: 'В банке: <b>{p}⭐</b>{tx} · участников: <b>{n}</b>\nРозыгрыш: <b>{when}</b> (через {left})\n\n{mine}\n{top}\nКолесо крутится один раз — победитель забирает весь банк. Каждый участник получает утешительные билеты.',
    bkMine: 'Твоя ставка: <b>{w}</b> → шанс <b>{c}%</b>', bkNotIn: 'Ты ещё не в игре — чем больше ставка, тем больше твой сектор.', bkTop: '<b>Секторы:</b>', bkOwn: '✏️ Своя ставка', bkApp: '🎡 Колесо банка в приложении',
    bkAsk: 'Напиши ставку звёздами числом. Баланс: <b>{b}⭐</b>', bkOk: '✅ Поставлено <b>{s}⭐</b>. Шанс: <b>{c}%</b>. Банк: <b>{p}⭐</b>', bkErr: { no_bank: 'Сейчас розыгрыша нет.', too_late: 'Приём ставок закрыт — колесо вот-вот крутится.', not_enough_stars: 'Мало звёзд.', bad_amount: 'Укажи ставку числом.' },
    tpTitle: '⭐ <b>Пополнение</b>\n\nБаланс: <b>{b}⭐</b>\nОплата — реальными Telegram Stars.{bonus}\n\nВыбери сумму:', tpBonus: '\n🎁 Бонус <b>+{p}%</b> ещё на {n} пополнения.', tpOwn: '✏️ Своя сумма',
    tpAsk: 'Напиши сумму числом, например <code>75</code>.', tpPay: '💳 Оплатить {a}⭐', tpReady: '⭐ Счёт на <b>{a}⭐</b> готов:', tpErr: 'Не удалось создать счёт, попробуй ещё раз.',
    evTitle: '🏆 <b>Событие: пригласи друзей</b>', ev: 'До {when}.\nТвоих новых друзей: <b>{mine}</b>\n\n{top}\n\nТоп-3 получат 🚀 Ракету, 🎁 Подарок и 🧸 Мишку.',
  },
};
const L = (uid) => { const l = (users.get(uid) || {}).lang; return T[l] ? l : 'uk'; };
const tt = (lang, k, p) => { const v = (T[lang] || T.uk)[k]; return String(v === undefined ? T.uk[k] : v).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m)); };
const whenOf = (ts, lang) => time.fmtKyiv(ts, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const awaiting = new Map();   // uid -> { kind: 'bank' | 'topup', at }

// ─── Головне меню ───────────────────────────────────────────────────────
function mainMenu(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const lv = progress.view(u, lang).level;
  const b = bank.get();
  const bankOpen = b && b.status === 'open' && b.drawAt > Date.now();
  const f = store.getFeatureFlags() || {};
  const lines = [tt(lang, 'hi', { name: esc(u.name || u.username || '') }), '', tt(lang, 'bal', { s: fmtStars(users.stars(u)), t: users.tickets(u) }), tt(lang, 'lvl', { e: lv.e, title: esc(lv.t), n: lv.n })];
  if (bankOpen) lines.push('', tt(lang, 'bankLine', { p: fmtStars(bank.prizeOf(b).stars), when: whenOf(b.drawAt, lang) }));
  const rows = [
    [ui.app(tt(lang, 'open'), null, 'success')],
    [ui.cb(tt(lang, 'rewards'), 'rewards', 'primary')],
    [ui.cb(tt(lang, 'games'), 'dice_menu', 'danger')],
    bankOpen ? [ui.cb(tt(lang, 'bank', { p: fmtStars(bank.prizeOf(b).stars) }), 'bank_show', 'danger')] : null,
    [ui.cb(tt(lang, 'topup'), 'topup_menu', 'success')],
    [ui.cb(tt(lang, 'profile'), 'my_profile', 'primary'), ui.cb(tt(lang, 'promo'), 'promo_code_start', 'success')],
    [ui.app(tt(lang, 'withdraw'), 'withdraw')],
  ].filter(Boolean);
  for (const [gid, g] of Object.entries(store.listGiveaways() || {})) {
    if (g && g.active && Date.now() < g.endsAt) rows.push([ui.cb(tt(lang, 'giveaway', { n: (g.winnersCount > 1 ? g.winnersCount + '× ' : '') + E.getTier(g.tierId).emoji + ' ' + E.tierName(g.tierId, lang) }), 'ga_join_' + gid, 'danger')]);
  }
  const pool = store.getExternalRefPool();
  if (pool && pool.active) rows.push([ui.cb(tt(lang, 'extref', { w: pool.wonCount || 0, m: pool.winnersCount || 3 }), 'ext_ref_join', 'danger')]);
  const ev = store.getEvent();
  if (f.eventUnlocked && ev && ev.active && Date.now() < ev.endsAt) rows.push([ui.cb(tt(lang, 'event'), 'event_view', 'success')]);
  rows.push([ui.cb(tt(lang, 'settings'), 'settings')]);
  if (users.isAdmin(uid)) rows.push([ui.app(tt(lang, 'admin'), 'admin')]);
  return { text: lines.join('\n'), extra: { parse_mode: 'HTML', ...ui.kb(rows) } };
}
const backRow = (lang) => [ui.cb(tt(lang, 'back'), 'back_to_menu')];

// ─── Нагороди за друзів ─────────────────────────────────────────────────
function rewardsView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const lad = referrals.ladder(u, lang);
  const link = lad.link || '';
  const stIcon = { approved: tt(lang, 'stDone'), pending: tt(lang, 'stPend'), rejected: tt(lang, 'stRej'), claimable: tt(lang, 'stOk') };
  const lines = [tt(lang, 'rwTitle', { n: lad.count, link: esc(link) }), ''];
  const rows = [];
  for (const s of lad.steps) {
    lines.push(`${s.emoji} <b>${esc(s.name)}</b> — ${s.need} 👥 · ${stIcon[s.state] || tt(lang, 'stLock', { n: s.left })}`);
    if (s.state === 'claimable') rows.push([ui.cb(tt(lang, 'claim', { name: s.emoji + ' ' + s.name }), 'claim_' + s.id, 'success')]);
  }
  const share = link ? 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent({ uk: 'Заходь у StarForge — колеса удачі, ігри й справжні Telegram-подарунки 🎁', en: 'Join StarForge — wheels of luck, games and real Telegram gifts 🎁', ru: 'Заходи в StarForge — колёса удачи, игры и настоящие Telegram-подарки 🎁' }[lang]) : null;
  if (share) rows.unshift([ui.url(tt(lang, 'share'), share, 'primary')]);
  rows.push(backRow(lang));
  return { text: lines.join('\n'), extra: { parse_mode: 'HTML', disable_web_page_preview: true, ...ui.kb(rows) } };
}

// ─── Профіль і заявки ───────────────────────────────────────────────────
function profileView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const p = profile.view(u, lang);
  const st = p.stats;
  const lines = [tt(lang, 'pfTitle'), '', tt(lang, 'pf', {
    spins: st.spins, paid: st.paidSpins, prizes: st.prizes, best: esc(st.bestWin || tt(lang, 'nothing')),
    s: fmtStars(users.stars(u)), t: users.tickets(u), earned: fmtStars(st.earned), games: st.games,
    streak: st.streak, best2: st.bestStreak, friends: st.friends,
    lvl: p.level.e + ' ' + esc(p.level.t) + ' · ' + p.level.n, xp: Math.floor(p.level.xp),
  })];
  if (p.history.length) {
    lines.push('', tt(lang, 'lastWins'));
    for (const h of p.history.slice(0, 8)) lines.push('  ' + esc(h.title) + ' · ' + time.fmtKyiv(h.at, { day: 'numeric', month: 'short' }));
  }
  return { text: lines.join('\n'), extra: { parse_mode: 'HTML', ...ui.kb([[ui.cb(tt(lang, 'apps'), 'my_applications', 'primary')], backRow(lang)]) } };
}
function appsView(uid, filter) {
  const lang = L(uid);
  const all = applications.listFor(uid);
  const cnt = (s) => all.filter(a => a.status === s).length;
  const list = all.filter(a => a.status === filter).slice(0, 25).map(a => applications.publicView(a, lang));
  const lines = [tt(lang, 'apTitle'), ''];
  if (!list.length) lines.push('<i>' + tt(lang, 'apNone') + '</i>');
  for (const a of list) lines.push(`${esc(a.title)} · #${a.id} · ${time.fmtKyiv(a.createdAt, { day: 'numeric', month: 'short' })}` + (a.reason ? ' · ' + esc(a.reason) : ''));
  const btn = (s, k) => ui.cb(`${tt(lang, k)} (${cnt(s)})`, 'myapp_' + s, filter === s ? 'primary' : undefined);
  return { text: lines.join('\n'), extra: { parse_mode: 'HTML', ...ui.kb([[btn('pending', 'fPend'), btn('approved', 'fOk')], [btn('rejected', 'fRej')], backRow(lang)]) } };
}

// ─── Налаштування ───────────────────────────────────────────────────────
function settingsView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const yn = (v) => tt(lang, v ? 'on' : 'off');
  const langName = { uk: 'Українська', en: 'English', ru: 'Русский' }[u.lang || 'uk'];
  const anon = !!u.anonymous, ref = u.notifyOnReferral !== false, rem = !u.remindersOff;
  return {
    text: tt(lang, 'stTitle'),
    extra: { parse_mode: 'HTML', ...ui.kb([
      [ui.cb(tt(lang, 'lang', { l: langName }), 'lang_menu')],
      [ui.cb(tt(lang, 'anon', { v: yn(anon) }), 'toggle_anon', anon ? 'success' : undefined)],
      [ui.cb(tt(lang, 'ref', { v: yn(ref) }), 'toggle_ref_notify', ref ? 'success' : undefined)],
      [ui.cb(tt(lang, 'rem', { v: yn(rem) }), 'toggle_reminders', rem ? 'success' : undefined)],
      [ui.cb(tt(lang, 'apps'), 'my_applications', 'primary')],
      backRow(lang),
    ]) },
  };
}

// ─── Банк у боті ────────────────────────────────────────────────────────
function bankView(uid) {
  const lang = L(uid);
  const v = bank.view(uid);
  const rows = [];
  if (!v.active || v.status !== 'open') {
    rows.push([ui.app(tt(lang, 'bkApp'), 'bank', 'primary')], backRow(lang));
    return { text: tt(lang, 'bkTitle') + '\n\n' + tt(lang, 'bkNone'), extra: { parse_mode: 'HTML', ...ui.kb(rows) } };
  }
  const top = v.sectors.slice(0, 6).map((s, i) => `${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'} ${esc(s.name)} — ${s.percent}%`).join('\n');
  const text = tt(lang, 'bkTitle') + '\n\n' + tt(lang, 'bk', {
    p: fmtStars(v.prize.stars), tx: v.prize.tickets ? ' + ' + v.prize.tickets + '🎫' : '', n: v.players,
    when: whenOf(v.drawAt, lang), left: time.humanLeft(Math.max(0, v.drawAt - Date.now())),
    mine: v.mine.weight > 0 ? tt(lang, 'bkMine', { w: fmtStars(v.mine.weight), c: v.mine.chance }) : tt(lang, 'bkNotIn'),
    top: top ? tt(lang, 'bkTop') + '\n' + top + '\n' : '',
  });
  const bets = [5, 10, 25, 50, 100].filter(n => n <= v.balance);
  for (let i = 0; i < bets.length; i += 3) rows.push(bets.slice(i, i + 3).map(n => ui.cb(n + '⭐', 'bank_bet_' + n, 'success')));
  rows.push([ui.cb(tt(lang, 'bkOwn'), 'bank_own', 'primary')]);
  rows.push([ui.app(tt(lang, 'bkApp'), 'bank')]);
  rows.push(backRow(lang));
  return { text, extra: { parse_mode: 'HTML', ...ui.kb(rows) } };
}
async function placeBet(ctx, uid, amount) {
  const lang = L(uid);
  const r = await bank.bet(uid, amount, 0);
  if (!r.ok) return ctx.reply((T[lang].bkErr || T.uk.bkErr)[r.error] || T.uk.bkErr.bad_amount).catch(() => {});
  await ctx.reply(tt(lang, 'bkOk', { s: Math.floor(Number(amount)), c: r.chance, p: fmtStars(r.pot) }), { parse_mode: 'HTML', ...ui.kb([[ui.cb('🏦', 'bank_show', 'primary'), ui.app(tt(lang, 'bkApp'), 'bank')]]) }).catch(() => {});
}

// ─── Поповнення ─────────────────────────────────────────────────────────
function topupView(uid) {
  const lang = L(uid);
  const u = users.get(uid) || {};
  const info = wallet.topupInfo(u);
  const rows = [];
  const ps = info.presets;
  for (let i = 0; i < ps.length; i += 3) rows.push(ps.slice(i, i + 3).map(n => ui.cb(n + '⭐', 'topup_' + n, 'success')));
  rows.push([ui.cb(tt(lang, 'tpOwn'), 'topup_own', 'primary')], backRow(lang));
  return { text: tt(lang, 'tpTitle', { b: fmtStars(users.stars(u)), bonus: info.bonusLeft ? tt(lang, 'tpBonus', { p: info.bonusPercent, n: info.bonusLeft }) : '' }), extra: { parse_mode: 'HTML', ...ui.kb(rows) } };
}
async function sendInvoice(ctx, uid, amount) {
  const lang = L(uid);
  const r = await wallet.invoiceLink(uid, 'topup', amount);
  if (!r.ok) return ctx.reply(tt(lang, 'tpErr')).catch(() => {});
  await ctx.reply(tt(lang, 'tpReady', { a: r.price }), { parse_mode: 'HTML', ...ui.kb([[ui.url(tt(lang, 'tpPay', { a: r.price }), r.link, 'success')]]) }).catch(() => {});
}

// ─── Подія ──────────────────────────────────────────────────────────────
function eventView(uid) {
  const lang = L(uid);
  const ev = store.getEvent();
  const u = users.get(uid) || {};
  const ranked = Object.values(users.all()).filter(x => x && (x.eventReferrals || 0) > 0 && !users.isAdmin(x.id)).sort((a, b) => b.eventReferrals - a.eventReferrals).slice(0, 10);
  const top = ranked.map((x, i) => `${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'} ${esc(users.displayName(x))} — ${x.eventReferrals}`).join('\n');
  return { text: tt(lang, 'evTitle') + '\n\n' + tt(lang, 'ev', { when: ev ? whenOf(ev.endsAt, lang) : '—', mine: u.eventReferrals || 0, top }), extra: { parse_mode: 'HTML', ...ui.kb([[ui.cb(tt(lang, 'rewards'), 'rewards', 'primary')], backRow(lang)]) } };
}

function register(bot, hooks, gate) {
  const priv = (ctx) => !ctx.chat || ctx.chat.type === 'private';
  const send = (build, needGate) => async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (!priv(ctx)) return;
    const uid = String(ctx.from.id);
    users.ensure(ctx.from);
    if (needGate !== false && gate && !(await gate(ctx, uid))) return;
    const v = build(uid, ctx);
    await ctx.reply(v.text, v.extra).catch(() => {});
  };
  bot.command('menu', send(mainMenu));
  bot.action(['back_to_menu', 'menu_back'], async (ctx) => { await ctx.deleteMessage().catch(() => {}); return send(mainMenu)(ctx); });
  bot.action('rewards', send(rewardsView));
  bot.action(/^claim_([a-z0-9_]+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    const lang = L(uid);
    if (gate && !(await gate(ctx, uid))) return;
    const r = await referrals.claimLadder(uid, ctx.match[1]);
    if (!r.ok) return ctx.reply((T[lang].claimErr || T.uk.claimErr)[r.error] || T.uk.claimErr.not_enough_friends).catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(tt(lang, 'claimed', { id: r.applicationId, name: E.getTier(ctx.match[1]).emoji + ' ' + E.tierName(ctx.match[1], lang) })).catch(() => {});
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
  bot.action('change_language', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await ctx.reply('🌐', ui.kb([[ui.cb('🇺🇦 Українська', 'lang_uk'), ui.cb('🇬🇧 English', 'lang_en'), ui.cb('🇷🇺 Русский', 'lang_ru')]])).catch(() => {}); });

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
    awaiting.set(uid, { kind: 'bank', at: Date.now() });
    await ctx.reply(tt(L(uid), 'bkAsk', { b: fmtStars(users.stars(users.get(uid) || {})) }), { parse_mode: 'HTML' }).catch(() => {});
  });

  bot.command('topup', send(topupView, false));
  bot.action('topup_menu', send(topupView, false));
  bot.action(/^topup_(\d+)$/, async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await sendInvoice(ctx, String(ctx.from.id), ctx.match[1]); });
  bot.action('topup_own', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id);
    awaiting.set(uid, { kind: 'topup', at: Date.now() });
    await ctx.reply(tt(L(uid), 'tpAsk'), { parse_mode: 'HTML' }).catch(() => {});
  });
  // Вивід завжди був у застосунку — ведемо туди.
  bot.action(['withdraw_stars', 'withdraw_stars_custom'], async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lang = L(String(ctx.from.id));
    await ctx.reply(tt(lang, 'withdraw'), ui.kb([[ui.app(tt(lang, 'withdraw'), 'withdraw', 'success')]])).catch(() => {});
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

module.exports = { register, mainMenu };
