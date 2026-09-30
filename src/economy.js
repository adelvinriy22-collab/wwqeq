// ==========================================================================
// ЕКОНОМІКА — усі числа гри в одному місці.
//
// Дві валюти:
//   ⭐ зірки  — реальні гроші: поповнення Telegram Stars, вивід, платні спіни
//   🎫 білети — безкоштовна валюта за активність і друзів: колесо білетів,
//              ставки в банк, ігри в чаті, обмін 10🎫 = 2⭐
//
// Один досвід (XP) за будь-яку дію. З нього рахуються:
//   • рівень гравця (назавжди, з титулами й нагородами за рівні)
//   • сезонний пас (XP за поточний сезон)
//   • ліга тижня (XP за поточний тиждень)
// ==========================================================================

// ─── Призи (реальні подарунки, видаються адміном через заявку) ───────────
// ladder — сходинка «за друзів»: скільки запрошених потрібно.
const TIERS = [
  { id: 'bear',   emoji: '🧸', price: 15,  ladder: 5,   img: 'bear',   name: { uk: 'Мішка', en: 'Teddy Bear', ru: 'Мишка' } },
  { id: 'gift',   emoji: '🎁', price: 25,  ladder: 10,  img: 'gift',   name: { uk: 'Подарунок', en: 'Gift', ru: 'Подарок' } },
  { id: 'rocket', emoji: '🚀', price: 50,  ladder: 20,  img: 'rocket', name: { uk: 'Ракета', en: 'Rocket', ru: 'Ракета' } },
  { id: 'trophy', emoji: '🏆', price: 100, ladder: 30,  img: 'trophy', name: { uk: 'Трофей', en: 'Trophy', ru: 'Трофей' } },
  { id: 'xmas_stocking', emoji: '🧦', price: 400, ladder: 120, img: 'wheel_stocking', name: { uk: 'Xmas Stocking', en: 'Xmas Stocking', ru: 'Xmas Stocking' } },
  { id: 'wheel_snake',   emoji: '🐍', price: 440, ladder: 130, img: 'wheel_snake', name: { uk: 'Lunar Snake', en: 'Lunar Snake', ru: 'Lunar Snake' } },
  { id: 'wheel_lolpop',  emoji: '🍭', price: 520, ladder: 150, img: 'wheel_lolpop', name: { uk: 'Lol Pop', en: 'Lol Pop', ru: 'Lol Pop' } },
  { id: 'fresh_socks',   emoji: '🧦', price: 580, ladder: 165, img: null, name: { uk: 'Fresh Socks', en: 'Fresh Socks', ru: 'Fresh Socks' } },
  { id: 'wheel_eye',     emoji: '🧿', price: 800, ladder: 220, img: 'nft', name: { uk: 'Evil Eye', en: 'Evil Eye', ru: 'Evil Eye' } },
  { id: 'premium3m',     emoji: '💎', price: 900, ladder: 240, img: 'premium3m', name: { uk: 'Telegram Premium 3 міс', en: 'Telegram Premium 3 months', ru: 'Telegram Premium 3 мес.' } },
  { id: 'diamond_ring',  emoji: '💍', price: 2900, ladder: 275, img: null, name: { uk: 'Diamond Ring', en: 'Diamond Ring', ru: 'Diamond Ring' } },
  // Лише з колеса (не на сходах).
  { id: 'wheel_stocking', emoji: '🧦', price: 450, ladder: null, img: 'wheel_stocking', name: { uk: 'Xmas Stocking', en: 'Xmas Stocking', ru: 'Xmas Stocking' } },
];
const LEGACY_TIERS = {
  wheel_calendar: 'Xmas Calendar', wheel_candy: 'Candy', wheel_y2k: 'Y2K Keycap', wheel_devil: 'Purple Devil',
  stars_payout: 'Вивід зірок',
};
// Невідомий id (приз прибрали) не має ламати обробку старих заявок.
function getTier(id) {
  const t = TIERS.find(x => x.id === id);
  if (t) return t;
  const nm = LEGACY_TIERS[id] || String(id);
  return { id, emoji: '🎁', price: 0, ladder: null, img: null, name: { uk: nm, en: nm, ru: nm }, legacy: true };
}
function tierName(id, lang) { const t = getTier(id); return t.name[lang] || t.name.uk; }

// ─── Колеса ──────────────────────────────────────────────────────────────
// weights — справжні шанси (вирішує сервер). segments — як колесо виглядає
// (однаково на сервері й у застосунку, щоб стрілка завжди падала на свій сектор).
const WHEELS = {
  daily: {
    title: { uk: 'Щоденне', en: 'Daily', ru: 'Ежедневное' },
    cost: { stars: 0, tickets: 0 },
    weights: {
      star2: 300, star3: 300, star5: 90, star8: 22, star12: 6, star25: 1.5,
      tix1: 180, tix3: 75, tix5: 20,
      gift: 0.8, rocket: 0.4, trophy: 0.15, wheel_stocking: 0.2, wheel_snake: 0.2, wheel_lolpop: 0.12, wheel_eye: 0.06, premium3m: 0.02,
    },
    segments: ['star2', 'gift', 'star3', 'rocket', 'tix1', 'nft', 'star5', 'trophy', 'tix3', 'star8', 'tix5', 'star12', 'tix1', 'star25'],
  },
  referral: {   // історична назва: тепер це колесо білетів
    title: { uk: 'За білети', en: 'Tickets', ru: 'За билеты' },
    cost: { stars: 0, tickets: 5 },
    weights: {
      star2: 400, star3: 250, star5: 150, star7: 60, star10: 20, star15: 8,
      gift: 1.5, rocket: 0.7, trophy: 0.3, wheel_stocking: 0.45, wheel_snake: 0.45, wheel_lolpop: 0.3, wheel_eye: 0.15, premium3m: 0.05,
    },
    segments: ['star2', 'gift', 'star3', 'rocket', 'star5', 'nft', 'star7', 'trophy', 'star2', 'star10', 'star3', 'star15'],
  },
  paid: {
    title: { uk: 'За зірки', en: 'Stars', ru: 'За звёзды' },
    cost: { stars: 15, tickets: 0 },
    weights: {
      star5: 520, star7: 230, star10: 120, star15: 40, star25: 12, star50: 3,
      gift: 3.5, rocket: 1.4, trophy: 0.6, wheel_stocking: 0.8, wheel_snake: 0.8, wheel_lolpop: 0.55, wheel_eye: 0.25, premium3m: 0.08,
    },
    segments: ['star5', 'gift', 'star7', 'rocket', 'star10', 'nft', 'star15', 'trophy', 'star5', 'star25', 'star7', 'star50'],
  },
  // Колесо за реальні Telegram Stars вимкнене рішенням адміна. Конфіг лишено
  // для історії спінів.
  premium: {
    disabled: true,
    title: { uk: 'Преміум', en: 'Premium', ru: 'Премиум' },
    cost: { stars: 0, tickets: 0 }, realStars: 25,
    weights: { star5: 300, star10: 220, star15: 150, star20: 90, star30: 40, star50: 14, gift: 9, rocket: 5, trophy: 3 },
    segments: ['star5', 'gift', 'star10', 'rocket', 'star15', 'trophy', 'star20', 'star30', 'star50'],
  },
};
// Гарантія: стеля невдач. На безкоштовних колесах гарантується лише подарунок.
const PITY = {
  daily:    { gift: 150, nft: null },
  referral: { gift: 120, nft: null },
  paid:     { gift: 60, nft: 250 },
  premium:  { gift: 15, nft: 50 },
};
const GIFT_IDS = ['gift', 'rocket', 'trophy'];
const NFT_IDS = ['wheel_stocking', 'wheel_snake', 'wheel_lolpop', 'wheel_eye'];
const PRIZE_IDS = GIFT_IDS.concat(NFT_IDS, ['premium3m']);
// Щаслива година: щодня одна випадкова година (9:00–21:00 Київ) — шанси NFT ×2.
const HAPPY_HOUR = { fromHour: 9, toHour: 21, nftMult: 2 };

// Серія щоденних спінів: бонус зірками на віхах.
function streakBonus(streak) {
  if (streak % 30 === 0) return 10;
  if (streak % 14 === 0) return 5;
  if (streak % 7 === 0) return 3;
  if (streak % 3 === 0) return 1;
  return 0;
}

// ─── Ризик ×2 ───────────────────────────────────────────────────────────
const RISK = { chance: 0.45, maxStreak: 3, windowMs: 5 * 60000 };

// ─── Ігри в застосунку (перевірювано чесні). RTP 87–93%. ────────────────
// faces — скільки можливих значень; win — які значення виграють.
const GAMES = {
  dice: {
    emoji: '🎲', faces: 6, title: { uk: 'Кубик', en: 'Dice', ru: 'Кубик' },
    bets: {
      even: { win: [2, 4, 6], k: 1.85, title: { uk: 'Парне', en: 'Even', ru: 'Чётное' } },
      odd:  { win: [1, 3, 5], k: 1.85, title: { uk: 'Непарне', en: 'Odd', ru: 'Нечётное' } },
      high: { win: [4, 5, 6], k: 1.85, title: { uk: 'Більше 3', en: 'Over 3', ru: 'Больше 3' } },
      low:  { win: [1, 2, 3], k: 1.85, title: { uk: 'Менше 4', en: 'Under 4', ru: 'Меньше 4' } },
      six:  { win: [6], k: 5.2, title: { uk: 'Рівно 6', en: 'Exactly 6', ru: 'Ровно 6' } },
    },
  },
  darts: {
    emoji: '🎯', faces: 6, title: { uk: 'Дартс', en: 'Darts', ru: 'Дартс' },
    bets: { bull: { win: [6], k: 5.2, title: { uk: 'У яблучко', en: 'Bullseye', ru: 'В яблочко' } } },
  },
  bowling: {
    emoji: '🎳', faces: 6, title: { uk: 'Боулінг', en: 'Bowling', ru: 'Боулинг' },
    bets: { strike: { win: [6], k: 5.2, title: { uk: 'Страйк', en: 'Strike', ru: 'Страйк' } } },
  },
  basket: {
    emoji: '🏀', faces: 5, title: { uk: 'Баскетбол', en: 'Basketball', ru: 'Баскетбол' },
    bets: { hit: { win: [4, 5], k: 2.3, title: { uk: 'Влучив', en: 'Score', ru: 'Попал' } } },
  },
  football: {
    emoji: '⚽', faces: 5, title: { uk: 'Футбол', en: 'Football', ru: 'Футбол' },
    bets: {
      goal: { win: [3, 4, 5], k: 1.55, title: { uk: 'Гол', en: 'Goal', ru: 'Гол' } },
      miss: { win: [1, 2], k: 2.3, title: { uk: 'Повз ворота', en: 'Miss', ru: 'Мимо' } },
    },
  },
  // Три барабани по 4 символи: 777 ×20 · три однакові ×6 · дві сімки ×2 (RTP 87.5%).
  slots: {
    emoji: '🎰', faces: 64, title: { uk: 'Слоти', en: 'Slots', ru: 'Слоты' },
    bets: { spin: { slots: true, title: { uk: 'Крутити', en: 'Spin', ru: 'Крутить' } } },
  },
};
const SLOT_SYMBOLS = ['BAR', '🍇', '🍋', '7'];
function slotResult(v) {
  const x = v - 1, r = [x & 3, (x >> 2) & 3, (x >> 4) & 3];
  let k = 0;
  if (r[0] === 3 && r[1] === 3 && r[2] === 3) k = 20;
  else if (r[0] === r[1] && r[1] === r[2]) k = 6;
  else if (r.filter(z => z === 3).length === 2) k = 2;
  return { reels: r, k };
}
const GAME_BET = { min: 1, max: 1000, presets: [1, 5, 10, 25, 50, 100] };

// ─── Білети, обмін, вивід, поповнення ───────────────────────────────────
const TICKETS = { perFriend: 1, exchangeTickets: 10, exchangeStars: 2 };
const WITHDRAW = { min: 15, feePercent: 5, minReferrals: 3 };
// feePercent — комісія гравця (залежить від рівня, див. LEVEL_PERKS); без неї — базова.
const withdrawCost = (payout, feePercent) => {
  const fee = feePercent == null ? WITHDRAW.feePercent : feePercent;
  const cost = Math.ceil(payout * (1 + fee / 100));
  return { payout, cost, fee: cost - payout };
};
const DEPOSIT = { bonusPercent: 10, bonusTimes: 3, presets: [15, 50, 100, 250, 500, 1000] };

// Магазин: приз за зірки без рандому. Відкривається після першого платного спіну.
const SHOP = { items: ['bear', 'gift', 'rocket', 'trophy'], unlockPaidSpins: 1, feePercent: 0 };
const shopPrice = (tier) => Math.ceil(tier.price * (1 + SHOP.feePercent / 100));

// ─── Досвід (XP) ────────────────────────────────────────────────────────
// dayCap — скільки XP максимум за день із цього джерела.
const XP = {
  chat:     { dayCap: 200 },   // повідомлення, дропи, вікторини, дуелі, квести чату
  spin:     { per: 10, dayCap: 80 },    // безкоштовний / білетний спін
  wager:    { dayCap: 450 },  // ставки: платні спіни 3/⭐, ігри 2/⭐, банк 1/⭐
  bank:     { per: 15 },       // перша ставка в кожен банк
  friend:   { per: 75, dayCap: 300 },   // приведений друг (XP — лише за перших 4 на день; білети — за кожного)
  deposit:  { per: 100, dayCap: 300 },
  quest:    { dayCap: 300 },   // питання дня, завдання, промокоди, серія
  admin:    {},
};
const XP_RATES = { paidSpinPerStar: 3, gamePerStar: 2, bankPerStar: 1 };

// Рівні гравця. Пороги перших десяти — ті самі, що були в чаті, тож
// титули в людей не змінюються. Нагороди й привілеї рівнів — нижче.
const LEVELS = [
  { at: 0,     e: '🌱', t: { uk: 'Новачок', en: 'Rookie', ru: 'Новичок' } },
  { at: 25,    e: '🙂', t: { uk: 'Свій', en: 'Regular', ru: 'Свой' } },
  { at: 75,    e: '💬', t: { uk: 'Балакун', en: 'Talker', ru: 'Болтун' } },
  { at: 160,   e: '⚡', t: { uk: 'Активіст', en: 'Activist', ru: 'Активист' } },
  { at: 300,   e: '🔥', t: { uk: 'Завсідник', en: 'Frequenter', ru: 'Завсегдатай' } },
  { at: 500,   e: '🛡', t: { uk: 'Ветеран', en: 'Veteran', ru: 'Ветеран' } },
  { at: 800,   e: '⭐', t: { uk: 'Зірка', en: 'Star', ru: 'Звезда' } },
  { at: 1200,  e: '💎', t: { uk: 'Майстер', en: 'Master', ru: 'Мастер' } },
  { at: 1800,  e: '👑', t: { uk: 'Легенда', en: 'Legend', ru: 'Легенда' } },
  { at: 2600,  e: '🌌', t: { uk: 'Міф', en: 'Myth', ru: 'Миф' } },
  { at: 3600,  e: '🗿', t: { uk: 'Титан', en: 'Titan', ru: 'Титан' } },
  { at: 5000,  e: '🏆', t: { uk: 'Чемпіон', en: 'Champion', ru: 'Чемпион' } },
  { at: 7000,  e: '🎖', t: { uk: 'Гросмейстер', en: 'Grandmaster', ru: 'Гроссмейстер' } },
  { at: 10000, e: '♾️', t: { uk: 'Безсмертний', en: 'Immortal', ru: 'Бессмертный' } },
  { at: 14000, e: '🍀', t: { uk: 'Бог удачі', en: 'God of Luck', ru: 'Бог удачи' } },
];
// Нагорода за НОВИЙ рівень (index від 0: рівень 2 → index 1). Що вище рівень —
// то більша; з 6-го через рівень додаються зірки. Видається один раз.
const LEVEL_REWARDS = [
  {},                          //  1 🌱
  { tickets: 2 },              //  2 🙂
  { tickets: 3 },              //  3 💬
  { tickets: 5 },              //  4 ⚡
  { tickets: 7 },              //  5 🔥
  { tickets: 10, stars: 2 },   //  6 🛡
  { tickets: 12 },             //  7 ⭐
  { tickets: 15, stars: 5 },   //  8 💎
  { tickets: 20 },             //  9 👑
  { tickets: 25, stars: 10 },  // 10 🌌
  { tickets: 30 },             // 11 🗿
  { tickets: 35, stars: 20 },  // 12 🏆
  { tickets: 40 },             // 13 🎖
  { tickets: 50, stars: 35 },  // 14 ♾️
  { tickets: 100, stars: 75 }, // 15 🍀
];
const levelReward = (index) => LEVEL_REWARDS[index] || {};

// Привілеї рівня — діють постійно, щойно рівень досягнуто.
// [з якого рівня (номер, від 1), значення]
const LEVEL_PERKS = {
  withdrawFee: [[1, 5], [6, 4], [8, 3], [10, 2], [12, 1], [14, 0]],     // % комісії виводу
  topupBonus:  [[1, 0], [7, 2], [9, 3], [11, 5], [13, 7], [15, 10]],    // % бонусу до КОЖНОГО поповнення
  chatBonus:   [[1, 0], [4, 1], [7, 2], [10, 3], [13, 5]],             // +🎫 до щоденного /bonus у чаті
};
function perkAt(key, n) {
  let v = LEVEL_PERKS[key][0][1];
  for (const [from, x] of LEVEL_PERKS[key]) if (n >= from) v = x;
  return v;
}
const levelPerks = (n) => ({ withdrawFee: perkAt('withdrawFee', n), topupBonus: perkAt('topupBonus', n), chatBonus: perkAt('chatBonus', n) });
// Що саме змінилось на рівні n (для «новий рівень!» і сходинок).
function perksUnlockedAt(n) {
  const out = {};
  for (const key of Object.keys(LEVEL_PERKS)) {
    const hit = LEVEL_PERKS[key].find(([from]) => from === n && n > 1);
    if (hit) out[key] = hit[1];
  }
  return out;
}

// ─── Сезонний пас (XP за сезон) ─────────────────────────────────────────
const PASS = {
  seasonDays: 30,
  epoch: Date.UTC(2026, 0, 1),
  maxLevel: 30,
  levelXp: 100,
  price: 150,          // з внутрішнього балансу
  priceXtr: 100,       // реальними Telegram Stars
  xtrBonusLevels: 2,
};
const r = (type, amount, extra) => Object.assign({ type, amount }, extra || {});
PASS.free = {
  3: r('tickets', 3), 6: r('freeSpin', 1), 9: r('stars', 2), 12: r('tickets', 5), 15: r('freeSpin', 1),
  18: r('stars', 3), 21: r('tickets', 5), 24: r('freeSpin', 1), 27: r('stars', 5), 30: r('tickets', 10),
};
PASS.prem = {
  2: r('stars', 2), 4: r('freeSpin', 1), 6: r('tickets', 5), 8: r('stars', 3), 10: r('paidSpin', 1),
  12: r('stars', 3), 14: r('tickets', 10), 16: r('freeSpin', 2), 18: r('stars', 5), 20: r('paidSpin', 1),
  22: r('stars', 5), 24: r('tickets', 15), 26: r('freeSpin', 2), 28: r('stars', 8),
  30: r('final', 0, { stars: 30, paidSpin: 1, prize: 'bear' }),
};

// ─── Ліга тижня (XP за тиждень) ─────────────────────────────────────────
const LEAGUE = {
  minXpForPrize: 50,
  participationXp: 150, participationTickets: 3,
  rewards: [
    { from: 1, to: 1,  items: [{ type: 'tier', id: 'trophy' }, { type: 'tickets', n: 50 }] },
    { from: 2, to: 2,  items: [{ type: 'tier', id: 'rocket' }, { type: 'tickets', n: 30 }] },
    { from: 3, to: 3,  items: [{ type: 'tier', id: 'gift' },   { type: 'tickets', n: 20 }] },
    { from: 4, to: 5,  items: [{ type: 'tier', id: 'bear' },   { type: 'tickets', n: 10 }] },
    { from: 6, to: 10, items: [{ type: 'stars', n: 10 },       { type: 'tickets', n: 5 }] },
  ],
};
function leagueRewardFor(rank) {
  const x = LEAGUE.rewards.find(q => rank >= q.from && rank <= q.to);
  return x ? x.items : null;
}

// ─── Спільна ціль (усі спіни разом) ─────────────────────────────────────
const GOAL = { target: 100, prize: 'gift' };

module.exports = {
  TIERS, getTier, tierName,
  WHEELS, PITY, GIFT_IDS, NFT_IDS, PRIZE_IDS, HAPPY_HOUR, streakBonus,
  RISK, GAMES, SLOT_SYMBOLS, slotResult, GAME_BET,
  TICKETS, WITHDRAW, withdrawCost, DEPOSIT, SHOP, shopPrice,
  XP, XP_RATES, LEVELS, levelReward, LEVEL_PERKS, levelPerks, perksUnlockedAt, PASS, LEAGUE, leagueRewardFor, GOAL,
};
