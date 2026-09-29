// ==========================================================================
// Вся конфігурація в одному місці.
// ==========================================================================

const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@starforge_news';
const CHANNEL_URL = process.env.CHANNEL_URL || ('https://t.me/' + CHANNEL_USERNAME.replace(/^@/, ''));

// Партнерський канал для спільних розіграшів (наприклад /joint_giveaway_start).
// Онови на реальний юзернейм, коли домовишся з партнером.
const PARTNER_CHANNEL_USERNAME = null; // напр. '@partner_channel'

// ---- Сходи призів (Фаза 1 — публічно) ----
// emoji — звичайний unicode для адмін-повідомлень (plain текст).
// emojiKey — ключ з i18n.EMOJI для преміум-варіанту на екранах користувача.
const TIERS = [
  { id: 'bear',   name: 'Мішка',     emoji: '🧸', emojiKey: 'teddyBear', referrals: 5,  priceStars: 15 },
  { id: 'gift',   name: 'Подарунок', emoji: '🎁', emojiKey: 'giftBox',   referrals: 10, priceStars: 25 },
  { id: 'rocket', name: 'Ракета',    emoji: '🚀', emojiKey: 'rocket',    referrals: 20, priceStars: 50 },
  { id: 'trophy', name: 'Трофей',    emoji: '🏆', emojiKey: 'trophy',    referrals: 30, priceStars: 100 },
  // Між 30 і 150 була діра на 120 друзів — людина з 35 рефералами не мала
  // ЖОДНОЇ цілі попереду й просто кидала. Тепер крок рівний: наступна
  // сходинка завжди видно, і жодна не вимагає стрибка більш ніж удвічі.
  // NFT-сходинки: ~3,5⭐ за друга, як і вся драбина, і строго за зростанням
  // ціни. Раніше три NFT стояли на 45/65/90 друзях — утричі щедріше за решту,
  // а Evil Eye (800⭐) був РАНІШЕ за Xmas Stocking (400⭐).
  { id: 'xmas_stocking', name: 'Xmas Stocking', emoji: '🧦', emojiKey: 'xmasStocking', referrals: 120, priceStars: 400 },
  { id: 'wheel_snake',   name: 'Lunar Snake',   emoji: '🐍', emojiKey: 'lunarSnake',   referrals: 130, priceStars: 440 },
  { id: 'wheel_lolpop',  name: 'Lol Pop',       emoji: '🍭', emojiKey: 'lolPop',       referrals: 150, priceStars: 520 },
  { id: 'fresh_socks',   name: 'Fresh Socks',   emoji: '🧦', emojiKey: 'freshSocks',   referrals: 165, priceStars: 580 },
  { id: 'wheel_eye',     name: 'Evil Eye',      emoji: '🧿', emojiKey: 'eye',          referrals: 220, priceStars: 800 },
  { id: 'premium3m',     name: 'Telegram Premium 3 міс', emoji: '💎', emojiKey: 'premium', referrals: 240, priceStars: 900 },
  { id: 'diamond_ring',  name: 'Diamond Ring',  emoji: '💍', emojiKey: 'diamondRing',  referrals: 275, priceStars: 2900 },
  // Ексклюзивні NFT-призи КОЛЕСА (не з'являються у звичайних сходах призів —
  // excludeFromLadder ховає їх у showRewardsScreen). Ціни розраховані з курсу
  // 11 TON ≈ 1000⭐, який дав адмін.
  { id: 'wheel_eye',      name: 'Evil Eye',     emoji: '👁', emojiKey: null, priceStars: 800, excludeFromLadder: true },
  { id: 'wheel_stocking', name: 'Xmas Stocking', emoji: '🧦', emojiKey: null, priceStars: 450, excludeFromLadder: true },
  { id: 'wheel_snake',    name: 'Lunar Snake',  emoji: '🐍', emojiKey: null, priceStars: 440, excludeFromLadder: true },
  { id: 'wheel_lolpop',   name: 'Lol Pop',      emoji: '🍭', emojiKey: null, priceStars: 520, excludeFromLadder: true },
  { id: 'premium3m',      name: 'Telegram Premium 3 міс', emoji: '💎', emojiKey: null, priceStars: 1000, excludeFromLadder: true },
];
const LEGACY_TIER_NAMES = {
  wheel_calendar: 'Xmas Calendar', wheel_candy: 'Candy',
  wheel_y2k: 'Y2K Keycap', wheel_devil: 'Purple Devil',
};
// ВАЖЛИВО: якщо приз прибрали з лінійки, старі заявки на нього все одно
// мають лишатись обробними — інакше кнопка "Підтвердити" мовчки падає.
function getTier(id) {
  const found = TIERS.find(x => x.id === id);
  if (found) return found;
  return {
    id,
    name: LEGACY_TIER_NAMES[id] || String(id),
    emoji: '🎁',
    emojiKey: null,
    priceStars: 0,
    legacy: true,
  };
}

// ---- Подія / лідерборд (Фаза 2 — прихована, вмикається паролем) ----
// 31 серпня 2026, 12:00 за Києвом (UTC+3 влітку).
const EVENT_END = new Date(Date.UTC(2026, 7, 31, 9, 0, 0)).getTime();

// Призи зменшені під поточний розмір аудиторії (10-15 людей) — щоб не роздавати
// занадто щедро на малій базі. Коли аудиторія виросте (сотні+) — поверни
// повнішу версію нижче (закоментована) чи придумай нову під новий масштаб.
const EVENT_PRIZES_BY_PLACE = {
  1: [{ id: 'rocket', qty: 1 }],
  2: [{ id: 'gift', qty: 1 }],
  3: [{ id: 'bear', qty: 1 }],
};
const EVENT_PLACES_BEAR_ONLY = []; // поки без "усім топ-10 по мішці" — завелика частка аудиторії

// Повна версія на майбутнє (для великої аудиторії), розкоментуй і онови вище, коли будеш готовий:
// const EVENT_PRIZES_BY_PLACE = {
//   1: [{ id: 'trophy', qty: 3 }],
//   2: [{ id: 'trophy', qty: 2 }, { id: 'rocket', qty: 1 }],
//   3: [{ id: 'trophy', qty: 1 }, { id: 'rocket', qty: 1 }, { id: 'gift', qty: 1 }],
//   4: [{ id: 'rocket', qty: 1 }, { id: 'gift', qty: 1 }, { id: 'bear', qty: 1 }],
//   5: [{ id: 'gift', qty: 1 }, { id: 'bear', qty: 1 }],
// };
// const EVENT_PLACES_BEAR_ONLY = [6, 7, 8, 9, 10];

// ---- Комісія за реальний вивід подарунка (Фаза 2, оплата через Telegram Stars) ----
// Зараз 0% — пріоритет росту аудиторії, а не прибутку на цьому етапі.
// Коли база користувачів виросте — постав тут інше число (напр. 0.10 = 10%).
const COMMISSION_RATE = 0;
function commissionFor(tierId) {
  const tier = getTier(tierId);
  if (COMMISSION_RATE === 0) return 0;
  return Math.max(1, Math.ceil(tier.priceStars * COMMISSION_RATE));
}

// ---- Пароль підтвердження для прихованих адмін-функцій ----
// Береться зі змінної оточення. Пароль у коді бачить кожен, хто має доступ
// до репозиторію, тому стандартний лишено лише для сумісності — сервер
// попереджає про нього в логах на старті.
const ADVANCED_UNLOCK_PASSWORD = process.env.ADVANCED_UNLOCK_PASSWORD || '12345678';
const ADVANCED_UNLOCK_PASSWORD_IS_DEFAULT = !process.env.ADVANCED_UNLOCK_PASSWORD;

// Мінімальний баланс внутрішніх зірок для виводу (обміну на приз).
// Мінімальний баланс внутрішніх зірок для виводу — динамічно дорівнює ціні
// найдешевшого рівня (зараз Мішка, 15⭐), а не штучній фіксованій межі.
// Дозволені рівні для виводу — ті самі, що в STAR_WITHDRAW_TIERS у server.js.
const STAR_WITHDRAW_TIER_IDS = ['bear', 'gift', 'rocket', 'trophy', 'xmas_stocking'];
const STAR_WITHDRAW_MIN = Math.min(...TIERS.filter(t => STAR_WITHDRAW_TIER_IDS.includes(t.id)).map(t => t.priceStars));

module.exports = {
  CHANNEL_USERNAME, CHANNEL_URL, PARTNER_CHANNEL_USERNAME,
  TIERS, getTier,
  EVENT_END, EVENT_PRIZES_BY_PLACE, EVENT_PLACES_BEAR_ONLY,
  commissionFor,
  ADVANCED_UNLOCK_PASSWORD, ADVANCED_UNLOCK_PASSWORD_IS_DEFAULT, STAR_WITHDRAW_MIN, STAR_WITHDRAW_TIER_IDS,
};
