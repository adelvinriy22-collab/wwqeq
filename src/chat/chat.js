// ===========================================================================
// 💬 ЧАТ — щоб там ніколи не було нудно.
//
//   🎁 Дропи       кілька разів на день кнопка «хто перший — той забрав»
//   🧠 Вікторини   питання з кнопками, перший правильний забирає білети
//   ⚔️ Дуелі       /duel 5 — двоє кидають кубик на білети, переможець забирає банк
//   ✨ XP за чат   повідомлення дають XP — той самий, що рівень, пас і ліга
//   📣 Оголошення  великі виграші й нові рівні потрапляють у чат самі
//   👋 Привітання  новачок одразу отримує кнопку в бота
//
// Усе на БІЛЕТАХ, а не на зірках: ставки дрібні, економіку не ламає.
// Усі рухи білетів і зірок ідуть через users.move — з журналом.
//
// ВИМОГА: бот має бути адміністратором чату, інакше Telegram не пересилає
// йому звичайні повідомлення (і XP за чат не рахуватиметься).
// ===========================================================================
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const time = require('../lib/time');
const econ = require('../economy');
const { EMOJI } = require('../emoji');

const CFG = {
  dropMinGapMin: 70,          // між дропами — від 70 хв
  dropMaxGapMin: 170,         // до 170 хв
  quizEveryMin: 150,          // вікторина приблизно раз на 2,5 год
  activeFromHour: 10,         // працюємо з 10:00
  activeToHour: 23,           // до 23:00 за Києвом
  // ЕКОНОМІКА. Білети обмінюються на зірки (10🎫 = 2⭐), тож кожен білет — це
  // реальні гроші. Масові щоденні нагороди тепер дають ОЧКИ РІВНЯ (безкоштовно),
  // а зірки й білети лишились там, де вони рідкісні й помітні.
  dropPrizes: [               // шанс → нагорода
    { w: 60, tickets: 2 },
    { w: 30, tickets: 3 },
    { w: 10, tickets: 5 },
  ],
  quizPrize: 2,               // білетів за правильну відповідь
  quizPts: 10,                // + очки рівня
  duelMin: 1, duelMax: 50,    // ставка в дуелі, білети
  duelBurnPercent: 10,        // 10% банку дуелі згорає — стік білетів
  duelTimeoutSec: 90,
  chatXpMinLen: 8,            // повідомлення коротші не рахуються
  chatXpCooldownSec: 30,      // не частіше одного разу на 30 с
  announceGapSec: 90,         // оголошення про виграші — не частіше
  announceDayCap: 25,
  leagueTopHour: 21,          // щовечора о 21:00 — таблиця ліги
  bonusStars: 0,              // /bonus — щодня без зірок…
  bonusTickets: 1,            // …1 білет
  bonusPts: 5,                // …і очки рівня
  bonusNeedMsgs: 3,           // …але лише тим, хто сьогодні написав у чаті хоча б 3 повідомлення
  bonusStreakEvery: 7,        // кожен 7-й день поспіль — ще +
  bonusStreakExtra: 1,        // зірка — лише на кожен 7-й день поспіль
  activistHour: 22,           // о 22:00 — «Активіст дня»
  activistTeaserHour: 18,     // о 18:00 — «хто лідирує зараз»
  activistMinMsgs: 10,        // менше 10 повідомлень за день — не претендує
  // Нагорода активістам: зірки + XP ліги. Раніше було 10🎫 (≈2⭐) — нікому не цікаво.
  activistPrizes: [
    { stars: 2, tickets: 0, xp: 40 },   // 🥇
    { stars: 1, tickets: 0, xp: 20 },   // 🥈
    { stars: 0, tickets: 5, xp: 10 },   // 🥉
  ],
  actMinLen: 3,               // для лічильника активності — від 3 символів
  // Очки за повідомлення — БЕЗ денної стелі: кожне змістовне повідомлення = очко.
  // Від флуду захищають лише пауза 5 с і заборона однакових повідомлень підряд.
  msgPtsMinLen: 5,
  actCooldownSec: 5,          // і не частіше разу на 5 с (захист від флуду)

  // 🎯 Спільна ціль дня: чат разом пише N повідомлень — усі учасники отримують бонус.
  goalTarget: 200,
  goalMinPer: 5,              // щоб отримати бонус, треба самому написати хоча б 5
  goalTickets: 0,             // ціль — лише очки рівня
  goalXp: 25,

  // ⚡ Хто швидший: анаграма, перший правильний отримує очки + білет.
  raceEveryMin: 140, racePts: 15, raceTickets: 1, raceTimeoutSec: 240,
  // 🍀 Щасливе повідомлення: випадкове, не частіше разу на день на людину.
  luckyChance: 70,            // ≈ одне з 70 повідомлень
  luckyPts: 20, luckyDayCap: 8,
  // 🔥 Серія в чаті: днів поспіль з 5+ повідомленнями → бонуси очок на віхах.
  streakMinMsgs: 5,
  streakMilestones: { 3: 30, 7: 70, 14: 150, 30: 300 },
  morningHour: 10,            // ☀️ ранковий анонс

  // 🔥 Гаряча година: раз на день 30 хв, коли XP і бали змагання ×2.
  hhFromHour: 16, hhToHour: 21, hhMinutes: 30,
};

// 🏅 Змагання активності в чаті. Бали за все, що людина робить у чаті.
// Дрібні ставки в дуелях і флуд не рахуються — щоб не можна було нафармити
// бали з другом на дуелях по 1 білету чи спамом.
const CONTEST = {
  msg: 1,          // повідомлення (ті самі правила, що для XP: від 8 символів, раз на 30 с)
  msgCap: 60,      // максимум балів за повідомлення
  duel: 3,         // зіграна дуель (ставка від 2🎫)
  duelWin: 2,      // додатково за перемогу
  duelCap: 8,      // скільки дуелів на людину враховується
  duelMinStake: 2,
  drop: 5,         // забраний дроп
  quiz: 5,         // правильна відповідь у вікторині
  minPts: 10,      // мінімум балів, щоб претендувати на приз
};

const QUIZ = [
  { q: 'Скільки секторів на щоденному колесі?', a: ['10', '12', '14'], ok: 2 },
  { q: 'Скільки білетів дорівнюють 2⭐ в обміні?', a: ['5', '10', '20'], ok: 1 },
  { q: 'Який титул іде після «Активіста»?', a: ['Ветеран', 'Завсідник', 'Балакун'], ok: 1 },
  { q: 'Який найвищий титул у чаті?', a: ['Легенда', 'Міф', 'Майстер'], ok: 1 },
  { q: 'Скільки коштує спін колеса «За зірки»?', a: ['10⭐', '15⭐', '25⭐'], ok: 1 },
  { q: 'Який приз за 1 місце в лізі тижня?', a: ['Мішка', 'Ракета', 'Трофей'], ok: 2 },
  { q: 'Що отримує кожен учасник банку, навіть програвши?', a: ['Нічого', 'Утішні білети', 'Зірку'], ok: 1 },
  { q: 'Яка найменша нагорода на щоденному колесі?', a: ['1⭐', '2⭐', '5⭐'], ok: 1 },
  { q: 'Скільки дає 7️⃣7️⃣7️⃣ у слоті?', a: ['×6', '×10', '×20'], ok: 2 },
  { q: 'Скільки планет у Сонячній системі?', a: ['7', '8', '9'], ok: 1 },
  { q: 'Яка найшвидша тварина на суші?', a: ['Лев', 'Гепард', 'Антилопа'], ok: 1 },
  { q: 'Скільки ніг у павука?', a: ['6', '8', '10'], ok: 1 },
  { q: 'Яка найбільша планета Сонячної системи?', a: ['Сатурн', 'Юпітер', 'Нептун'], ok: 1 },
  { q: 'Скільки хвилин у добі?', a: ['1240', '1440', '1640'], ok: 1 },
  { q: 'Скільки граней у кубика?', a: ['4', '6', '8'], ok: 1 },
  { q: 'Яке море омиває Одесу?', a: ['Азовське', 'Чорне', 'Каспійське'], ok: 1 },
  { q: 'Скільки кольорів у веселці?', a: ['5', '7', '9'], ok: 1 },
  { q: 'Що важче: кілограм пір\'я чи кілограм заліза?', a: ['Залізо', 'Пір\'я', 'Однаково'], ok: 2 },
];

function pickWeighted(list) {
  const total = list.reduce((s, x) => s + x.w, 0);
  let r = crypto.randomInt(1000000) / 1000000 * total;
  for (const x of list) { r -= x.w; if (r <= 0) return x; }
  return list[list.length - 1];
}

function randBetween(a, b) { return a + crypto.randomInt(Math.max(1, b - a + 1)); }

function kyivHour(ts) {
  return +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false })
    .format(new Date(ts)) % 24;
}
function kyivDay(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(ts));
}

function esc(s) { return String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

// ---------------------------------------------------------------------------
function createChat(bot, opts) {
  const db = store;
  const chatRef = (opts && opts.chatRef) || config.CHAT_USERNAME;
  const isAdminUid = (id) => users.isAdmin(id);
  const getBotUsername = () => notify.tg.botUsername;
  const ticketsOf = (u) => users.tickets(u);
  // Білети: true — рух пройшов (для ставок — вистачило білетів).
  const addTickets = (uid, n, why) => users.move(String(uid), { tickets: n }, 'chat', { why }).ok;
  const addStars = (uid, n, why) => users.move(String(uid), { stars: n }, 'chat', { why }).ok;
  const xpTotal = (u) => progress.xpOf(u).total;
  const EM = EMOJI;

  // ── Оформлення ──────────────────────────────────────────────────────────
  // Преміум-емодзі в HTML: <tg-emoji>. Якщо id немає — звичайний символ.
  function E(key, alt) {
    const e = EM[key];
    if (e && e.id) return '<tg-emoji emoji-id="' + e.id + '">' + e.fallback + '</tg-emoji>';
    return (e && e.fallback) || alt || '';
  }
  const LINE = '━━━━━━━━━━━━━━';
  const TIX = '🎫';
  // Картка: заголовок, розділювач, рядки, підпис курсивом унизу.
  function card(icon, title, lines, foot) {
    return E(icon, icon) + ' <b>' + title + '</b>\n' + LINE + '\n' +
      lines.filter(l => l !== null && l !== undefined && l !== false).join('\n') +
      (foot ? '\n\n<i>' + foot + '</i>' : '');
  }
  // Кнопки з кольором і преміум-іконкою — як у приватному меню бота.
  function btn(text, data, style, icon) {
    const b = { text, callback_data: data };
    if (style) b.style = style;
    if (icon && EM[icon] && EM[icon].id) b.icon_custom_emoji_id = EM[icon].id;
    return b;
  }
  function ubtn(text, url, style, icon) {
    const b = { text, url };
    if (style) b.style = style;
    if (icon && EM[icon] && EM[icon].id) b.icon_custom_emoji_id = EM[icon].id;
    return b;
  }
  const MEDAL = ['goldMedal', 'silverMedal', 'bronzeMedal'];
  // Текст нагороди з налаштувань — щоб написане ніколи не розходилось із видачею.
  function prizeText(p, star) {
    const out = [];
    if (p.stars) out.push('+' + p.stars + (star ? ' ' + star : '⭐'));
    if (p.tickets) out.push('+' + p.tickets + ' ' + TIX);
    if (p.xp) out.push('+' + p.xp + ' XP');
    return out.join('  ');
  }
  function goalText() { return prizeText({ tickets: CFG.goalTickets, xp: CFG.goalXp }); }
  function medal(i) { return i < 3 ? E(MEDAL[i], ['🥇', '🥈', '🥉'][i]) : '<b>' + (i + 1) + '.</b>'; }

  let chatId = null;                 // числовий id чату
  const bootAt = Date.now();         // дуелі, створені ДО цього моменту, — завислі
  const lastXpAt = new Map();        // uid -> час останнього XP за чат
  let lastAnnounceAt = 0;
  const duels = new Map();           // id -> дуель (живуть секунди)

  function st() { return (db.getFeatureFlags() || {}).chat || {}; }
  function setSt(patch) { db.setFeatureFlags({ chat: { ...st(), ...patch } }); }

  // Свій чат упізнаємо трьома способами. Раніше — лише пошуком за @username
  // при старті: якщо той пошук не вдався, бот мовчки ігнорував УВЕСЬ чат,
  // і жодна команда не працювала.
  function isOurChat(ctx) {
    if (!ctx.chat) return false;
    if (chatId && String(ctx.chat.id) === String(chatId)) return true;
    const want = String(chatRef || '').replace('@', '').toLowerCase();
    if (ctx.chat.username && ctx.chat.username.toLowerCase() === want) {
      bindChat(ctx.chat.id, 'за username у першому повідомленні');
      return true;
    }
    const saved = st().boundId;
    if (saved && String(saved) === String(ctx.chat.id)) { chatId = saved; return true; }
    return false;
  }

  function bindChat(id, how) {
    chatId = id;
    setSt({ boundId: id });
    console.log('💬 Чат прив\'язано (' + how + '): ' + id);
    loadAllowedReactions();
    checkBotRights();
    setupCommandMenu().catch(() => {});
  }
  function nameOf(from) {
    return from && from.username ? '@' + from.username : esc((from && from.first_name) || 'гравець');
  }
  function botLink(start) {
    const u = getBotUsername();
    return u ? 'https://t.me/' + u + (start ? '?start=' + start : '') : null;
  }
  // «У боті» — це пройшов /start і вибрав мову. Просто запис у базі не
  // рахується: він з'являється й для Premium-людей, які бота не запускали.
  function registered(uid) { const u = db.getUser(String(uid)); return !!(u && u.lang); }
  // «Гість» — пише в чаті, але ще не запускав бота. Його активність і очки рахуються
  // одразу (раніше мовчки ігнорувались), а призи зірками й білетами — лише в боті.
  function known(uid) { return !!db.getUser(String(uid)); }
  function ensureGuest(from) {
    const uid = String(from.id);
    if (db.getUser(uid)) return;
    db.upsertUser(uid, {
      id: uid, name: from.first_name || '', username: from.username || null,
      lang: null, joinedAt: Date.now(), invitedIds: [], eventReferrals: 0, subscribed: false, chatGuest: true,
    });
  }
  // Діагностика: що бот реально отримує з чату сьогодні.
  let dbg = { day: null, recv: 0, text: 0, media: 0, guests: 0, counted: 0 };
  function dbgHit(k) { const d = kyivDay(Date.now()); if (dbg.day !== d) dbg = { day: d, recv: 0, text: 0, media: 0, guests: 0, counted: 0 }; dbg[k]++; }

  async function resolveChat() {
    const saved = st().boundId;
    if (saved && !chatId) chatId = saved;
    try {
      const c = await bot.telegram.getChat(chatRef);
      chatId = c.id;
      setSt({ boundId: c.id });
      console.log('💬 Чат підключено:', chatRef, '(' + chatId + ')');
      loadAllowedReactions();
      checkBotRights();
      setupCommandMenu().catch(() => {});
    } catch (e) {
      if (chatId) return;
      console.log('💬 Чат ' + chatRef + ' не знайдено — додай бота в чат адміном. (' + e.message + ')');
    }
  }

  async function send(text, extra) {
    if (!chatId || st().paused) return null;
    try { return await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); }
    catch (e) { console.error('chat send:', e.message); return null; }
  }



  // ─────────────────────── 📊 АКТИВНІСТЬ ───────────────────────
  // Окремий від XP лічильник: будь-яке повідомлення від 3 символів раз на 5 с.
  // Саме він визначає «Активіста дня» й спільну ціль — щоб найактивніший
  // у чаті й за лічильником бота був тією самою людиною.
  const lastActAt = new Map();
  // Автори останніх повідомлень: з посилання на повідомлення Telegram не
  // дає дізнатись автора, тому для «джекпоту» бот пам'ятає їх сам.
  const authors = new Map();          // message_id -> { uid, name, plain }
  function rememberAuthor(ctx) {
    if (!ctx.message || !ctx.from || ctx.from.is_bot) return;
    authors.set(ctx.message.message_id, {
      uid: String(ctx.from.id), name: nameOf(ctx.from),
      plain: ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || 'гравець'),
    });
    if (authors.size > 5000) authors.delete(authors.keys().next().value);
  }
  let curMsgId = null;          // повідомлення, що зараз обробляється (для реакцій)
  let curMsgTs = 0;             // коли людина його НАДІСЛАЛА (а не коли бот до нього дійшов)
  let curText = '';
  const lastTextOf = new Map();  // однакові повідомлення підряд очок не дають

  function actCount(u, today) { return u && u.chatActDay === today ? (u.chatActCount || 0) : 0; }

  function countActivity(uid) {
    // Пауза рахується між часом відправлення повідомлень. Якщо бот отримав кілька
    // повідомлень разом (після затримки), раніше всі, крім одного, відкидались.
    const now = curMsgTs || Date.now();
    const prev = lastActAt.get(uid) || 0;
    if (prev && Math.abs(now - prev) < CFG.actCooldownSec * 1000) return false;
    lastActAt.set(uid, Math.max(prev, now));
    const today = kyivDay(now);
    const u = db.getUser(uid) || {};
    const n = actCount(u, today) + 1;
    db.upsertUser(uid, { chatActDay: today, chatActCount: n });
    goalProgress(uid, n, today);
    bumpStreak(uid, n);
    // Очки за повідомлення — з денною межею й без повторів.
    const norm = String(curText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const same = norm && lastTextOf.get(uid) === norm;
    lastTextOf.set(uid, norm);
    if (!same && norm.length >= CFG.msgPtsMinLen) {
      const uu = db.getUser(uid) || {};
      const fresh = uu.msgPtsDay !== today;
      const got = fresh ? 0 : (uu.msgPtsToday || 0);
      const give = isHappy() ? 2 : 1;
      db.upsertUser(uid, { msgPtsDay: today, msgPtsToday: got + give });
      addChatPts(uid, give, curMsgId);
    }
    questProg(uid, 'msgs', 1, curMsgId);
    if (!same && norm.length >= 8) maybeLucky(uid, curMsgId);
    return true;
  }

  function actRows(today) {
    const rows = [];
    for (const [uid, u] of Object.entries(db.allUsers ? db.allUsers() : {})) {
      const n = actCount(u, today);
      if (n > 0 && u.lang && !isAdminUid(uid)) rows.push({ uid, n });
    }
    return rows.sort((a, b) => b.n - a.n);
  }

  // ─────────────────────── 🎯 СПІЛЬНА ЦІЛЬ ДНЯ ───────────────────────
  function goalBar(n) {
    const f = Math.max(0, Math.min(10, Math.floor(n / CFG.goalTarget * 10)));
    return '🟩'.repeat(f) + '⬜'.repeat(10 - f);
  }

  function goalState(today) {
    const g = st().goal || {};
    return g.day === today ? g : { day: today, count: 0, done: false, marks: [] };
  }

  function goalProgress(uid, myCount, today) {
    const g = goalState(today);
    g.count++;
    const pct = Math.floor(g.count / CFG.goalTarget * 100);
    for (const mark of [25, 50, 75]) {
      if (pct >= mark && !g.marks.includes(mark)) {
        g.marks.push(mark);
        send(card('statsIcon', 'СПІЛЬНА ЦІЛЬ ДНЯ · ' + mark + '%', [
          goalBar(g.count) + '  <b>' + g.count + ' / ' + CFG.goalTarget + '</b>',
          '',
          'Дійдемо — кожен, хто написав <b>' + CFG.goalMinPer + '+</b> повідомлень, отримає <b>' + goalText() + '</b>',
        ], 'Пишіть разом — що швидше, то краще 🔥'));
      }
    }
    if (!g.done && g.count >= CFG.goalTarget) {
      g.done = true;
      setSt({ goal: g });
      finishGoal(today);
      return;
    }
    setSt({ goal: g });
    // Ціль уже виконана, а людина щойно добрала свої 5 — теж отримує бонус.
    if (g.done && myCount === CFG.goalMinPer) payGoal(uid, today, true);
  }

  function payGoal(uid, today, late) {
    const u = db.getUser(uid) || {};
    if (u.chatGoalPaid === today || isAdminUid(uid)) return false;
    db.upsertUser(uid, { chatGoalPaid: today });
    if (CFG.goalTickets) addTickets(uid, CFG.goalTickets, 'спільна ціль чату');
    addChatPts(uid, CFG.goalXp, null);
    if (late) {
      bot.telegram.sendMessage(uid, card('trophy', 'БОНУС СПІЛЬНОЇ ЦІЛІ', [
        E('check', '✅') + ' Ти добрав ' + CFG.goalMinPer + ' повідомлень — бонус твій:',
        '<b>' + goalText() + '</b>',
      ]), { parse_mode: 'HTML' }).catch(() => {});
    }
    return true;
  }

  async function finishGoal(today) {
    const paid = actRows(today).filter(r => r.n >= CFG.goalMinPer).map(r => r.uid).filter(uid => payGoal(uid, today, false));
    await send(card('trophy', 'СПІЛЬНУ ЦІЛЬ ВИКОНАНО!', [
      E('check', '✅') + ' Чат написав <b>' + CFG.goalTarget + ' повідомлень</b> за день',
      E('crown', '👑') + ' Бонус отримали: <b>' + paid.length + '</b> учасник(ів)',
      'Кожному: <b>' + goalText() + '</b>',
    ], 'Ще не написав ' + CFG.goalMinPer + ' повідомлень? Добери сьогодні — і бонус прийде тобі теж.'));
  }

  // ─────────────────────── 🔥 ГАРЯЧА ГОДИНА ───────────────────────
  function hhWindow(today) {
    const s = st();
    if (s.hhDay === today && s.hhStart) return { start: s.hhStart, end: s.hhStart + CFG.hhMinutes * 60000 };
    return null;
  }
  function isHappy() {
    const w = hhWindow(kyivDay(Date.now()));
    return !!(w && Date.now() >= w.start && Date.now() < w.end);
  }
  function planHappyHour(today) {
    // Випадковий старт між 16:00 і 21:00 за Києвом — щоб не можна було передбачити.
    const from = time.parseKyiv(today + ' ' + String(CFG.hhFromHour).padStart(2, '0') + ':00');
    const to = time.parseKyiv(today + ' ' + String(CFG.hhToHour).padStart(2, '0') + ':00');
    if (!from || !to) return;
    const start = from + crypto.randomInt(Math.max(1, to - from - CFG.hhMinutes * 60000));
    setSt({ hhDay: today, hhStart: start, hhAnnounced: false, hhEnded: false });
  }




  // ═══════ Реєстр усіх груп, де є бот — для розсилки по чатах ═══════
  function rememberChat(ctx) {
    const ch = ctx.chat; if (!ch) return;
    const known = st().known || {};
    const left = ctx.updateType === 'my_chat_member' && ctx.myChatMember &&
      ['left', 'kicked'].includes(ctx.myChatMember.new_chat_member.status);
    if (left) { delete known[ch.id]; setSt({ known }); return; }
    const prev = known[ch.id];
    if (prev && prev.title === ch.title && Date.now() - (prev.at || 0) < 3600000) return;
    known[ch.id] = { title: ch.title || '', username: ch.username || null, at: Date.now() };
    setSt({ known });
  }
  function listChats() {
    const k = st().known || {};
    if (chatId && !k[chatId]) k[chatId] = { title: chatRef, username: String(chatRef).replace('@', ''), at: Date.now() };
    return Object.entries(k).map(([id, v]) => ({ id: Number(id), ...v }));
  }


  // ═══════ 🔒 СЕКРЕТНА /autowithdraw — відсоток готовності автовиводу ═══════
  // Відсоток задає адмін (/autowithdraw 73 в особистих). У меню й /help її немає —
  // люди «знаходять» команду самі, на цьому й тримається інтрига.
  const AW_LINES = ['Ключ уже в когось із чату… 🔑', 'Відкриється першим для легенд 👑', 'Щось готується… ✨',
    'Зірки вже чекають за дверима ⭐', 'Тільки для найактивніших 🔥'];
  function autowdCard() {
    const a = (db.getFeatureFlags() || {}).autowd || {};
    const pct = Math.max(0, Math.min(100, a.pct || 0));
    const f = Math.round(pct / 10);
    const bar = '🟨'.repeat(f) + '⬛'.repeat(10 - f);
    return card('lockIcon', 'АВТОВИВІД', [
      '🔐 Ти знайшов секретну команду',
      '',
      'Готовність: <b>' + pct + '%</b>',
      bar,
      '',
      '<i>' + (a.note || AW_LINES[Math.floor(Date.now() / 3600000) % AW_LINES.length]) + '</i>',
    ], pct >= 100 ? 'Майже відчинено… слідкуй за чатом 👀' : 'Відкриється першим для найактивніших гравців чату');
  }

  // ═══════════════════════ 🎰 ДЖЕКПОТ ВІД АДМІНА ═══════════════════════
  // Адмін у приваті вставляє посилання на повідомлення — бот відповідає на
  // нього в чаті «ДЖЕКПОТ!», ставить 🎉 і закликає всіх спілкуватись.
  async function jackpot(msgId, winner, prizeLabel) {
    if (!chatId) return false;
    const caption = card('crown', 'ДЖЕКПОТ!', [
      E('crown', '👑') + ' <b>' + winner.name + '</b>, ти виграв <b>' + prizeLabel + '</b>!',
      E('check', '✅') + ' Приз уже чекає на тебе в боті',
      '',
      E('almost', '🔥') + ' <b>Хочеш так само? Спілкуйся в чаті!</b>',
      'Бот стежить за активністю й роздає призи найактивнішим',
    ]);
    const extra = { caption, parse_mode: 'HTML', reply_to_message_id: msgId, allow_sending_without_reply: true };
    // Картинку завантажуємо один раз, далі шлемо за file_id — швидше й без повторного завантаження.
    let m = null;
    const cached = st().jpFileId;
    const jpFile = require('path').join(__dirname, '..', '..', 'web', 'img', 'jackpot.jpg');
    try {
      // Файлу картинки може не бути в деплої — тоді одразу текстом, без помилки.
      if (!cached && !require('fs').existsSync(jpFile)) throw new Error('no jackpot.jpg');
      m = await bot.telegram.sendPhoto(chatId, cached || { source: jpFile }, extra);
      const ph = m && m.photo && m.photo[m.photo.length - 1];
      if (ph && ph.file_id && ph.file_id !== cached) setSt({ jpFileId: ph.file_id });
    } catch (e) {
      // Якщо картинка з якоїсь причини не пішла — оголошуємо текстом, щоб джекпот не загубився.
      m = await send(caption, { reply_to_message_id: msgId, allow_sending_without_reply: true });
    }
    react(msgId, '🎉');
    return !!m;
  }


  // ═══════════════════════ ⚡ ХТО ШВИДШИЙ (анаграма) ═══════════════════════
  const WORDS = ['ЗІРКА', 'РАКЕТА', 'МІШКА', 'ДЖЕКПОТ', 'ЛЕГЕНДА', 'ДУЕЛЬ', 'КОЛЕСО', 'ТРОФЕЙ', 'ПОДАРУНОК',
    'ВЕТЕРАН', 'МАЙСТЕР', 'КВЕСТ', 'БІЛЕТ', 'ВІКТОРИНА', 'СЕРІЯ', 'ВИГРАШ', 'УДАЧА', 'КОМЕТА', 'ГАЛАКТИКА', 'ПЛАНЕТА'];
  function shuffleWord(w) {
    const a = w.split('');
    for (let k = 0; k < 20; k++) {
      for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
      if (a.join('') !== w) break;
    }
    return a.join(' ');
  }
  async function postRace() {
    const s = st();
    const used = s.raceUsed || [];
    let pool = WORDS.filter(w => !used.includes(w)); if (!pool.length) pool = WORDS.slice();
    const w = pool[crypto.randomInt(pool.length)];
    const m = await send(card('lightning', 'ХТО ШВИДШИЙ?', [
      'Розгадай слово:',
      '',
      '<b>' + shuffleWord(w) + '</b>',
      '',
      E('crown', '👑') + ' Перший, хто <b>напише його в чат</b> правильно, отримує <b>' + prizeText({ tickets: CFG.raceTickets, xp: CFG.racePts }) + '</b>',
    ], 'Є ' + Math.round(CFG.raceTimeoutSec / 60) + ' хвилини'));
    if (!m) return false;
    setSt({ race: { w, at: Date.now(), msgId: m.message_id, won: null }, raceUsed: used.concat([w]).slice(-10) });
    return true;
  }
  // Викликається для кожного повідомлення — чи не розгадав хтось слово.
  function checkRace(ctx, text) {
    const r = st().race;
    if (!r || r.won || Date.now() - r.at > CFG.raceTimeoutSec * 1000) return false;
    const guess = String(text || '').toUpperCase().replace(/[^А-ЯЄІЇҐA-Z]/g, '');
    if (guess !== r.w) return false;
    const uid = String(ctx.from.id);
    if (!registered(uid) || isAdminUid(uid)) return false;
    r.won = { uid, name: nameOf(ctx.from) };
    setSt({ race: r });
    const secs = Math.max(1, Math.round((Date.now() - r.at) / 1000));
    if (CFG.raceTickets) addTickets(uid, CFG.raceTickets, 'хто швидший');
    addChatPts(uid, CFG.racePts, ctx.message.message_id);
    react(ctx.message.message_id, '⚡');
    send(E('lightning', '⚡') + ' <b>' + r.won.name + '</b> розгадав <b>' + r.w + '</b> за ' + secs + ' с!  <b>' +
      prizeText({ tickets: CFG.raceTickets, xp: CFG.racePts }) + '</b>', { reply_to_message_id: ctx.message.message_id });
    return true;
  }
  async function expireRace() {
    const r = st().race;
    if (!r || r.won || r.expired || Date.now() - r.at <= CFG.raceTimeoutSec * 1000) return;
    r.expired = true; setSt({ race: r });
    await send(E('clockIcon', '⏰') + ' Ніхто не встиг — це було слово <b>' + r.w + '</b>. Наступне — несподівано 👀');
  }

  // ═══════════════════════ 🍀 ЩАСЛИВЕ ПОВІДОМЛЕННЯ ═══════════════════════
  function maybeLucky(uid, msgId) {
    if (crypto.randomInt(CFG.luckyChance) !== 0) return;
    const today = kyivDay(Date.now());
    const s = st();
    const cnt = s.luckyDay === today ? (s.luckyCount || 0) : 0;
    if (cnt >= CFG.luckyDayCap) return;
    const u = db.getUser(uid) || {};
    if (u.luckyDay === today) return;                 // одна людина — раз на день
    db.upsertUser(uid, { luckyDay: today });
    setSt({ luckyDay: today, luckyCount: cnt + 1 });
    addChatPts(uid, CFG.luckyPts, msgId);
    react(msgId, '🎉');
    send('🍀 <b>Щасливе повідомлення!</b> ' + whoName(uid) + ' отримує <b>+' + CFG.luckyPts + ' XP</b>\n<i>Кожне повідомлення може стати щасливим — пиши 😉</i>',
      { reply_to_message_id: msgId });
  }

  // ═══════════════════════ 🔥 СЕРІЯ В ЧАТІ ═══════════════════════
  function streakOf(u) {
    const today = kyivDay(Date.now()), yest = kyivDay(Date.now() - 86400000);
    return u && (u.chatStreakDay === today || u.chatStreakDay === yest) ? (u.chatStreak || 0) : 0;
  }
  function bumpStreak(uid, msgsToday) {
    if (msgsToday !== CFG.streakMinMsgs) return;      // рахуємо рівно один раз на день
    const today = kyivDay(Date.now()), yest = kyivDay(Date.now() - 86400000);
    const u = db.getUser(uid) || {};
    if (u.chatStreakDay === today) return;
    const streak = u.chatStreakDay === yest ? (u.chatStreak || 0) + 1 : 1;
    db.upsertUser(uid, { chatStreakDay: today, chatStreak: streak });
    const bonus = CFG.streakMilestones[streak];
    if (bonus) {
      addChatPts(uid, bonus, null);
      send(E('almost', '🔥') + ' <b>' + whoName(uid) + '</b> — <b>' + streak + ' днів поспіль</b> у чаті!  +' + bonus + ' XP');
    }
  }

  // ═══════════════════════ ☀️ РАНКОВИЙ АНОНС ═══════════════════════
  async function postMorning() {
    const day = kyivDay(Date.now());
    const qs = questsToday(day);
    await send(card('almost', 'ДОБРОГО РАНКУ, ЧАТ!', [
      '<b>Квести дня:</b>',
      ...qs.map(q => '▫️ ' + q.t),
      '',
      E('statsIcon', '📊') + ' Ціль дня: <b>' + CFG.goalTarget + ' повідомлень</b> разом',
      E('almost', '🔥') + ' Гаряча година — між ' + CFG.hhFromHour + ':00 і ' + CFG.hhToHour + ':00, ловіть момент',
      E('crown', '👑') + ' О ' + CFG.activistHour + ':00 — активісти дня',
    ], '/quests — прогрес · /help — усі правила'));
  }

  // ═══════════════════════ 🏅 РІВНІ ═══════════════════════
  // Рівень гравця — один на все (чат, колеса, ігри, банк). Пороги перших
  // десяти ті самі, що були в чаті, тож титули не змінились.
  const LEVELS = econ.LEVELS.map(l => ({ at: l.at, e: l.e, t: l.t.uk }));
  function levelOf(pts) { let i = 0; while (i + 1 < LEVELS.length && pts >= LEVELS[i + 1].at) i++; return i; }
  function rankLine(pts) {
    const i = levelOf(pts), L = LEVELS[i], nx = LEVELS[i + 1];
    const bar = nx ? Math.round((pts - L.at) / (nx.at - L.at) * 10) : 10;
    return { i, L, nx, bar: '🟨'.repeat(bar) + '⬜'.repeat(10 - bar), left: nx ? nx.at - pts : 0 };
  }

  // Реакція бота на повідомлення — дрібниця, яка робить чат живим.
  // Реакції: у налаштуваннях чату адміни можуть дозволити лише частину емодзі.
  // Тоді Telegram мовчки відхиляє інші — звідси «раз ставить, раз ні».
  // Беремо список дозволених із самого чату й ставимо тільки їх.
  let allowedReacts = null;          // null — дозволено все
  let lastRecvAt = Date.now();       // коли бот востаннє отримав повідомлення з чату
  function alertAdmin(key, text) {
    const s = st(); const a = s.alerts || {};
    if (Date.now() - (a[key] || 0) < 12 * 3600000) return;       // не частіше разу на 12 год
    a[key] = Date.now(); setSt({ alerts: a });
    notify.admin(esc(text));
  }
  async function checkBotRights() {
    if (!chatId) return;
    try {
      const me = await bot.telegram.getMe();
      const mem = await bot.telegram.getChatMember(chatId, me.id);
      if (!['administrator', 'creator'].includes(mem.status)) {
        alertAdmin('notAdmin', '⚠️ Бот НЕ адміністратор у чаті ' + chatRef + ' (' + mem.status + ').\n\n' +
          'Через це Telegram не пересилає йому звичайні повідомлення — вони НЕ рахуються.\n' +
          'Зроби бота адміністратором (достатньо мінімальних прав). Потім /chat_debug');
      }
    } catch (e) {}
  }
  async function loadAllowedReactions() {
    if (!chatId) return;
    try {
      const ch = await bot.telegram.getChat(chatId);
      const ar = ch && ch.available_reactions;
      allowedReacts = Array.isArray(ar) ? new Set(ar.filter(r => r.type === 'emoji').map(r => r.emoji)) : null;
    } catch (e) {}
  }
  function react(msgId, emoji) {
    if (!chatId || !msgId) return;
    let e = emoji;
    if (allowedReacts) {
      if (!allowedReacts.has(e)) e = ['🔥', '🎉', '👍', '❤', '⚡', '👌'].find(x => allowedReacts.has(x));
      if (!e) return;
    }
    bot.telegram.callApi('setMessageReaction', {
      chat_id: chatId, message_id: msgId, reaction: [{ type: 'emoji', emoji: e }],
    }).catch(() => {});
  }

  // XP за активність у чаті. Нагорода й сповіщення про новий рівень —
  // у progress.addXp; у чаті лише оголошуємо (див. onLevelUp нижче).
  function addChatPts(uid, n, msgId) {
    if (!n || !known(uid) || isAdminUid(uid)) return 0;
    return progress.addXp(uid, 'chat', n, { chat: true, msgId });
  }
  progress.hooks.onLevelUp.push((uid, info, rw, o) => {
    if (!o || !o.chat) return;
    if (o.msgId) react(o.msgId, '🎉');
    send(E('crown', '👑') + ' <b>' + whoName(uid) + '</b> тепер <b>' + info.e + ' ' + esc(info.t) + '</b> — рівень ' + info.n + '!' + (rw.tickets ? '  +' + rw.tickets + ' ' + TIX : ''));
  });

  async function onRankCmd(ctx) {
    const rows = [];
    for (const [id, u] of Object.entries(db.allUsers ? db.allUsers() : {})) {
      const p = u ? Math.floor(xpTotal(u)) : 0;
      if (p > 0 && !isAdminUid(id)) rows.push({ id, p });
    }
    rows.sort((x, y) => y.p - x.p);
    const lines = [];
    if (!rows.length) lines.push('Поки порожньо — пиши, і ти перший!');
    rows.slice(0, 10).forEach((r, i) => {
      const L = LEVELS[levelOf(r.p)];
      lines.push(medal(i) + ' ' + whoName(r.id) + ' — ' + L.e + ' ' + L.t + ' · <b>' + r.p + '</b>');
    });
    const me = rows.findIndex(r => r.id === String(ctx.from.id));
    if (me >= 10) lines.push('\n' + E('crown', '👑') + ' Ти: <b>#' + (me + 1) + '</b> · ' + rows[me].p);
    await ctx.reply(card('crown', 'ЛЕГЕНДИ', lines, 'XP не згорає — рівень гравця твій назавжди'),
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }).catch(() => {});
  }

  // ═══════════════════════ 📋 КВЕСТИ ДНЯ ═══════════════════════
  // Щодня три завдання, однакові для всіх (вибираються за датою).
  const QPOOL = [
    { k: 'msgs',     need: 15, t: 'Напиши 15 повідомлень' },
    { k: 'drop',     need: 1,  t: 'Забери дроп' },
    { k: 'quiz',     need: 1,  t: 'Виграй вікторину' },
    { k: 'duel',     need: 1,  t: 'Зіграй дуель (від 2 ' + TIX + ')' },
    { k: 'duel_win', need: 1,  t: 'Виграй дуель' },
    { k: 'slot',     need: 3,  t: 'Зіграй 3 гри (/games)' },
    { k: 'bonus',    need: 1,  t: 'Забери /bonus' },
  ];
  const QREWARD = 15, QALL = 3, QALL_PTS = 30;   // квест: очки рівня; усі три: 3🎫 + 30 очок
  function questsToday(day) {
    let h = 0; for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const pool = QPOOL.slice(), out = [];
    out.push(pool.splice(0, 1)[0]);                        // «напиши повідомлення» — завжди
    while (out.length < 3) { h = (h * 1103515245 + 12345) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
    return out;
  }
  function qState(u, day) { return u.chatQ && u.chatQ.day === day ? u.chatQ : { day, p: {}, d: {}, all: false }; }

  function questProg(uid, key, n, msgId) {
    if (!known(uid) || isAdminUid(uid)) return;
    const day = kyivDay(Date.now());
    const qs = questsToday(day);
    const q = qs.find(x => x.k === key);
    if (!q) return;
    const u = db.getUser(uid) || {};
    const s = qState(u, day);
    if (s.d[key]) return;
    s.p[key] = (s.p[key] || 0) + n;
    let doneNow = false;
    if (s.p[key] >= q.need) { s.d[key] = true; doneNow = true; }
    const allNow = !s.all && qs.every(x => s.d[x.k]);
    if (allNow) s.all = true;
    db.upsertUser(uid, { chatQ: s });
    if (doneNow) {
      addChatPts(uid, QREWARD, msgId);
      if (msgId) react(msgId, '👌');
    }
    if (allNow) {
      addTickets(uid, QALL, 'усі квести дня в чаті');
      addChatPts(uid, QALL_PTS, null);
      if (msgId) react(msgId, '🏆');
      send(E('trophy', '🏆') + ' <b>' + whoName(uid) + '</b> виконав <b>усі квести дня</b>!  +' + QALL + ' ' + TIX + ' +' + QALL_PTS + ' XP');
    }
  }

  async function onQuestsCmd(ctx) {
    const day = kyivDay(Date.now());
    const u = db.getUser(String(ctx.from.id)) || {};
    const s = qState(u, day);
    const lines = questsToday(day).map(q => {
      const p = Math.min(q.need, s.p[q.k] || 0);
      return (s.d[q.k] ? E('check', '✅') : '▫️') + ' ' + q.t + (q.need > 1 && !s.d[q.k] ? '  <b>' + p + '/' + q.need + '</b>' : '') +
        '  <i>+' + QREWARD + ' XP</i>';
    });
    lines.push('');
    lines.push((s.all ? E('check', '✅') : E('trophy', '🏆')) + ' Усі три — ще <b>+' + QALL + ' ' + TIX + ' +' + QALL_PTS + ' XP</b>');
    await ctx.reply(card('statsIcon', 'КВЕСТИ ДНЯ', lines, 'Оновлюються щодня опівночі'),
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }).catch(() => {});
  }

  // ═══════════════════════ 🎮 ІГРИ В ЧАТІ ═══════════════════════
  // Однакові правила для всіх ігор. Денної межі немає. Залишено лише:
  //  • 3 с між іграми однієї людини — від подвійного натискання;
  //  • запобіжник на весь чат: Telegram пускає бота лише ~20 повідомлень на
  //    хвилину в групу, тож без нього бот «задушив» би сам себе;
  //  • верхню ставку: джекпот ×20 на великій ставці — це тисячі зірок.
  // Програш не пише окремого повідомлення — лише реакція 😢, щоб не засмічувати чат.
  const SLOT = { min: 1, max: 250, cooldownMs: 3000, chatPerMin: 16, gamePtsDayCap: 20 };
  const SYM = ['BAR', '🍇', '🍋', '7️⃣'];
  const GAMES = {
    slot:     { emoji: '🎰', name: 'Слот',      cmd: 'slot' },
    dice:     { emoji: '🎲', name: 'Кубик',     cmd: 'dice',     win: v => v >= 4,  k: 1.85, cond: '4, 5 або 6' },
    basket:   { emoji: '🏀', name: 'Баскетбол', cmd: 'basket',   win: v => v >= 4,  k: 2.3,  cond: 'влучання' },
    football: { emoji: '⚽', name: 'Футбол',    cmd: 'football', win: v => v >= 3,  k: 1.55, cond: 'гол' },
    darts:    { emoji: '🎯', name: 'Дартс',     cmd: 'darts',    win: v => v === 6, k: 5.2,  cond: 'у яблучко' },
    bowling:  { emoji: '🎳', name: 'Боулінг',   cmd: 'bowling',  win: v => v === 6, k: 5.2,  cond: 'страйк' },
  };
  // Скільки чекати, поки анімація догра́є. Офіційно Telegram цього не вказує,
  // тож беремо з запасом: результат має з'являтися ПІСЛЯ зупинки кубика.
  const ANIM_MS = { '🎰': 3600, '🎲': 4300, '🎯': 4300, '🎳': 4600, '🏀': 4900, '⚽': 4900 };
  const slotLast = new Map();
  let chatGameLog = [];                 // час відправлених ігрових повідомлень (для запобіжника)
  function slotPay(v) {
    const x = v - 1, r = [x & 3, (x >> 2) & 3, (x >> 4) & 3];
    if (r[0] === 3 && r[1] === 3 && r[2] === 3) return { m: 20, r };
    if (r[0] === r[1] && r[1] === r[2]) return { m: 6, r };
    if (r.filter(z => z === 3).length === 2) return { m: 2, r };
    return { m: 0, r };
  }
  function gamesHelpLines() {
    return [
      '🎰 <code>/slot 5</code> — 777 ×20 · три однакові ×6 · дві сімки ×2',
      '🎲 <code>/dice 5</code> — 4, 5 або 6 · ×' + GAMES.dice.k,
      '🏀 <code>/basket 5</code> — влучив · ×' + GAMES.basket.k,
      '⚽ <code>/football 5</code> — гол · ×' + GAMES.football.k,
      '🎯 <code>/darts 5</code> — у яблучко · ×' + GAMES.darts.k,
      '🎳 <code>/bowling 5</code> — страйк · ×' + GAMES.bowling.k,
    ];
  }

  async function onGameCmd(ctx, key) {
    const g = GAMES[key];
    const uid = String(ctx.from.id);
    const rid = { reply_to_message_id: ctx.message.message_id, parse_mode: 'HTML' };
    if (!registered(uid)) {
      const link = botLink('chat');
      return ctx.reply(g.emoji + ' Ігри на білети — для тих, хто в боті. Запусти й повертайся 👇',
        { ...rid, ...(link ? { reply_markup: { inline_keyboard: [[ubtn('🚀 Запустити бота', link, 'success', 'rocket')]] } } : {}) }).catch(() => {});
    }
    const bet = Math.floor(Number((ctx.message.text || '').split(/\s+/)[1]) || 0);
    if (bet < SLOT.min || bet > SLOT.max) {
      return ctx.reply(card('almost', 'ІГРИ НА БІЛЕТИ', gamesHelpLines().concat(['', 'Ставка від ' + SLOT.min + ' до ' + SLOT.max + ' ' + TIX])), rid).catch(() => {});
    }
    const now = Date.now();
    if (now - (slotLast.get(uid) || 0) < SLOT.cooldownMs) return;          // подвійне натискання — мовчки ігноруємо
    chatGameLog = chatGameLog.filter(t => now - t < 60000);
    if (chatGameLog.length >= SLOT.chatPerMin) {
      return ctx.reply('⏳ Забагато ігор за хвилину — Telegram обмежує бота. Спробуй за кілька секунд 🙂', rid).catch(() => {});
    }
    const u = db.getUser(uid) || {};
    if (ticketsOf(u) < bet) return ctx.reply(E('warn', '⚠️') + ' Замало білетів: у тебе ' + ticketsOf(u) + ' ' + TIX, rid).catch(() => {});

    if (!addTickets(uid, -bet, g.name + ' у чаті')) return;
    slotLast.set(uid, now);
    chatGameLog.push(now);
    const dm = await bot.telegram.sendDice(chatId, { emoji: g.emoji, reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true }).catch(() => null);
    if (!dm || !dm.dice) { addTickets(uid, bet, g.name + ' — повернення'); return; }
    const v = dm.dice.value;
    questProg(uid, 'slot', 1, ctx.message.message_id);
    // Очки за ігри — з денною межею, інакше рівень можна було б купити дрібними ставками.
    const day = kyivDay(now);
    const gp = u.gamePtsDay === day ? (u.gamePts || 0) : 0;
    if (gp < SLOT.gamePtsDayCap) { db.upsertUser(uid, { gamePtsDay: day, gamePts: gp + 1 }); addChatPts(uid, 1, null); }

    let mult = 0, combo = '';
    if (key === 'slot') { const r = slotPay(v); mult = r.m; combo = r.r.map(z => SYM[z]).join(' '); }
    else mult = g.win(v) ? g.k : 0;

    await new Promise(r => setTimeout(r, ANIM_MS[g.emoji] || 4500));   // чекаємо, поки кубик зупиниться
    // Відповідаємо на КОМАНДУ, а не на кубик: цитата кубика змушує Telegram
    // перемальовувати його, і анімація скидається. Реакцій на кубик теж не ставимо.
    const rep2 = { reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true };
    if (!mult) {
      await ctx.reply('😢 ' + (combo || g.emoji) + '  мимо', rep2).catch(() => {});
      return;
    }

    const win = Math.floor(bet * mult);
    addTickets(uid, win, g.name + ' — виграш');
    chatGameLog.push(Date.now());
    if (key === 'slot' && mult === 20) {
      await send(card('almost', 'ДЖЕКПОТ!', ['7️⃣ 7️⃣ 7️⃣', E('crown', '👑') + ' <b>' + nameOf(ctx.from) + '</b> зриває <b>+' + win + ' ' + TIX + '</b>!'],
        'Таке випадає раз на 64 спіни'), rep2);
      react(ctx.message.message_id, '🔥');
      return;
    }
    await ctx.reply(E('check', '✅') + ' ' + (combo || g.emoji + ' ' + g.cond) + '  →  <b>+' + win + ' ' + TIX + '</b>',
      { parse_mode: 'HTML', ...rep2 }).catch(() => {});
  }
  async function onSlotCmd(ctx) { return onGameCmd(ctx, 'slot'); }

  // ─────────────────────── 📋 МЕНЮ КОМАНД ───────────────────────
  // Коли людина натискає «/» у чаті, Telegram показує цей список.
  async function setupCommandMenu() {
    if (!chatId) return;
    await bot.telegram.setMyCommands([
      { command: 'help',    description: '📖 Як тут усе працює' },
      { command: 'bonus',   description: '⭐ Щоденна зірка (раз на 24 год)' },
      { command: 'quests',  description: '📋 Квести дня — білети за активність' },
      { command: 'games',   description: '🎮 Усі ігри: слот, кубик, баскет, футбол, дартс, боулінг' },
      { command: 'slot',    description: '🎰 Слот на білети: /slot 5' },
      { command: 'rank',    description: '👑 Легенди чату — рівні й титули' },
      { command: 'me',      description: '👤 Мій рівень, квести, білети' },
      { command: 'goal',    description: '🎯 Спільна ціль чату' },
      { command: 'contest', description: '🏅 Змагання чату' },
      { command: 'duel',    description: '⚔️ Дуель на білети: /duel 5' },
    ], { scope: { type: 'chat', chat_id: chatId } });
  }

  // ─────────────────────── ⭐ ЩОДЕННИЙ БОНУС ───────────────────────
  // Зірка раз на 24 год, але лише тим, хто сьогодні реально спілкувався
  // в чаті. Так бонус тягне людей писати, а не просто заходити за халявою.
  async function onBonusCmd(ctx) {
    const uid = String(ctx.from.id);
    const rid = { reply_to_message_id: ctx.message.message_id, parse_mode: 'HTML' };
    if (!registered(uid)) {
      const link = botLink('chat');
      return ctx.reply(card('starIcon', 'ЩОДЕННИЙ БОНУС', ['Бонус — для тих, хто в боті. Запусти й повертайся 👇']),
        { ...rid, ...(link ? { reply_markup: { inline_keyboard: [[ubtn('Запустити бота', link, 'success', 'rocket')]] } } : {}) }).catch(() => {});
    }
    if (isAdminUid(uid)) return ctx.reply('Адмін бонус не бере 🙂', rid).catch(() => {});

    const u = db.getUser(uid) || {};
    const today = kyivDay(Date.now());
    const msgs = actCount(u, today);
    if (msgs < CFG.bonusNeedMsgs) {
      return ctx.reply(card('lockIcon', 'БОНУС ЩЕ ЗАКРИТИЙ', [
        'Щоб відкрити, напиши в чаті сьогодні ще <b>' + (CFG.bonusNeedMsgs - msgs) + '</b> повідомл.',
        'Зараз: ' + msgs + ' / ' + CFG.bonusNeedMsgs,
      ], 'Поспілкуйся — і забирай бонус'), rid).catch(() => {});
    }
    const last = u.chatBonusAt || 0;
    const left = last + 86400000 - Date.now();
    if (left > 0) {
      const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
      return ctx.reply(E('pendingIcon', '⏳') + ' Наступний бонус через <b>' + h + ' год ' + m + ' хв</b>', rid).catch(() => {});
    }
    // Серія: якщо брав учора (у межах 48 год) — продовжуємо.
    const streak = last && Date.now() - last < 48 * 3600000 ? (u.chatBonusStreak || 0) + 1 : 1;
    const extra = streak % CFG.bonusStreakEvery === 0 ? CFG.bonusStreakExtra : 0;
    const give = CFG.bonusStars + extra;       // зірки: лише на кожен 7-й день
    db.upsertUser(uid, { chatBonusAt: Date.now(), chatBonusStreak: streak });
    if (give) addStars(uid, give, 'серія бонусів у чаті');
    if (CFG.bonusTickets) addTickets(uid, CFG.bonusTickets, 'щоденний бонус у чаті');
    const nextBig = CFG.bonusStreakEvery - (streak % CFG.bonusStreakEvery);
    addChatPts(uid, CFG.bonusPts, ctx.message.message_id);
    questProg(uid, 'bonus', 1, ctx.message.message_id);
    await ctx.reply(card('starIcon', 'БОНУС ЗАБРАНО', [
      E('crown', '👑') + ' <b>' + nameOf(ctx.from) + '</b>',
      E('check', '✅') + ' Отримав: <b>+' + CFG.bonusTickets + ' ' + TIX + ' +' + CFG.bonusPts + ' XP</b>' + (give ? '  і <b>+' + give + ' ' + E('starIcon', '⭐') + '</b> за серію!' : ''),
      E('almost', '🔥') + ' Серія: <b>' + streak + ' дн.</b>' + (extra ? '' : ' · до ⭐ за серію ще ' + nextBig + ' дн.'),
    ], 'Наступний — через 24 год. Не пропусти, щоб не збити серію!'), rid).catch(() => {});
  }

  // ─────────────────────── 🌟 АКТИВІСТ ДНЯ ───────────────────────
  async function postActivist() {
    const today = kyivDay(Date.now());
    const rows = actRows(today).filter(r => r.n >= CFG.activistMinMsgs);
    if (!rows.length) {
      await send(card('crown', 'АКТИВІСТИ ДНЯ', [
        'Сьогодні ніхто не написав ' + CFG.activistMinMsgs + '+ повідомлень — нагорода згоріла 😢',
      ], 'Завтра о ' + CFG.activistHour + ':00 — новий шанс!'));
      return;
    }
    const lines = [];
    rows.slice(0, 3).forEach((r, i) => {
      const pr = CFG.activistPrizes[i];
      if (pr.stars) addStars(r.uid, pr.stars, 'активіст дня');
      if (pr.tickets) addTickets(r.uid, pr.tickets, 'активіст дня');
      addChatPts(r.uid, pr.xp, null);
      lines.push(medal(i) + ' <b>' + whoName(r.uid) + '</b> — ' + r.n + ' повідомл.');
      lines.push('      → <b>' + prizeText(pr, E('starIcon', '⭐')) + '</b>');
      bot.telegram.sendMessage(r.uid, card('crown', 'ТИ ' + (i + 1) + '-Й АКТИВІСТ ДНЯ!', [
        'Сьогодні в чаті: <b>' + r.n + ' повідомлень</b>',
        E('check', '✅') + ' Нагорода вже на балансі: <b>' + prizeText(pr, E('starIcon', '⭐')) + '</b>',
      ], 'Завтра — знову. Тримай темп 🔥'), { parse_mode: 'HTML' }).catch(() => {});
    });
    await send(card('crown', 'АКТИВІСТИ ДНЯ', lines,
      'Рахуються всі повідомлення в чаті. Завтра о ' + CFG.activistHour + ':00 — знову!'));
  }

  // О 18:00 — хто лідирує: створює гонку на вечір.
  async function postActivistTeaser() {
    const today = kyivDay(Date.now());
    const rows = actRows(today);
    const p = CFG.activistPrizes;
    const lines = ['Підсумки о <b>' + CFG.activistHour + ':00</b> — лишилось ' + (CFG.activistHour - CFG.activistTeaserHour) + ' год', ''];
    if (!rows.length) lines.push('Поки ніхто — перше місце вільне!');
    rows.slice(0, 3).forEach((r, i) => { lines.push(medal(i) + ' ' + whoName(r.uid) + ' — <b>' + r.n + '</b> повідомл.'); });
    lines.push('');
    lines.push('<b>Нагорода:</b>');
    lines.push(medal(0) + ' ' + prizeText(p[0], E('starIcon', '⭐')));
    lines.push(medal(1) + ' ' + prizeText(p[1], E('starIcon', '⭐')));
    lines.push(medal(2) + ' ' + prizeText(p[2], E('starIcon', '⭐')));
    await send(card('crown', 'ХТО СТАНЕ АКТИВІСТОМ ДНЯ?', lines,
      'Мінімум ' + CFG.activistMinMsgs + ' повідомлень. Рахуються всі — пиши, спілкуйся, обганяй!'));
  }


  // ─────────────────────── 🏅 ЗМАГАННЯ ───────────────────────
  function contestActive() {
    const k = st().contest;
    return k && !k.finished && Date.now() < k.endsAt ? k : null;
  }

  // Нарахувати бали. kind: msg | duel | duelWin | drop | quiz
  function addPts(uid, kind, meta) {
    const k = contestActive();
    if (!k) return 0;
    uid = String(uid);
    if (!registered(uid) || isAdminUid(uid)) return 0;
    const s = k.scores[uid] || { pts: 0, msg: 0, duel: 0, win: 0, drop: 0, quiz: 0, lastAt: 0 };

    let add = 0;
    if (kind === 'msg') {
      if (s.msg >= CONTEST.msgCap) return 0;
      s.msg += CONTEST.msg; add = CONTEST.msg;
    } else if (kind === 'duel') {
      if (s.duel >= CONTEST.duelCap || (meta && meta.stake < CONTEST.duelMinStake)) return 0;
      s.duel++; add = CONTEST.duel;
    } else if (kind === 'duelWin') {
      if (s.duel > CONTEST.duelCap || (meta && meta.stake < CONTEST.duelMinStake)) return 0;
      s.win++; add = CONTEST.duelWin;
    } else if (kind === 'drop') { s.drop++; add = CONTEST.drop; }
    else if (kind === 'quiz') { s.quiz++; add = CONTEST.quiz; }

    if (!add) return 0;
    s.pts += add; s.lastAt = Date.now();
    k.scores[uid] = s;
    setSt({ contest: k });
    return add;
  }

  function contestRows(k) {
    return Object.entries(k.scores || {})
      .map(([uid, s]) => ({ uid, ...s }))
      .sort((a, b) => (b.pts - a.pts) || (a.lastAt - b.lastAt));
  }

  function whoName(uid) {
    const u = db.getUser(uid) || {};
    return u.username ? '@' + u.username : esc(u.name || 'гравець');
  }

  function leftText(ms) {
    if (ms <= 0) return 'завершено';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return (h ? h + ' год ' : '') + m + ' хв';
  }

  async function startContest(endsAt, count, tier) {
    const k = { id: crypto.randomBytes(3).toString('hex'), startedAt: Date.now(), endsAt,
                count: count || 3, tier: tier || 'bear', scores: {}, finished: false };
    setSt({ contest: k });
    const until = new Date(endsAt).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    await send(card('trophy', 'ЗМАГАННЯ ЧАТУ · до ' + until, [
      E('teddyBear', '🧸') + ' <b>Приз:</b> ' + k.count + ' мішки — трійці з найбільшими балами',
      '',
      '<b>За що бали:</b>',
      '💬 повідомлення — <b>' + CONTEST.msg + '</b> (від 8 символів, раз на 30 с)',
      '⚔️ дуель — <b>' + CONTEST.duel + '</b>, перемога — ще <b>+' + CONTEST.duelWin + '</b> (ставка від ' + CONTEST.duelMinStake + ' ' + TIX + ')',
      E('giftBox', '🎁') + ' забраний дроп — <b>' + CONTEST.drop + '</b>',
      E('lightning', '⚡') + ' правильна вікторина — <b>' + CONTEST.quiz + '</b>',
      '',
      E('lockIcon', '🔒') + ' Мінімум <b>' + CONTEST.minPts + ' балів</b>, щоб претендувати',
    ], '/contest — таблиця й твої бали · /help — усі правила'));
    return k;
  }

  async function finishContest() {
    const k = st().contest;
    if (!k || k.finished) return null;
    k.finished = true;
    setSt({ contest: k });

    const rows = contestRows(k).filter(r => r.pts >= CONTEST.minPts);
    const win = rows.slice(0, k.count);
    const adminLines = [];
    const lines = [];
    for (let i = 0; i < win.length; i++) {
      const r = win[i];
      const a = require('../features/applications').create(r.uid, k.tier, 'chat_contest', {}, { silent: true });
      adminLines.push((i + 1) + '. ' + whoName(r.uid) + ' — ' + r.pts + ' балів · заявка #' + a.id);
      lines.push(medal(i) + ' <b>' + whoName(r.uid) + '</b> — ' + r.pts + ' балів → ' + E('teddyBear', '🧸'));
      bot.telegram.sendMessage(r.uid, card('teddyBear', 'ТИ ВИГРАВ МІШКУ!', [
        'Змагання чату: ти <b>#' + (i + 1) + '</b> з <b>' + r.pts + '</b> балами',
        E('check', '✅') + ' Заявку створено — видамо найближчим часом',
      ]), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (!win.length) {
      await send(card('trophy', 'ЗМАГАННЯ ЗАВЕРШЕНО', ['Ніхто не набрав ' + CONTEST.minPts + ' балів — мішки лишаються на наступний раз.']));
    } else {
      await send(card('trophy', 'ЗМАГАННЯ ЗАВЕРШЕНО', ['<b>Мішки забирають:</b>'].concat(lines),
        'Дякую всім, хто грав! Переможцям уже прийшло сповіщення 🔥'));
    }
    return { winners: adminLines, players: contestRows(k).length };
  }

  async function onContestCmd(ctx) {
    const k = st().contest;
    const rid = { reply_to_message_id: ctx.message.message_id, parse_mode: 'HTML' };
    if (!k) return ctx.reply(E('clockIcon', '⏰') + ' Зараз змагання немає. Слідкуй за чатом 👀', rid).catch(() => {});
    const rows = contestRows(k);
    const lines = [];
    lines.push(k.finished ? 'Змагання завершено' : E('pendingIcon', '⏳') + ' Лишилось: <b>' + leftText(k.endsAt - Date.now()) + '</b>');
    lines.push('');
    if (!rows.length) lines.push('Поки ніхто не набрав балів — будь першим!');
    rows.slice(0, 5).forEach((r, i) => {
      const inPrize = i < k.count && r.pts >= CONTEST.minPts;
      lines.push(medal(i) + ' ' + whoName(r.uid) + ' — <b>' + r.pts + '</b>' + (inPrize ? '  ' + E('teddyBear', '🧸') : ''));
    });
    const me = rows.findIndex(r => r.uid === String(ctx.from.id));
    if (me >= 0) {
      const s = rows[me];
      lines.push('');
      lines.push(E('crown', '👑') + ' <b>Ти: #' + (me + 1) + ' · ' + s.pts + ' балів</b>');
      lines.push('💬 ' + s.msg + '  ⚔️ ' + s.duel + ' (' + s.win + ' перемог)  ' + E('giftBox', '🎁') + ' ' + s.drop + '  ' + E('lightning', '⚡') + ' ' + s.quiz);
      if (s.pts < CONTEST.minPts) lines.push(E('lockIcon', '🔒') + ' До мінімуму — ще ' + (CONTEST.minPts - s.pts));
      else if (me >= k.count && rows[k.count - 1]) lines.push(E('almost', '🔥') + ' До призового місця — ще ' + (rows[k.count - 1].pts - s.pts + 1));
    }
    await ctx.reply(card('trophy', 'ЗМАГАННЯ ЧАТУ', lines, E('teddyBear', '🧸') + ' — зараз у призовій зоні'), rid).catch(() => {});
  }

  // ─────────────────────── ❓ ДОВІДКА ───────────────────────
  async function onHelpCmd(ctx) {
    const k = contestActive();
    const p = CFG.activistPrizes;
    const S = E('starIcon', '⭐');
    const sec = (icon, title, how, prize) =>
      E(icon, icon) + ' <b>' + title + '</b>\n<blockquote>' + how + '\nПриз: <b>' + prize + '</b></blockquote>';
    const t =
      E('infoIcon', 'ℹ️') + ' <b>ЯК ТУТ УСЕ ПРАЦЮЄ</b>\n' + LINE + '\n' +
      (k ? E('almost', '🔥') + ' <b>Зараз іде змагання!</b> Лишилось ' + leftText(k.endsAt - Date.now()) + ' · /contest\n\n' : '') +
      sec('giftBox', 'ДРОПИ', 'Кілька разів на день з\'являється кнопка. <b>Хто перший натиснув — той забрав.</b> Один дроп на людину за день.', '2–6 ' + TIX + ' або 3 ' + S) + '\n' +
      sec('lightning', 'ВІКТОРИНИ', 'Питання з кнопками. <b>Перша правильна відповідь виграє.</b> Помилився — спроба згоріла.', '+' + CFG.quizPrize + ' ' + TIX) + '\n' +
      sec('redCircle', 'ДУЕЛІ', '<code>/duel 5</code> — виклик будь-кому. Відповіддю на повідомлення — конкретній людині. Бот кидає 🎲 за кожного, <b>у кого більше — забирає банк</b>.', 'банк мінус ' + CFG.duelBurnPercent + '%') + '\n' +
      sec('starIcon', 'ЩОДЕННИЙ БОНУС', '<code>/bonus</code> раз на 24 год. Відкривається після ' + CFG.bonusNeedMsgs + ' повідомлень у чаті за день. Кожен ' + CFG.bonusStreakEvery + '-й день поспіль — ще +' + CFG.bonusStreakExtra + S + '.', prizeText({ tickets: CFG.bonusTickets, xp: CFG.bonusPts })) + '\n' +
      sec('crown', 'АКТИВІСТИ ДНЯ', 'О ' + CFG.activistHour + ':00 <b>троє, хто написав найбільше</b> (від ' + CFG.activistMinMsgs + ' повідомл.). О ' + CFG.activistTeaserHour + ':00 бот показує, хто лідирує.',
        '🥇 ' + prizeText(p[0], S) + ' · 🥈 ' + prizeText(p[1], S) + ' · 🥉 ' + prizeText(p[2], S)) + '\n' +
      sec('statsIcon', 'СПІЛЬНА ЦІЛЬ', 'Чат разом пише ' + CFG.goalTarget + ' повідомлень за день. <b>Кожен, хто написав ' + CFG.goalMinPer + '+, отримує бонус.</b> <code>/goal</code> — прогрес.', goalText()) + '\n' +
      sec('crown', 'РІВНІ Й ТИТУЛИ', 'За будь-яку активність — у чаті й у застосунку — копиться XP: від 🌱 Новачка до 🍀 Бога удачі. <b>XP не згорає.</b> <code>/rank</code> — топ.', 'новий титул і білети за кожен рівень') + '\n' +
      sec('statsIcon', 'КВЕСТИ ДНЯ', 'Щодня три завдання для всіх: написати повідомлення, забрати дроп, виграти дуель тощо. <code>/quests</code> — прогрес.', '+' + QREWARD + ' XP за кожен, за всі три ще +' + QALL + ' ' + TIX + ' +' + QALL_PTS + ' XP') + '\n' +
      sec('lightning', 'ХТО ШВИДШИЙ', 'Кілька разів на день бот публікує слово з переплутаними літерами. <b>Перший, хто напише правильне слово в чат, — виграє.</b>', prizeText({ tickets: CFG.raceTickets, xp: CFG.racePts })) + '\n' +
      sec('crown', 'ЩАСЛИВЕ ПОВІДОМЛЕННЯ', 'Бот випадково обирає повідомлення в чаті й дає бонус. <b>Кожне твоє повідомлення може стати щасливим.</b>', '+' + CFG.luckyPts + ' XP') + '\n' +
      sec('almost', 'СЕРІЯ В ЧАТІ', 'Пиши щодня хоча б ' + CFG.streakMinMsgs + ' повідомлень — і серія росте. На 3, 7, 14 і 30 днях — великі бонуси.', 'до +300 XP') + '\n' +
      sec('almost', 'ІГРИ НА БІЛЕТИ', 'Слот, кубик, баскетбол, футбол, дартс, боулінг — просто в чаті. <code>/games</code> — усі правила й коефіцієнти.', 'до ×20 ставки') + '\n' +
      sec('almost', 'ГАРЯЧА ГОДИНА', 'Раз на день у випадковий момент між ' + CFG.hhFromHour + ':00 і ' + CFG.hhToHour + ':00 на ' + CFG.hhMinutes + ' хв.', 'XP ×2 — рівень росте удвічі швидше') + '\n' +
      E('crown', '👑') + ' <b>ЗА ЩО XP У ЧАТІ</b>\n<blockquote expandable>• повідомлення — 1 (у гарячу годину 2), до ' + econ.XP.chat.dayCap + ' XP з чату на день\n• дроп, вікторина — 5\n• дуель — 3, перемога — ще 3\n• /bonus — 2 · квест дня — 10\n• активісти дня й спільна ціль — див. вище</blockquote>\n' +
      '<b>Команди:</b> /quests · /bonus · /games · /rank · /me · /goal · /duel\n\n' +
      '<i>Брати участь можуть ті, хто запустив @' + (getBotUsername() || 'StarForgeX_bot') + '</i>';
    await ctx.reply(t, { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id, disable_web_page_preview: true }).catch(() => {});
  }

  // ─────────────────────── 🎁 ДРОПИ ───────────────────────
  async function postDrop(force) {
    const prize = pickWeighted(CFG.dropPrizes);
    const id = crypto.randomBytes(4).toString('hex');
    const label = prize.stars ? prize.stars + ' ' + E('starIcon', '⭐') : prize.tickets + ' ' + TIX;
    const btnLabel = prize.stars ? 'Забрати ' + prize.stars + '⭐' : 'Забрати ' + prize.tickets + TIX;
    const m = await send(card('giftBox', 'ДРОП', [
      'Приз: <b>' + label + '</b>',
      '',
      E('lightning', '⚡') + ' <b>Як виграти:</b> першим натисни кнопку нижче',
    ], 'Один дроп на людину за день · треба бути в боті'),
      { reply_markup: { inline_keyboard: [[btn(btnLabel, 'cd:' + id, 'success', 'giftBox')]] } });
    if (!m) return false;
    setSt({ drop: { id, prize, msgId: m.message_id, at: Date.now(), taken: null } });
    return true;
  }

  async function onDropClick(ctx, id) {
    const s = st();
    const d = s.drop;
    const uid = String(ctx.from.id);
    if (!d || d.id !== id) return ctx.answerCbQuery('Цей дроп уже неактивний').catch(() => {});
    if (!registered(uid)) {
      return ctx.answerCbQuery('Спершу запусти бота @' + (getBotUsername() || 'StarForgeX_bot') + ' — і повертайся за дропом!', { show_alert: true }).catch(() => {});
    }
    if (d.taken) return ctx.answerCbQuery('Не встиг 😅 Дроп забрав ' + d.taken.plain + '. Наступний — несподівано!', { show_alert: true }).catch(() => {});
    if (isAdminUid(uid)) return ctx.answerCbQuery('Адмін дропи не забирає 🙂', { show_alert: true }).catch(() => {});
    const day = kyivDay(Date.now());
    const u = db.getUser(uid) || {};
    if (u.chatDropDay === day) return ctx.answerCbQuery('Ти сьогодні вже забирав дроп — дай шанс іншим 🙂 Завтра знову!', { show_alert: true }).catch(() => {});

    // Фіксуємо переможця ДО нарахування — щоб два швидкі кліки не отримали обидва.
    d.taken = { uid, name: nameOf(ctx.from), plain: ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || 'хтось'), at: Date.now() };
    setSt({ drop: d });
    db.upsertUser(uid, { chatDropDay: day });
    if (d.prize.stars) addStars(uid, d.prize.stars, 'дроп у чаті');
    else addTickets(uid, d.prize.tickets, 'дроп у чаті');

    addPts(uid, 'drop');
    addChatPts(uid, 5, null);
    questProg(uid, 'drop', 1, null);
    const label = d.prize.stars ? '+' + d.prize.stars + ' ' + E('starIcon', '⭐') : '+' + d.prize.tickets + ' ' + TIX;
    const plainLabel = d.prize.stars ? '+' + d.prize.stars + '⭐' : '+' + d.prize.tickets + '🎫';
    const secs = Math.max(1, Math.round((Date.now() - d.at) / 1000));
    await ctx.answerCbQuery('🎉 Твоє! ' + plainLabel + ' вже на балансі', { show_alert: true }).catch(() => {});
    await bot.telegram.editMessageText(chatId, d.msgId, undefined, card('giftBox', 'ДРОП ЗАБРАНО', [
      E('crown', '👑') + ' Переможець: <b>' + d.taken.name + '</b>',
      E('check', '✅') + ' Отримав: <b>' + label + '</b>',
      E('clockIcon', '⏰') + ' Встиг за <b>' + secs + ' с</b>',
    ], 'Наступний дроп — у несподіваний момент. Тримай чат відкритим 👀'),
      { parse_mode: 'HTML' }).catch(() => {});
  }

  // ─────────────────────── 🧠 ВІКТОРИНИ ───────────────────────
  async function postQuiz() {
    const s = st();
    const used = s.quizUsed || [];
    let pool = QUIZ.map((q, i) => i).filter(i => !used.includes(i));
    if (!pool.length) pool = QUIZ.map((q, i) => i);
    const qi = pool[crypto.randomInt(pool.length)];
    const q = QUIZ[qi];
    const id = crypto.randomBytes(4).toString('hex');
    const m = await send(card('lightning', 'ВІКТОРИНА', [
      '❓ <b>' + esc(q.q) + '</b>',
      '',
      'Приз: <b>+' + CFG.quizPrize + ' ' + TIX + '</b>',
      E('crown', '👑') + ' <b>Як виграти:</b> першим натисни правильну відповідь',
    ], 'Одна спроба на людину — помилився, спроба згоріла'),
      { reply_markup: { inline_keyboard: [q.a.map((a, i) => btn(a, 'cq:' + id + ':' + i, 'primary'))] } });
    if (!m) return false;
    setSt({ quiz: { id, qi, msgId: m.message_id, at: Date.now(), wrong: [], won: null },
            quizUsed: used.concat([qi]).slice(-12) });
    return true;
  }

  async function onQuizClick(ctx, id, choice) {
    const s = st(); const z = s.quiz;
    const uid = String(ctx.from.id);
    if (!z || z.id !== id) return ctx.answerCbQuery('Ця вікторина вже закрита').catch(() => {});
    if (z.won) return ctx.answerCbQuery('Запізнився — першим відповів ' + z.won.plain, { show_alert: true }).catch(() => {});
    if (!registered(uid)) {
      return ctx.answerCbQuery('Відповідати можуть ті, хто запустив бота @' + (getBotUsername() || 'StarForgeX_bot'), { show_alert: true }).catch(() => {});
    }
    if ((z.wrong || []).includes(uid)) return ctx.answerCbQuery('Ти вже використав спробу в цій вікторині 🙂', { show_alert: true }).catch(() => {});

    const q = QUIZ[z.qi];
    if (choice !== q.ok) {
      z.wrong = (z.wrong || []).concat([uid]);
      setSt({ quiz: z });
      return ctx.answerCbQuery('❌ Неправильно. Спроба згоріла — чекай наступну вікторину!', { show_alert: true }).catch(() => {});
    }
    z.won = { uid, name: nameOf(ctx.from), plain: ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || 'хтось') };
    setSt({ quiz: z });
    if (!isAdminUid(uid)) addTickets(uid, CFG.quizPrize, 'вікторина в чаті');
    addPts(uid, 'quiz');
    addChatPts(uid, CFG.quizPts, null);
    questProg(uid, 'quiz', 1, null);
    const secs = Math.max(1, Math.round((Date.now() - z.at) / 1000));
    await ctx.answerCbQuery('✅ Правильно! +' + CFG.quizPrize + '🎫 вже на балансі', { show_alert: true }).catch(() => {});
    await bot.telegram.editMessageText(chatId, z.msgId, undefined, card('lightning', 'ВІКТОРИНА — Є ПЕРЕМОЖЕЦЬ', [
      '❓ ' + esc(q.q),
      E('check', '✅') + ' Відповідь: <b>' + esc(q.a[q.ok]) + '</b>',
      '',
      E('crown', '👑') + ' Переможець: <b>' + z.won.name + '</b> · +' + CFG.quizPrize + ' ' + TIX,
      E('clockIcon', '⏰') + ' Відповів за <b>' + secs + ' с</b>',
      (z.wrong || []).length ? E('redCircle', '🔴') + ' Помилились: ' + z.wrong.length : null,
    ], 'Наступна вікторина — скоро. Слідкуй за чатом!'),
      { parse_mode: 'HTML' }).catch(() => {});
  }

  // ─────────────────────── ⚔️ ДУЕЛІ ───────────────────────
  // /duel 5 — відкритий виклик; у відповідь на повідомлення — виклик конкретній людині.
  async function onDuelCmd(ctx) {
    const uid = String(ctx.from.id);
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const stake = Math.floor(Number(args[0]) || 0);
    const rid = { reply_to_message_id: ctx.message.message_id };
    if (!registered(uid)) {
      const link = botLink('chat');
      return ctx.reply(card('warn', 'СПЕРШУ ЗАПУСТИ БОТА', ['Дуелі — для тих, хто в боті. Тисни кнопку й повертайся 👇']),
        { ...rid, parse_mode: 'HTML', ...(link ? { reply_markup: { inline_keyboard: [[ubtn('Запустити бота', link, 'success', 'rocket')]] } } : {}) }).catch(() => {});
    }
    if (stake < CFG.duelMin || stake > CFG.duelMax) {
      return ctx.reply(card('infoIcon', 'ЯК ГРАТИ В ДУЕЛЬ', [
        '<code>/duel 5</code> — виклик <b>будь-кому</b> на 5 ' + TIX,
        'Відповідь на чиєсь повідомлення + <code>/duel 5</code> — виклик <b>цій людині</b>',
        '',
        'Ставка: від ' + CFG.duelMin + ' до ' + CFG.duelMax + ' ' + TIX,
        '🎲 Бот кидає кубик за кожного — у кого більше, той забирає банк',
        E('warn', '⚠️') + ' ' + CFG.duelBurnPercent + '% банку згорає',
      ]), { ...rid, parse_mode: 'HTML' }).catch(() => {});
    }
    const have = ticketsOf(db.getUser(uid));
    if (have < stake) {
      return ctx.reply(E('warn', '⚠️') + ' Замало білетів: у тебе <b>' + have + ' ' + TIX + '</b>, а ставка ' + stake + ' ' + TIX,
        { ...rid, parse_mode: 'HTML' }).catch(() => {});
    }

    const rep = ctx.message.reply_to_message;
    const target = rep && rep.from && !rep.from.is_bot && String(rep.from.id) !== uid ? rep.from : null;

    // Ставку того, хто викликає, резервуємо одразу.
    if (!addTickets(uid, -stake, 'дуель — ставка')) return;
    const id = crypto.randomBytes(4).toString('hex');
    const duel = { id, a: uid, aName: nameOf(ctx.from), b: target ? String(target.id) : null,
                   bName: target ? nameOf(target) : null, stake, at: Date.now(), msgId: null };
    const win = Math.floor(stake * 2 * (100 - CFG.duelBurnPercent) / 100);
    const text = card('lightning', 'ДУЕЛЬ · ставка ' + stake + ' ' + TIX, [
      E('redCircle', '🔴') + ' <b>' + duel.aName + '</b>  викликає  ' + E('greenCircle', '🟢') + ' <b>' + (target ? duel.bName : 'будь-кого') + '</b>',
      '',
      '<b>Як виграти:</b>',
      '• кожен ставить ' + stake + ' ' + TIX,
      '• бот кидає 🎲 за кожного',
      '• у кого більше — забирає <b>' + win + ' ' + TIX + '</b>',
    ], 'Виклик діє ' + CFG.duelTimeoutSec + ' с · ' + CFG.duelBurnPercent + '% банку згорає');
    const m = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
      btn('Прийняти виклик', 'dl:ok:' + id, 'success', 'check'),
      btn('Скасувати', 'dl:no:' + id, 'danger'),
    ]] } }).catch(() => null);
    if (!m) { addTickets(uid, stake, 'дуель — повернення'); return; }
    duel.msgId = m.message_id;
    duels.set(id, duel);
    saveDuels();
    setTimeout(() => expireDuel(id), CFG.duelTimeoutSec * 1000);
  }

  function saveDuels() {
    setSt({ duels: [...duels.values()].map(d => ({ id: d.id, a: d.a, stake: d.stake, at: d.at, b: d.b, accepted: !!d.accepted })) });
  }

  async function expireDuel(id) {
    const d = duels.get(id);
    if (!d || d.accepted) return;
    duels.delete(id); saveDuels();
    addTickets(d.a, d.stake, 'дуель — ніхто не прийняв');
    await bot.telegram.editMessageText(chatId, d.msgId, undefined, card('clockIcon', 'ДУЕЛЬ НЕ ВІДБУЛАСЬ', [
      'Виклик <b>' + d.aName + '</b> на ' + d.stake + ' ' + TIX + ' ніхто не прийняв.',
      E('check', '✅') + ' Ставку повернуто.',
    ], 'Спробуй ще раз: /duel ' + d.stake), { parse_mode: 'HTML' }).catch(() => {});
  }

  async function onDuelClick(ctx, act, id) {
    const d = duels.get(id);
    const uid = String(ctx.from.id);
    if (!d) return ctx.answerCbQuery('Ця дуель уже неактивна').catch(() => {});

    if (act === 'no') {
      if (uid !== d.a && uid !== d.b) return ctx.answerCbQuery('Скасувати може лише учасник дуелі').catch(() => {});
      if (d.accepted) return ctx.answerCbQuery('Дуель уже йде — скасувати не можна').catch(() => {});
      duels.delete(id); saveDuels();
      addTickets(d.a, d.stake, 'дуель — скасовано');
      await ctx.answerCbQuery('Скасовано, ставку повернуто').catch(() => {});
      return bot.telegram.editMessageText(chatId, d.msgId, undefined, card('redCircle', 'ДУЕЛЬ СКАСОВАНО', [
        E('check', '✅') + ' Ставку ' + d.stake + ' ' + TIX + ' повернуто.',
      ]), { parse_mode: 'HTML' }).catch(() => {});
    }

    if (d.accepted) return ctx.answerCbQuery('Дуель уже йде').catch(() => {});
    if (uid === d.a) return ctx.answerCbQuery('Сам із собою не можна 🙂 Чекай суперника').catch(() => {});
    if (d.b && uid !== d.b) return ctx.answerCbQuery('Цей виклик не тобі — кинь свій: /duel ' + d.stake).catch(() => {});
    if (!registered(uid)) return ctx.answerCbQuery('Спершу запусти бота @' + (getBotUsername() || 'StarForgeX_bot'), { show_alert: true }).catch(() => {});
    if (ticketsOf(db.getUser(uid)) < d.stake) return ctx.answerCbQuery('Замало білетів: потрібно ' + d.stake + '🎫', { show_alert: true }).catch(() => {});

    if (!addTickets(uid, -d.stake, 'дуель — ставка')) return ctx.answerCbQuery('Замало білетів', { show_alert: true }).catch(() => {});
    d.accepted = true; d.b = uid; d.bName = nameOf(ctx.from);
    saveDuels();
    await ctx.answerCbQuery('⚔️ Поїхали!').catch(() => {});
    const win = Math.floor(d.stake * 2 * (100 - CFG.duelBurnPercent) / 100);
    await bot.telegram.editMessageText(chatId, d.msgId, undefined, card('lightning', 'ДУЕЛЬ ПОЧАЛАСЬ · банк ' + d.stake * 2 + ' ' + TIX, [
      E('redCircle', '🔴') + ' <b>' + d.aName + '</b>',
      '        🆚',
      E('greenCircle', '🟢') + ' <b>' + d.bName + '</b>',
      '',
      'Переможець забирає <b>' + win + ' ' + TIX + '</b> · кидаємо кубики 👇',
    ]), { parse_mode: 'HTML' }).catch(() => {});

    // Перед кожним кубиком — підпис, чий це кидок. Раніше два кубики падали
    // без підпису, і було незрозуміло, хто що викинув.
    async function roll(color, name) {
      await send(E(color, color === 'redCircle' ? '🔴' : '🟢') + ' Кидає <b>' + name + '</b>');
      const r = await bot.telegram.sendDice(chatId, { emoji: '🎲' }).catch(() => null);
      return r && r.dice ? r.dice.value : 1 + crypto.randomInt(6);
    }

    let ra, rb, tries = 0;
    do {
      ra = await roll('redCircle', d.aName);
      rb = await roll('greenCircle', d.bName);
      tries++;
      if (ra === rb && tries < 3) {
        await new Promise(r => setTimeout(r, 3000));
        await send('🤝 Нічия <b>' + ra + ' : ' + rb + '</b> — перекидаємо!');
      }
    } while (ra === rb && tries < 3);

    await new Promise(r => setTimeout(r, ANIM_MS['🎲'] + 400));   // даємо кубикам докрутитись
    duels.delete(id); saveDuels();
    addPts(d.a, 'duel', { stake: d.stake });
    addPts(d.b, 'duel', { stake: d.stake });
    addChatPts(d.a, 3, null); addChatPts(d.b, 3, null);
    if (d.stake >= 2) { questProg(d.a, 'duel', 1, null); questProg(d.b, 'duel', 1, null); }

    if (ra === rb) {
      addTickets(d.a, d.stake, 'дуель — нічия'); addTickets(d.b, d.stake, 'дуель — нічия');
      return send(card('infoIcon', 'НІЧИЯ', ['Три нічиї поспіль — таке буває рідко!', E('check', '✅') + ' Ставки повернуто обом.']));
    }
    const aWon = ra > rb;
    const wUid = aWon ? d.a : d.b;
    const wName = aWon ? d.aName : d.bName;
    addTickets(wUid, win, 'дуель — перемога');
    addPts(wUid, 'duelWin', { stake: d.stake });
    addChatPts(wUid, 3, null);
    questProg(wUid, 'duel_win', 1, null);
    await send(card('trophy', 'РЕЗУЛЬТАТ ДУЕЛІ', [
      E('redCircle', '🔴') + ' ' + d.aName + ' — 🎲 <b>' + ra + '</b>' + (aWon ? '  ' + E('crown', '👑') : ''),
      E('greenCircle', '🟢') + ' ' + d.bName + ' — 🎲 <b>' + rb + '</b>' + (!aWon ? '  ' + E('crown', '👑') : ''),
      '',
      E('crown', '👑') + ' Перемога: <b>' + wName + '</b>',
      E('check', '✅') + ' Забирає: <b>+' + win + ' ' + TIX + '</b> і +3 XP',
    ], 'Хочеш реванш? /duel ' + d.stake));
  }

  // ─────────────────────── ⭐ XP ЗА ЧАТ ───────────────────────
  function onChatMessage(ctx) {
    const uid = String(ctx.from.id);
    const m = ctx.message;
    const t = (m.text || m.caption || '').trim();
    // Стікери, фото, гіфки, голосові — теж активність (але без очок, щоб не спамили).
    const media = !!(m.sticker || m.photo || m.animation || m.voice || m.video || m.video_note || m.document);
    dbgHit('recv'); dbgHit(media && !t ? 'media' : 'text');
    lastRecvAt = Date.now();
    if (!registered(uid)) { dbgHit('guests'); ensureGuest(ctx.from); remindGuest(ctx); }
    curMsgId = m.message_id;
    curMsgTs = m.date ? m.date * 1000 : Date.now();
    curText = t;
    checkRace(ctx, t);
    if (t.length >= CFG.actMinLen || media) { if (countActivity(uid)) dbgHit('counted'); }
    if (!registered(uid)) return;                       // далі — лише XP ліги й бали змагань
    // Зрідка бот ставить реакцію на змістовне повідомлення — чат відчувається живим.
    if (t.length >= 25 && crypto.randomInt(100) < 4) react(ctx.message.message_id, crypto.randomInt(2) ? '🔥' : '❤');
    if (t.length < CFG.chatXpMinLen) return;
    const last = lastXpAt.get(uid) || 0;
    if (last && Math.abs(curMsgTs - last) < CFG.chatXpCooldownSec * 1000) return;
    lastXpAt.set(uid, Math.max(last, curMsgTs));
    const mult = isHappy() ? 2 : 1;
    addPts(uid, 'msg');
    if (mult > 1) addPts(uid, 'msg');
    const today = kyivDay(Date.now());
    const u = db.getUser(uid) || {};
    db.upsertUser(uid, { chatMsgDay: today, chatMsgCount: (u.chatMsgDay === today ? (u.chatMsgCount || 0) : 0) + 1 });
  }


  // Гостю раз на 3 дні: «твої повідомлення вже рахуються — запусти бота, щоб забирати призи».
  function remindGuest(ctx) {
    const uid = String(ctx.from.id);
    const u = db.getUser(uid) || {};
    if (Date.now() - (u.guestRemindAt || 0) < 3 * 86400000) return;
    db.upsertUser(uid, { guestRemindAt: Date.now() });
    const link = botLink('chat');
    const pts = Math.floor(xpTotal(u));
    const L = LEVELS[levelOf(pts)];
    send('👋 ' + nameOf(ctx.from) + ', твої повідомлення <b>вже рахуються</b>' + (pts ? ' — у тебе ' + pts + ' XP, ти ' + L.e + ' ' + L.t : '') + '!\n' +
      'Запусти бота, щоб забирати <b>призи, бонуси й дропи</b> 🎁',
      { reply_to_message_id: ctx.message.message_id, ...(link ? { reply_markup: { inline_keyboard: [[ubtn('🚀 Запустити бота', link, 'success', 'rocket')]] } } : {}) });
  }

  // ─────────────────────── 👋 ПРИВІТАННЯ ───────────────────────
  async function onNewMembers(ctx) {
    const people = (ctx.message.new_chat_members || []).filter(m => !m.is_bot);
    if (!people.length) return;
    const names = people.map(nameOf).join(', ');
    const link = botLink('chat');
    await send(card('crown', 'ВІТАЄМО В ЧАТІ!', [
      '👋 <b>' + names + '</b>',
      '',
      'Тут щодня: ' + E('giftBox', '🎁') + ' дропи · ' + E('lightning', '⚡') + ' вікторини · ⚔️ дуелі · ' + E('starIcon', '⭐') + ' бонуси',
      'Щоб брати участь — запусти бота й забери стартові спіни',
    ], '/help — усі правила'),
      link ? { reply_markup: { inline_keyboard: [[ubtn('Запустити бота', link, 'success', 'rocket')]] } } : {});
  }

  // ─────────────────────── 📣 ОГОЛОШЕННЯ ───────────────────────
  // Викликається з сервера, коли хтось виграв щось вагоме.
  async function announce(text) {
    const s = st();
    const day = kyivDay(Date.now());
    const cnt = s.annDay === day ? (s.annCount || 0) : 0;
    if (cnt >= CFG.announceDayCap) return;
    if (Date.now() - lastAnnounceAt < CFG.announceGapSec * 1000) return;
    lastAnnounceAt = Date.now();
    setSt({ annDay: day, annCount: cnt + 1 });
    await send(text);
  }

  async function postLeagueTop() {
    const league = require('../features/league');
    const rows = league.standings().slice(0, 5);
    const left = time.weekEnd(Date.now()) - Date.now();
    const d = Math.floor(left / 86400000), h = Math.floor((left % 86400000) / 3600000);
    const lines = [];
    if (!rows.length) lines.push('Таблиця ще порожня — перше місце вільне!');
    rows.forEach((r, i) => { lines.push(medal(i) + ' ' + whoName(r.uid) + ' — <b>' + Math.floor(r.xp) + ' XP</b>'); });
    lines.push('');
    lines.push(E('pendingIcon', '⏳') + ' До підсумків: <b>' + (d ? d + ' дн ' : '') + h + ' год</b>');
    if (league.enabled()) [1, 2, 3].forEach(pl => lines.push(medal(pl - 1) + ' ' + esc(league.rewardText(econ.leagueRewardFor(pl), 'uk'))));
    const b = notify.appButton('Відкрити лігу', 'league');
    await send(card('trophy', 'ЛІГА ТИЖНЯ', lines, 'Кожне повідомлення тут — теж XP. Обганяй!'),
      b ? { reply_markup: { inline_keyboard: [[{ ...b, style: 'primary' }]] } } : {});
  }

  async function onTopCmd(ctx) { await postLeagueTop(); }

  async function onMeCmd(ctx) {
    const uid = String(ctx.from.id);
    const u = db.getUser(uid);
    const rid = { reply_to_message_id: ctx.message.message_id, parse_mode: 'HTML' };
    if (!u) {
      return ctx.reply(E('warn', '⚠️') + ' Поки жодного зарахованого повідомлення — напиши щось у чат 🙂', rid).catch(() => {});
    }
    // Хто пише в чаті, але не запускав бота: повідомлення РАХУЮТЬСЯ — показуємо це,
    // інакше людина бачила «ти не в боті» й думала, що нічого не зараховується.
    if (!u.lang) {
      const link = botLink('chat');
      const rkG = rankLine(Math.floor(xpTotal(u))), todayG = kyivDay(Date.now());
      return ctx.reply(card('crown', nameOf(ctx.from), [
        rkG.L.e + ' <b>' + rkG.L.t + '</b> · рівень ' + (rkG.i + 1) + ' · ' + Math.floor(xpTotal(u)) + ' XP',
        rkG.bar,
        '💬 Сьогодні зараховано: <b>' + actCount(u, todayG) + '</b> повідомл.',
        '',
        E('check', '✅') + ' Твої повідомлення рахуються до рівня',
        E('giftBox', '🎁') + ' Щоб забирати <b>призи, дропи й бонуси</b> — запусти бота',
      ]), { ...rid, ...(link ? { reply_markup: { inline_keyboard: [[ubtn('🚀 Запустити бота', link, 'success', 'rocket')]] } } : {}) }).catch(() => {});
    }
    const kk = contestActive();
    const cs = kk && kk.scores[uid];
    const today = kyivDay(Date.now());
    const ar = actRows(today); const ai = ar.findIndex(r => r.uid === uid);
    const g = goalState(today);
    const n = actCount(u, today);
    const rk = rankLine(Math.floor(xpTotal(u)));
    const qs = questsToday(today), qsS = qState(u, today);
    const qDone = qs.filter(q => qsS.d[q.k]).length;
    const lines = [
      rk.L.e + ' <b>' + rk.L.t + '</b> · рівень ' + (rk.i + 1),
      rk.bar + (rk.nx ? '  ще ' + rk.left + ' до «' + rk.nx.t + '»' : '  максимум!'),
      '',
      E('statsIcon', '📊') + ' Квести дня: <b>' + qDone + ' / 3</b>' + (qsS.all ? ' ' + E('check', '✅') : ' · /quests'),
      E('almost', '🔥') + ' Серія в чаті: <b>' + streakOf(u) + ' дн.</b>' + (function () {
        const next = Object.keys(CFG.streakMilestones).map(Number).find(d => d > streakOf(u));
        return next ? ' · до бонусу ' + next + ' дн.' : '';
      })(),
      '✍️ XP з чату сьогодні: <b>+' + Math.floor(progress.xpOf(u).day.src.chat || 0) + '</b> / ' + econ.XP.chat.dayCap,
      '💬 Сьогодні в чаті: <b>' + n + '</b> повідомл.' + (ai >= 0 ? ' · <b>#' + (ai + 1) + '</b> за активністю' : ''),
      n < CFG.activistMinMsgs ? '      до активіста дня — ще ' + (CFG.activistMinMsgs - n) : null,
      E('statsIcon', '📊') + ' Ціль чату: <b>' + g.count + ' / ' + CFG.goalTarget + '</b>' + (g.done ? ' ' + E('check', '✅') : ''),
      cs ? E('trophy', '🏆') + ' Змагання: <b>' + cs.pts + '</b> балів' : null,
      '',
      TIX + ' Білетів: <b>' + ticketsOf(u) + '</b>',
      E('starIcon', '⭐') + ' Зірок: <b>' + users.stars(u) + '</b>',
      isHappy() ? '\n' + E('almost', '🔥') + ' <b>Зараз ГАРЯЧА ГОДИНА — XP ×2!</b>' : null,
    ];
    await ctx.reply(card('crown', nameOf(ctx.from), lines), rid).catch(() => {});
  }

  // ─────────────────────── ⏱ РОЗКЛАД ───────────────────────
  async function tick() {
    if (chatId) {
      const hh = kyivHour(Date.now());
      if (hh >= 12 && hh < 22 && Date.now() - lastRecvAt > 3 * 3600000) {
        alertAdmin('silence', '⚠️ Бот уже понад 3 години не отримав жодного повідомлення з чату ' + chatRef + '.\n\n' +
          'Якщо люди там пишуть — бот їх не бачить. Найчастіше причина: бот не адміністратор.\nПеревір: /chat_debug');
        checkBotRights();
      }
    }
    const kc = st().contest;
    if (kc && !kc.finished && Date.now() >= kc.endsAt) await finishContest();
    if (!chatId) return;
    const s = st();
    if (s.paused) return;
    const now = Date.now();
    const h = kyivHour(now);
    const active = h >= CFG.activeFromHour && h < CFG.activeToHour;

    if (active) {
      if (!s.nextDropAt) setSt({ nextDropAt: now + randBetween(10, 40) * 60000 });
      else if (now >= s.nextDropAt) {
        setSt({ nextDropAt: now + randBetween(CFG.dropMinGapMin, CFG.dropMaxGapMin) * 60000 });
        await postDrop();
      }
      const s2 = st();
      if (!s2.nextQuizAt) setSt({ nextQuizAt: now + randBetween(30, 90) * 60000 });
      else if (now >= s2.nextQuizAt) {
        setSt({ nextQuizAt: now + randBetween(CFG.quizEveryMin - 30, CFG.quizEveryMin + 30) * 60000 });
        await postQuiz();
      }
    }

    const day = kyivDay(now);
    if (st().hhDay !== day) planHappyHour(day);
    const hw = hhWindow(day);
    if (hw && now >= hw.start && now < hw.end && !st().hhAnnounced) {
      setSt({ hhAnnounced: true });
      await send(card('almost', 'ГАРЯЧА ГОДИНА — ×2!', [
        E('clockIcon', '⏰') + ' Наступні <b>' + CFG.hhMinutes + ' хв</b>',
        E('lightning', '⚡') + ' Кожне повідомлення = <b>×2 XP</b> — рівень росте удвічі швидше' + (contestActive() ? ' і <b>×2 бали</b> змагання' : ''),
      ], 'Пиши зараз — такого вікна більше не буде до завтра 👇'));
    }
    if (hw && now >= hw.end && st().hhAnnounced && !st().hhEnded) {
      setSt({ hhEnded: true });
      await send(E('clockIcon', '⏰') + ' <b>Гаряча година закінчилась.</b>\n<i>Завтра — у новий несподіваний момент між ' + CFG.hhFromHour + ':00 і ' + CFG.hhToHour + ':00 👀</i>');
    }
    if (h === CFG.morningHour && s.morningDay !== day) {
      setSt({ morningDay: day });
      await postMorning();
    }
    await expireRace();
    if (active) {
      const s3 = st();
      if (!s3.nextRaceAt) setSt({ nextRaceAt: now + randBetween(40, 100) * 60000 });
      else if (now >= s3.nextRaceAt) {
        setSt({ nextRaceAt: now + randBetween(CFG.raceEveryMin - 40, CFG.raceEveryMin + 40) * 60000 });
        await postRace();
      }
    }
    if (h === CFG.activistTeaserHour && s.activistTeaserDay !== day) {
      setSt({ activistTeaserDay: day });
      await postActivistTeaser();
    }
    if (h === CFG.activistHour && s.activistDay !== day) {
      setSt({ activistDay: day });
      await postActivist();
    }
    if (false && h === CFG.leagueTopHour && s.topDay !== day) {
      setSt({ topDay: day });
      await postLeagueTop();
    }
  }

  // Після перезапуску повертаємо ставки в дуелях, які не встигли зіграти.
  // Лише тим, що створені ДО запуску процесу: раніше повернення запускалось
  // із затримкою й чіпляло дуелі, які йшли просто зараз, — люди отримували
  // і ставку назад, і виграш.
  function refundStaleDuels() {
    const list = st().duels || [];
    const stale = list.filter(d => (d.at || 0) < bootAt);
    for (const d of stale) {
      addTickets(d.a, d.stake, 'дуель — повернення після перезапуску');
      if (d.accepted && d.b) addTickets(d.b, d.stake, 'дуель — повернення після перезапуску');
    }
    if (stale.length) setSt({ duels: list.filter(d => (d.at || 0) >= bootAt) });
  }

  // ─────────────────────── МАРШРУТИЗАЦІЯ ───────────────────────
  // Усе з групи обробляємо ТУТ і далі не пускаємо: інакше повідомлення з чату
  // потрапили б у приватну логіку (наприклад, у стан «введи промокод»).
  function middleware() {
    return async (ctx, next) => {
      const type = ctx.chat && ctx.chat.type;
      if (type !== 'group' && type !== 'supergroup') return next();
      rememberChat(ctx);

      // /chat_here — адмін прив'язує бота до цієї групи вручну.
      const rawText = (ctx.message && ctx.message.text) || '';
      if (/^\/chat_here(@\w+)?$/i.test(rawText.trim()) && ctx.from && isAdminUid(ctx.from.id)) {
        bindChat(ctx.chat.id, 'командою адміна');
        return ctx.reply(E('check', '✅') + ' <b>Бот прив\'язаний до цього чату.</b>\n/help — усі команди.', { parse_mode: 'HTML' }).catch(() => {});
      }
      if (!isOurChat(ctx)) return;                       // чужі групи ігноруємо

      try {
        if (ctx.updateType === 'callback_query') {
          const data = ctx.callbackQuery.data || '';
          if (data.startsWith('cd:')) return onDropClick(ctx, data.slice(3));
          if (data.startsWith('cq:')) { const [, id, ch] = data.split(':'); return onQuizClick(ctx, id, +ch); }
          if (data.startsWith('dl:')) { const [, act, id] = data.split(':'); return onDuelClick(ctx, act, id); }
          return ctx.answerCbQuery().catch(() => {});
        }
        if (ctx.updateType === 'message' && ctx.message) {
          rememberAuthor(ctx);
          if (ctx.message.new_chat_members) return onNewMembers(ctx);
          const text = ctx.message.text || '';
          const cmd = text.startsWith('/') ? text.split(/\s|@/)[0].toLowerCase() : null;
          if (cmd === '/duel') return onDuelCmd(ctx);
          if (cmd === '/top') return onRankCmd(ctx);   // ліга вимкнена — показуємо легенд чату
          if (cmd === '/me') return onMeCmd(ctx);
          if (cmd === '/help' || cmd === '/start') return onHelpCmd(ctx);
          if (cmd === '/contest') return onContestCmd(ctx);
          if (cmd === '/bonus' || cmd === '/daily') return onBonusCmd(ctx);
          if (cmd === '/slot') return onGameCmd(ctx, 'slot');
          if (cmd === '/dice') return onGameCmd(ctx, 'dice');
          if (cmd === '/basket' || cmd === '/basketball') return onGameCmd(ctx, 'basket');
          if (cmd === '/football' || cmd === '/soccer') return onGameCmd(ctx, 'football');
          if (cmd === '/darts') return onGameCmd(ctx, 'darts');
          if (cmd === '/bowling') return onGameCmd(ctx, 'bowling');
          if (cmd === '/games') return ctx.reply(card('almost', 'ІГРИ НА БІЛЕТИ', gamesHelpLines().concat(['', 'Ставка від ' + SLOT.min + ' до ' + SLOT.max + ' ' + TIX])), { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }).catch(() => {});
          if (cmd === '/autowithdraw') return ctx.reply(autowdCard(), { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }).catch(() => {});
          if (cmd === '/quests' || cmd === '/q') return onQuestsCmd(ctx);
          if (cmd === '/rank') return onRankCmd(ctx);
          if (cmd === '/goal') {
            const g = goalState(kyivDay(Date.now()));
            const mine = actCount(db.getUser(String(ctx.from.id)), kyivDay(Date.now()));
            return ctx.reply(card('statsIcon', 'СПІЛЬНА ЦІЛЬ ДНЯ', [
              goalBar(g.count) + '  <b>' + g.count + ' / ' + CFG.goalTarget + '</b>' + (g.done ? ' ' + E('check', '✅') : ''),
              '',
              g.done ? E('check', '✅') + ' Виконано! Напиши ' + CFG.goalMinPer + '+ повідомлень — і бонус твій.'
                     : 'Дійдемо — кожен, хто написав <b>' + CFG.goalMinPer + '+</b>, отримає <b>' + goalText() + '</b>',
              'Твій внесок: <b>' + mine + '</b>' + (mine < CFG.goalMinPer ? ' (ще ' + (CFG.goalMinPer - mine) + ' до бонусу)' : ' ' + E('check', '✅')),
            ]), { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }).catch(() => {});
          }
          if (!cmd && ctx.from && !ctx.from.is_bot) onChatMessage(ctx);
        }
      } catch (e) { console.error('chat router:', e.message); }
    };
  }

  return {
    middleware, resolveChat, setupCommandMenu, postActivist, postActivistTeaser, tick, isHappy, postRace, postMorning,
    addChatPts: (uid, n) => addChatPts(String(uid), n, null),
    authorOf: (id) => authors.get(Number(id)) || null,
    listChats, debugStats: () => ({ ...dbg }), autowdCard,
    jackpot,
    levelOf: (pts) => LEVELS[levelOf(pts || 0)],
    levelInfo: (pts) => progress.levelInfo(pts || 0, 'uk'),
    announce, postDrop, postQuiz, postLeagueTop, refundStaleDuels,
    startContest, finishContest, contestRows: () => { const k = st().contest; return k ? contestRows(k) : []; },
    E, card, status() { return { chatId, chatRef, ...st() }; },
    pause() { setSt({ paused: true }); },
    resume() { setSt({ paused: false }); },
    get chatId() { return chatId; },
    CFG,
  };
}

module.exports = { createChat, QUIZ, CFG, CONTEST };
