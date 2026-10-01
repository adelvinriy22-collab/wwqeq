// ==========================================================================
// Налаштування середовища. Усе, що відрізняється між тестом і продакшеном,
// приходить зі змінних оточення (див. .env.example).
// ==========================================================================
require('dotenv').config();
const path = require('path');

const env = process.env;
const int = (v, def, min) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return min != null ? Math.max(min, n) : n;
};

const ROOT = path.join(__dirname, '..');

const config = {
  ROOT,
  BOT_TOKEN: env.BOT_TOKEN || '',
  ADMIN_CHAT_ID: env.ADMIN_CHAT_ID ? String(env.ADMIN_CHAT_ID) : '',
  // Додаткові адміни (через кому). Мають доступ до адмін-панелі застосунку.
  ADMIN_IDS: String(env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  PORT: int(env.PORT, 3000),
  WEBAPP_URL: env.WEBAPP_URL || '',
  DATA_DIR: env.DATA_DIR || path.join(ROOT, 'data'),
  TELEGRAM_API_ROOT: env.TELEGRAM_API_ROOT || '',
  // Тест: подарунки від акаунта власника (MTProto) — /ugift.
  TG_API_ID: env.TG_API_ID || '',
  TG_API_HASH: env.TG_API_HASH || '',
  TG_SESSION: env.TG_SESSION || '',
  // Сухий прогін /ugift: усі повідомлення, але без MTProto і без витрати зірок.
  // Розіграш автовидачі: обов'язкова підписка (через кому). Бот має бути адміном там.
  AWD_SUB_CHANNELS: String(env.AWD_SUB_CHANNELS || '@Sanichkap').split(',').map(s => s.trim()).filter(Boolean),
  USERGIFT_DRY_RUN: env.USERGIFT_DRY_RUN === '1',

  CHANNEL_USERNAME: env.CHANNEL_USERNAME || '@starforge_news',
  CHAT_USERNAME: env.CHAT_USERNAME || '@starforge_chat',
  PARTNER_CHANNEL_USERNAME: env.PARTNER_CHANNEL_USERNAME || null,
  SUPPORT: env.SUPPORT_USERNAME || '@sherik17',

  ADVANCED_UNLOCK_PASSWORD: env.ADVANCED_UNLOCK_PASSWORD || '12345678',
  ADVANCED_UNLOCK_PASSWORD_IS_DEFAULT: !env.ADVANCED_UNLOCK_PASSWORD,

  INITDATA_MAX_AGE_SEC: int(env.INITDATA_MAX_AGE_SEC, 7 * 86400, 0),
  API_RATE_PER_MIN: int(env.API_RATE_PER_MIN, 600, 60),
  SPIN_MIN_GAP_MS: int(env.SPIN_MIN_GAP_MS, 1200, 0),
  TOPUP_MAX: int(env.TOPUP_MAX, 10000, 1),
  // Вимкнути фонові розклади (нагадування, банк, ліга) — для тестів.
  NO_SCHEDULERS: env.NO_SCHEDULERS === '1',

  LINKS: {
    earnChannel: env.EARN_CHANNEL_LINK || 'https://t.me/+xEU88NBPgm5iYzYy',
    temu: env.TEMU_LINK || 'https://temu.to/k/efbg59c6x6b',
    agent: env.AGENT_LINK || 'https://t.me/Agent301Bot/app?startapp=ref_HqqXRf',
    partner: env.PARTNER_LINK || 'https://t.me/gramtondropbot?start=ref_6280327267',
  },
};
config.CHANNEL_URL = env.CHANNEL_URL || ('https://t.me/' + config.CHANNEL_USERNAME.replace(/^@/, ''));

config.isAdminUid = (uid) => {
  const id = String(uid || '');
  if (!id) return false;
  return id === config.ADMIN_CHAT_ID || config.ADMIN_IDS.includes(id);
};

module.exports = config;
