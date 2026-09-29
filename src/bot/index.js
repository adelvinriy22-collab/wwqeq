// ==========================================================================
// БОТ. Збирає модулі в один Telegraf і запускає long polling.
//
// Порядок проміжних обробників важливий:
//   1. облік активності та імені;
//   2. групи → модуль чату (далі не йдуть);
//   3. техроботи (оплата проходить завжди);
//   4. команди й кнопки модулів;
//   5. маршрутизатор тексту (діалоги адміна, промокод, пароль-челендж);
//   6. старі кнопки → «усе в застосунку».
// ==========================================================================
const { Telegraf } = require('telegraf');
const config = require('../config');
const users = require('../core/users');
const notify = require('../core/notify');
const start = require('./start');
const apps = require('./admin/apps');
const ops = require('./admin/ops');
const campaigns = require('./admin/campaigns');
const community = require('./admin/community');
const tasks = require('./admin/tasks');
const { createChat } = require('../chat/chat');

function createBot(token) {
  const bot = new Telegraf(token || config.BOT_TOKEN, {
    handlerTimeout: 10 * 60 * 1000,
    ...(config.TELEGRAM_API_ROOT ? { telegram: { apiRoot: config.TELEGRAM_API_ROOT } } : {}),
  });

  // 429 «Too Many Requests»: Telegram каже, скільки почекати, — чекаємо й
  // повторюємо (до двох разів), щоб повідомлення в розсилках не губились.
  const callApi = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = async function (method, payload, opts) {
    for (let attempt = 0; ; attempt++) {
      try { return await callApi(method, payload, opts); }
      catch (e) {
        const retry = e && ((e.parameters && e.parameters.retry_after) || (e.response && e.response.parameters && e.response.parameters.retry_after));
        if (e && e.code === 429 && retry && retry <= 30 && attempt < 2) { await new Promise(r => setTimeout(r, (retry + 0.5) * 1000)); continue; }
        throw e;
      }
    }
  };

  // Telegraf бере нову пачку оновлень лише після повної обробки попередньої.
  // Кубик у чаті чекає 4 с, розсилка — хвилини, тож кожне оновлення
  // обробляємо окремо, щоб черга не блокувалась.
  const handleOriginal = bot.handleUpdate.bind(bot);
  bot.handleUpdate = function (update, webhookResponse) {
    if (webhookResponse) return handleOriginal(update, webhookResponse);
    handleOriginal(update).catch((e) => console.error('update failed:', e && e.message));
    return Promise.resolve();
  };

  bot.catch((err, ctx) => console.error('bot error' + (ctx && ctx.updateType ? ' [' + ctx.updateType + ']' : '') + ':', err && err.message));

  const hooks = { onStartPayload: [], onText: [], onCommand: [], onAdminText: [] };

  // 1. Активність, ім'я, Premium. Заблокував бота — не шлемо нагадувань.
  bot.use(async (ctx, next) => {
    if (ctx.updateType === 'my_chat_member' && ctx.chat && ctx.chat.type === 'private' && ctx.from) {
      const st = ctx.myChatMember.new_chat_member && ctx.myChatMember.new_chat_member.status;
      if (users.get(ctx.from.id)) users.patch(ctx.from.id, { remindersOff: st === 'kicked' });
      return;
    }
    if (ctx.from && !ctx.from.is_bot) {
      const uid = String(ctx.from.id);
      const u = users.get(uid);
      if (u) {
        const p = {};
        if (u.username !== (ctx.from.username || null) || (ctx.from.first_name && u.name !== ctx.from.first_name)) { p.username = ctx.from.username || null; p.name = ctx.from.first_name || u.name || ''; }
        if (!users.isAdmin(uid) && (!u.lastActiveAt || Date.now() - u.lastActiveAt > 60000)) p.lastActiveAt = Date.now();
        if (!!u.isPremium !== !!ctx.from.is_premium) p.isPremium = !!ctx.from.is_premium;
        if (u.remindersOff && ctx.chat && ctx.chat.type === 'private' && ctx.updateType === 'message') p.remindersOff = false;
        if (Object.keys(p).length) users.patch(uid, p);
      }
    }
    return next();
  });

  // 2. Групи.
  const chat = createChat(bot);
  notify.tg.chat = chat;
  bot.use(chat.middleware());

  // 3. Техроботи.
  bot.use(start.maintenanceGate());

  // 4. Модулі.
  start.register(bot, hooks);
  campaigns.register(bot, hooks);
  apps.register(bot, hooks);
  ops.register(bot);
  ops.registerTextHooks(hooks);
  community.register(bot, hooks);
  tasks.register(bot);

  // 5. Текст в особистих.
  bot.on('text', async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return next();
    const uid = String(ctx.from.id);
    const text = ctx.message.text || '';
    if (text.startsWith('/')) { for (const h of hooks.onCommand) h(uid); return next(); }
    if (users.isAdmin(uid)) { for (const h of hooks.onAdminText) { if (await h(ctx, text)) return; } }
    for (const h of hooks.onText) { if (await h(ctx, uid, text)) return; }
    return next();
  });

  // 6. Старі кнопки зі старих повідомлень.
  start.legacyCallbacks(bot);

  return { bot, hooks, chat };
}

async function setupUi(bot) {
  const tg = bot.telegram;
  await tg.setMyCommands([
    { command: 'start', description: '🏠 Відкрити StarForge' },
    { command: 'topup', description: '⭐ Поповнити баланс' },
    { command: 'friends', description: '👥 Запросити друзів' },
    { command: 'promo', description: '🎁 Ввести промокод' },
    { command: 'lang', description: '🌐 Мова' },
    { command: 'help', description: '❓ Допомога' },
  ], { scope: { type: 'all_private_chats' } }).catch(e => console.error('setMyCommands:', e.message));
  const adminChats = [...new Set([config.ADMIN_CHAT_ID].concat(config.ADMIN_IDS || []).filter(Boolean))];
  for (const id of adminChats) {
    await tg.setMyCommands([
      { command: 'admin', description: 'Адмін-команди' },
      { command: 'apps', description: 'Черга заявок' },
      { command: 'event_status', description: 'Що зараз запущено' },
      { command: 'maint', description: 'Техроботи' },
      { command: 'dbstats', description: 'Зріз бази' },
      { command: 'broadcast', description: 'Розсилка (відповіддю на повідомлення)' },
      { command: 'chat_status', description: 'Стан чату' },
      { command: 'version', description: 'Версія' },
    ], { scope: { type: 'chat', chat_id: Number(id) } }).catch(e => console.error('setMyCommands(admin):', e.message));
  }
  if (config.WEBAPP_URL) {
    await tg.setChatMenuButton({ menuButton: { type: 'web_app', text: '⭐ Грати', web_app: { url: config.WEBAPP_URL } } })
      .catch(e => console.error('setChatMenuButton:', e.message));
  }
}

// Запуск із повторами: HTTP-сервер працює навіть коли Telegram недоступний.
function launch(bot, chat, onReady) {
  let launching = false;
  async function attempt(n) {
    if (launching) return;
    launching = true;
    try {
      const me = await bot.telegram.getMe();
      notify.tg.telegram = bot.telegram;
      notify.tg.botUsername = me.username;
      console.log('✅ Бот @' + me.username);
      try { campaigns.scheduleAll(); } catch (e) { console.error('campaigns.scheduleAll:', e.message); }
      try { chat.refundStaleDuels(); } catch (e) { console.error('refundStaleDuels:', e.message); }
      setTimeout(() => chat.resolveChat().catch(() => {}), 3000);
      setupUi(bot).catch(() => {});
      if (onReady) onReady(me);
      // launch() у Telegraf 4.16 завершується лише після зупинки бота.
      bot.launch({ allowedUpdates: ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member', 'chat_member'] }, () => console.log('✅ Long polling активний'))
        .then(() => { launching = false; })
        .catch((e) => {
          launching = false;
          console.error('❌ Polling зупинився:', e.message, '— перезапуск через 30 с');
          setTimeout(() => attempt(n + 1), 30000);
        });
    } catch (e) {
      launching = false;
      const wait = Math.min(120000, 30000 * (n + 1));
      console.error('❌ Не вдалось запустити бота:', e.message, `— повтор через ${Math.round(wait / 1000)} с`);
      setTimeout(() => attempt(n + 1), wait);
    }
  }
  attempt(0);
}

module.exports = { createBot, launch, setupUi };
