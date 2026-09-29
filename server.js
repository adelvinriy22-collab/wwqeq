require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const db = require('./db');
const { EMOJI, TEXTS, STATE_ICON, tierName, fmtStars } = require('./i18n');
const CFG = require('./config');
const pass = require('./pass');
const bank = require('./bank');
const league = require('./league');
// Ліга тимчасово вимкнена. Код лишається — щоб повернути, постав true.
const LEAGUE_ENABLED = false;
const chatMod = require('./chat');
const media = require('./assets');

const { BOT_TOKEN, ADMIN_CHAT_ID } = process.env;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не заданий. Заповни .env (дивись .env.example)');
  process.exit(1);
}

const BOOT_AT = Date.now();
const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 10 * 60 * 1000,
  // Власний сервер Bot API (або тестовий) — через змінну оточення.
  ...(process.env.TELEGRAM_API_ROOT ? { telegram: { apiRoot: process.env.TELEGRAM_API_ROOT } } : {}),
});

// Ліміти Telegram. На 429 («Too Many Requests») Telegram каже, скільки
// почекати. Раніше таке повідомлення просто губилось — особливо в розсилках
// і в години пік у чаті. Тепер кожен виклик API чекає й повторює (до двох разів).
{
  const callApi = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = async function (method, payload, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callApi(method, payload, opts);
      } catch (e) {
        const retry = e && ((e.parameters && e.parameters.retry_after) ||
          (e.response && e.response.parameters && e.response.parameters.retry_after));
        if (e && e.code === 429 && retry && retry <= 30 && attempt < 2) {
          await new Promise(r => setTimeout(r, (retry + 0.5) * 1000));
          continue;
        }
        throw e;
      }
    }
  };
}

// Екранування для parse_mode: 'HTML'. Імена людей ідуть у повідомлення як є,
// і ім'я на кшталт «<b>» або «a & b» ламало розмітку — Telegram відхиляв
// усе повідомлення (оголошення в чаті просто не з'являлось).
function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
// Як людину назвати в тексті: @username (він завжди безпечний) або ім'я.
function whoOf(u, fallback) {
  if (u && u.username) return '@' + u.username;
  return esc((u && u.name) || fallback || 'гравець');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Запис історії спінів → підпис. Білетні виграші (tix) раніше показувались
// як «+0⭐», а ризик ×2 — як звичайні зірки.
function isTixId(id) { return String(id || '').indexOf('tix') === 0; }
function historyName(h) {
  if (h.id === 'risk_win') return '×' + (h.mult || 2) + ' — виграв ' + h.am + '⭐';
  if (h.id === 'risk_lose') return 'ризик ×2 — втратив ' + h.am + '⭐';
  if (h.sp) return CFG.getTier(h.id).name;
  if (h.tk || isTixId(h.id)) return '+' + (h.tk || parseInt(String(h.id).slice(3), 10) || 0) + ' 🎫';
  return '+' + (h.am || 0) + '⭐';
}
function historyIcon(h) {
  if (h.sp) return '🎁';
  if (h.id === 'risk_win') return '📈';
  if (h.id === 'risk_lose') return '📉';
  if (h.tk || isTixId(h.id)) return '🎫';
  return '⭐';
}

// Надійна відправка для розсилок. Telegram при перевищенні ліміту відповідає
// 429 з retry_after — раніше таке повідомлення просто губилось. Тепер чекаємо
// і пробуємо ще раз; заблокованих (403) позначаємо, щоб більше не турбувати.
async function safeSend(chatId, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fn();
      return 'ok';
    } catch (e) {
      const code = e && (e.code || (e.response && e.response.error_code));
      const retry = e && e.parameters && e.parameters.retry_after
        || (e && e.response && e.response.parameters && e.response.parameters.retry_after);
      if (code === 429 && retry && attempt < 2) { await sleep((retry + 1) * 1000); continue; }
      const m = String((e && e.message) || '');
      if (code === 403 || m.includes('blocked') || m.includes('deactivated') || m.includes('chat not found')) {
        const u = db.getUser(String(chatId));
        if (u && !u.remindersOff) db.upsertUser(String(chatId), { remindersOff: true });
        return 'blocked';
      }
      return 'failed';
    }
  }
  return 'failed';
}

// Telegraf бере нову пачку оновлень, лише коли ПОВНІСТЮ обробив попередню.
// Гра в чаті чекає анімацію кубика 3–4 с, дуель — довше, розсилка — хвилини.
// Увесь цей час нові повідомлення стояли в черзі, а потім приходили разом —
// і захист «раз на 5 с» відкидав майже всі. Тож лічба в чаті «застрягала».
// Тепер кожне оновлення обробляється окремо, і черга не блокується.
{
  const handleOriginal = bot.handleUpdate.bind(bot);
  bot.handleUpdate = function (update, webhookResponse) {
    if (webhookResponse) return handleOriginal(update, webhookResponse);
    handleOriginal(update).catch((e) => console.error('update failed:', e && e.message));
    return Promise.resolve();
  };
}
let BOT_USERNAME = null;

// Глобальна страховка. РАНІШЕ будь-яка дрібна помилка (наприклад, збій одного
// запиту до Telegram) вбивала ВЕСЬ процес — і застосунок лягав із
// "Application failed to respond". Тепер логуємо й працюємо далі; падаємо
// тільки на справді фатальних помилках, після яких процес усе одно нежиттєздатний.
const FATAL_PATTERNS = ['EADDRINUSE', 'ERR_MODULE_NOT_FOUND', 'Cannot find module'];

function isFatal(err) {
  const msg = String((err && (err.message || err.code)) || err || '');
  return FATAL_PATTERNS.some(p => msg.includes(p));
}

process.on('unhandledRejection', (err) => {
  console.error('⚠️ unhandledRejection:', err && err.message ? err.message : err);
  if (isFatal(err)) process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ uncaughtException:', err && err.message ? err.message : err);
  if (isFatal(err)) process.exit(1);
});

// ТУТ БУВ БАГ, ЩО КЛАВ ПЛАТЕЖІ Й КНОПКИ.
// Читали ctx.chat.id, а в апдейті pre_checkout_query чату НЕМАЄ взагалі —
// Telegram його не передає. Оскільки isAdmin викликається в першому
// глобальному middleware, кожен платіж падав із
// "Cannot read properties of undefined (reading 'id')" ще до нарахування,
// а бот ішов у нескінченний перезапуск. Те саме з callback_query,
// коли повідомлення з кнопкою вже недоступне.
function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return false;
  const chatId = (ctx && ctx.chat && ctx.chat.id) || (ctx && ctx.from && ctx.from.id) || null;
  return chatId !== null && String(chatId) === String(ADMIN_CHAT_ID);
}
function isAdminUid(uid) {
  return ADMIN_CHAT_ID && String(uid) === String(ADMIN_CHAT_ID);
}

// ---------------------------------------------------------------------------
// Middleware: оновлюємо username/ім'я при кожній дії
// ---------------------------------------------------------------------------
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const uid = String(ctx.from.id);
    const existing = db.getUser(uid);
    if (existing) {
      const newName = ctx.from.first_name || existing.name || '';
      // Пишемо лише якщо щось змінилось: кожен upsert — це запис бази на диск.
      if (existing.username !== (ctx.from.username || null) || existing.name !== newName || existing.id !== uid) {
        db.upsertUser(uid, { id: uid, username: ctx.from.username || null, name: newName });
      }

      // Автоперевірка: чи є StarForgeX_bot в імені юзера — +2/-2 квитки автоматично,
      // без ручного підтвердження (бот сам бачить ім'я при кожній дії).
      // ВАЖЛИВО: перевіряємо і "Ім'я", і "Прізвище" разом — Telegram часто ділить
      // текст, який людина ввела в одне поле, на first_name + last_name.
      // ВАЖЛИВО 2: перевіряємо БЕЗ вимоги символу "@" — багато людей пишуть тег
      // без "@", і колишня перевірка це пропускала.
      if (BOT_USERNAME) {
        const fullName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim().toLowerCase();
        const hasTagNow = fullName.includes(BOT_USERNAME.toLowerCase());
        const hadTagBefore = !!existing.hasNameTag;

        if (hasTagNow && !hadTagBefore) {
          db.upsertUser(uid, { hasNameTag: true });
          const changed = adjustTicketsInActiveGiveaways(uid, 2);
          if (changed) {
            bot.telegram.sendMessage(uid, `✅ Помітив @${BOT_USERNAME} у твоєму імені — +2 квитки нараховано автоматично!`).catch(() => {});
          }
        } else if (!hasTagNow && hadTagBefore) {
          db.upsertUser(uid, { hasNameTag: false });
          const changed = adjustTicketsInActiveGiveaways(uid, -2);
          if (changed) {
            bot.telegram.sendMessage(uid, `⚠️ Помітив, що ти прибрав @${BOT_USERNAME} з імені — -2 квитки. Поверни тег назад, щоб знову отримати бонус.`).catch(() => {});
          }
        }
      }
    }
  }
  return next();
});

// Додає/забирає N квитків у ВСІХ активних розіграшах, де юзер вже бере участь.
// Повертає true, якщо хоч десь щось змінилось (щоб не слати повідомлення даремно).
function adjustTicketsInActiveGiveaways(uid, delta) {
  let changed = false;
  const giveaways = db.listGiveaways();
  for (const gid of Object.keys(giveaways)) {
    const g = giveaways[gid];
    if (!g.active || Date.now() >= g.endsAt) continue;
    const p = g.participants && g.participants[uid];
    if (p) {
      p.tickets = Math.max(0, (p.tickets !== undefined ? p.tickets : 1) + delta);
      db.setGiveaway(gid, g);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Middleware: обов'язкова підписка на канал (для всіх, крім адмін-чату)
// ---------------------------------------------------------------------------
// Кеш перевірки підписки. Раніше КОЖЕН спін бив у Telegram API; при частих
// спінах API починав різати запити, помилка читалась як "не підписаний" —
// звідси і "колесо не крутиться", і "просить підписатись, хоч я підписаний".
const subCache = new Map(); // uid -> { ok, at }
function invalidateSubCache(uid) {
  for (const key of subCache.keys()) if (key.endsWith(':' + uid)) subCache.delete(key);
}
const SUB_CACHE_MS = 10 * 60 * 1000;

async function checkChannelSubscription(channelUsername, uid) {
  const key = channelUsername + ':' + uid;
  const hit = subCache.get(key);
  if (hit && Date.now() - hit.at < SUB_CACHE_MS) return hit.ok;

  try {
    const member = await bot.telegram.getChatMember(channelUsername, uid);
    const ok = ['creator', 'administrator', 'member'].includes(member.status);
    // Позитивний результат тримаємо 10 хв, негативний — лише 20с: людина
    // може підписатись будь-якої миті, і не має чекати кінця кешу.
    subCache.set(key, { ok, at: ok ? Date.now() : Date.now() - (SUB_CACHE_MS - 20000) });
    return ok;
  } catch (e) {
    console.error('checkSubscription failed for', channelUsername, uid, ':', e.message);
    // Якщо раніше вже підтверджували підписку — довіряємо старому результату,
    // а не блокуємо людину через тимчасовий збій API.
    if (hit) return hit.ok;
    return null;
  }
}
async function checkSubscriptionLive(uid) {
  return checkChannelSubscription(CFG.CHANNEL_USERNAME, uid);
}

// Глобальний перехоплювач: будь-яка помилка в обробнику лишається в логах,
// але не валить polling. Раніше одна така помилка зупиняла бота повністю.
bot.catch((err, ctx) => {
  console.error('❌ Помилка в обробнику', ctx && ctx.updateType, '-', err && err.message);
});

// Гейт техробіт для самого бота. Коли увімкнено режим full, звичайний
// користувач отримує одне коротке повідомлення замість будь-якої дії.
// Жодних розсилок: людина дізнається про роботи тоді, коли сама прийшла.
const MAINT_SUPPORT = '@sherik17';
const maintNotifiedAt = new Map();

bot.use(async (ctx, next) => {
  const m = maintState();
  if (m.mode !== 'full') return next();
  if (isAdmin(ctx)) return next();
  if (ctx.updateType === 'pre_checkout_query') return next();  // оплату не рвемо
  if (ctx.updateType === 'message' && ctx.message && ctx.message.successful_payment) return next();

  const uid = ctx.from ? String(ctx.from.id) : '';
  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery('Технічні роботи').catch(() => {});
  }

  // Не спамимо тому, хто тикає кнопки: одне повідомлення на 5 хвилин.
  const last = maintNotifiedAt.get(uid) || 0;
  if (Date.now() - last > 300000) {
    maintNotifiedAt.set(uid, Date.now());
    await ctx.reply(
      `🛠 <b>Технічні роботи</b>\n\n${m.text}\n\n` +
      (m.left ? `Орієнтовно лишилось: <b>${humanLeft(m.left)}</b>\n` : '') +
      `Баланс і прогрес у безпеці — нічого не втрачається.\n` +
      `Підтримка: ${MAINT_SUPPORT}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
  return; // далі не пускаємо
});

// Трекінг активності — БУДЬ-яка дія юзера (команда, кнопка, текст) оновлює
// час останньої активності. Заодно фіксуємо наявність Telegram Premium:
// Telegram віддає цей прапорець у кожному апдейті, окремо питати не треба.
bot.use(async (ctx, next) => {
  if (ctx.from && !isAdmin(ctx)) {
    const uid = String(ctx.from.id);
    // Записуємо навіть якщо юзера ще нема в базі — тоді прапорець не губиться
    // на першому ж контакті. Раніше isPremium зʼявлявся тільки в тих, хто вже
    // існував у базі І зайшов ПІСЛЯ деплою — тому лічильник показував 0.
    const existing = db.getUser(uid);
    if (existing) {
      db.upsertUser(uid, { lastActiveAt: Date.now(), isPremium: !!ctx.from.is_premium });
    } else if (ctx.from.is_premium) {
      db.upsertUser(uid, { lastActiveAt: Date.now(), isPremium: true });
    }
  }
  return next();
});

// 💬 Чат @starforge_chat. Маршрут стоїть РАНІШЕ за всю приватну логіку:
// повідомлення з групи обробляються тут і далі не йдуть, інакше потрапили б,
// наприклад, у стан «введи промокод» людини в особистих.
const chat = chatMod.createChat({
  bot, db, league,
  leagueXp: (...a) => leagueXp(...a),
  leagueUsers: () => leagueUsers(),
  leagueName: (u, id) => leagueName(u, id),
  ticketsOf: (u) => ticketsOf(u),
  addTickets: (uid, n, why) => addTickets(uid, n, why, { silent: true }),   // у чаті результат і так видно всім
  isAdminUid: (id) => isAdminUid(id),
  getBotUsername: () => BOT_USERNAME,
  chatRef: process.env.CHAT_USERNAME || '@starforge_chat',
  EMOJI,
  notifyAdmin: (text) => { if (ADMIN_CHAT_ID) bot.telegram.sendMessage(ADMIN_CHAT_ID, text).catch(() => {}); },
});
bot.use(chat.middleware());

// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ ДЖЕКПОТ ВІД АДМІНА ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// Адмін у приваті вставляє посилання на повідомлення з чату (можна з @username)
// → бот показує автора й кнопки призу → оголошує «ДЖЕКПОТ!» у чаті й видає приз.
// Від дорогих до безкоштовних: очки рівня нічого не коштують, а людям цінні.
const JP_PRIZES = {
  bear: { label: '🧸 Мішку', kind: 'tier', id: 'bear' },
  gift: { label: '🎁 Подарунок', kind: 'tier', id: 'gift' },
  s5:   { label: '5 ⭐', kind: 'stars', n: 5 },
  t20:  { label: '20 🎫', kind: 'tickets', n: 20 },
  p100: { label: '👑 +100 очок рівня', kind: 'points', n: 100 },
};
const jpPending = new Map();   // msgId -> uid, коли автора вказано вручну

function jpParseLink(text) {
  const m = String(text || '').match(/t\.me\/(?:c\/\d+|[A-Za-z0-9_]+)\/(?:\d+\/)?(\d+)/);
  return m ? Number(m[1]) : null;
}
function jpFindUser(uname) {
  const w = String(uname || '').replace('@', '').toLowerCase();
  if (!w) return null;
  for (const [id, u] of Object.entries(db.allUsers())) if (u && u.username && u.username.toLowerCase() === w) return id;
  return null;
}

bot.use(async (ctx, next) => {
  if (!ctx.chat || ctx.chat.type !== 'private' || !isAdmin(ctx) || !ctx.message || !ctx.message.text) return next();
  const text = ctx.message.text.trim();
  const isCmd = /^\/jackpot\b/i.test(text);
  // Лише посилання саме на повідомлення (з номером у кінці) — інакше пости для розсилки з t.me-посиланнями перехоплювались би.
  if (!isCmd && (text.startsWith('/') || !jpParseLink(text))) return next();

  const msgId = jpParseLink(text);
  if (!msgId) return ctx.reply('Формат: встав посилання на повідомлення з чату\nнаприклад https://t.me/starforge_chat/12345\n\nМожна додати @username, якщо бот не знає автора.');
  const unameMatch = text.match(/@([A-Za-z0-9_]{4,})/);
  let who = chat.authorOf(msgId);
  if (unameMatch) {
    const id = jpFindUser(unameMatch[1]);
    if (!id) return ctx.reply('Не знайшов @' + unameMatch[1] + ' серед гравців бота.');
    const u = db.getUser(id) || {};
    who = { uid: id, name: '@' + u.username, plain: '@' + u.username };
    jpPending.set(msgId, id);
  }
  if (!who) {
    return ctx.reply('🤔 Не знаю, хто автор цього повідомлення — бот бачить лише свіжі повідомлення.\n\n' +
      'Надішли те саме посилання й через пробіл @username автора.');
  }
  if (isAdminUid(who.uid)) return ctx.reply('Це твоє повідомлення 🙂');
  const inBot = !!(db.getUser(who.uid) || {}).lang;
  return ctx.reply('🎰 Джекпот для ' + who.plain + (inBot ? '' : '\n⚠️ Ця людина ще не запускала бота — приз прийде, коли зайде') +
    '\n\nЯкий приз?', Markup.inlineKeyboard([
      [callbackBtn('👑 +100 очок (безкоштовно)', 'jp_' + msgId + '_p100', 'success')],
      [callbackBtn('20 🎫 (≈4⭐)', 'jp_' + msgId + '_t20', 'primary'), callbackBtn('5 ⭐', 'jp_' + msgId + '_s5', 'primary')],
      [callbackBtn('🧸 Мішка (15⭐)', 'jp_' + msgId + '_bear'), callbackBtn('🎁 Подарунок (25⭐)', 'jp_' + msgId + '_gift')],
    ]));
});

bot.action(/^jp_(\d+)_(bear|gift|s5|t20|p100)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const msgId = Number(ctx.match[1]);
  const prize = JP_PRIZES[ctx.match[2]];
  const known = chat.authorOf(msgId);
  const uid = jpPending.get(msgId) || (known && known.uid);
  if (!uid) return ctx.reply('Автора вже не знаю — надішли посилання ще раз із @username.');
  const u = db.getUser(uid) || {};
  const name = u.username ? '@' + u.username : (known ? known.name : 'гравець');

  // Приз видається СПРАВЖНІЙ — інакше публічний «джекпот» обернеться хейтом.
  let note = '';
  if (prize.kind === 'tier') {
    const a = db.addApplication({ uid, tierId: prize.id, status: 'pending', createdAt: Date.now(), source: 'chat_jackpot' });
    note = 'заявка #' + a.id;
  } else if (prize.kind === 'stars') {
    db.upsertUser(uid, { starBalance: Math.round(((u.starBalance || 0) + prize.n) * 100) / 100 });
    note = 'нараховано на баланс';
  } else if (prize.kind === 'points') {
    chat.addChatPts(uid, prize.n);
    note = 'очки нараховано';
  } else {
    addTickets(uid, prize.n, 'джекпот у чаті');
    note = 'нараховано';
  }
  const ok = await chat.jackpot(msgId, { name }, prize.label);
  bot.telegram.sendMessage(uid, '🎰 <b>ДЖЕКПОТ!</b>\n\nТи виграв <b>' + prize.label + '</b> за активність у чаті!' +
    (prize.kind === 'tier' ? '\nЗаявку створено — видамо найближчим часом.' : prize.kind === 'points' ? '\nОчки вже зараховано до твого рівня.' : '\nУже на балансі.') +
    '\n\nСпілкуйся далі — бот стежить за найактивнішими 🔥', { parse_mode: 'HTML' }).catch(() => {});
  jpPending.delete(msgId);
  await ctx.editMessageText('✅ Джекпот ' + name + ': ' + prize.label + ' (' + note + ')' + (ok ? '\nОголошено в чаті 🎉' : '\n⚠️ У чат написати не вдалось — перевір /chat_status'));
});
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ ДЖЕКПОТ ВІД АДМІНА ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲


// Раз на скільки перевіряємо підписку наново. Раніше прапорець subscribed
// ставився назавжди — тому той, хто відписався, гачка більше не бачив
// і спокійно користувався ботом далі.
const SUB_RECHECK_MS = 6 * 60 * 60 * 1000;

async function requireSubscribed(ctx, uid) {
  const u = db.getUser(uid);
  const checkedAt = (u && u.subCheckedAt) || 0;
  const fresh = Date.now() - checkedAt < SUB_RECHECK_MS;

  if (u && u.subscribed && fresh) { attributeReferralIfPending(uid); return true; }

  const live = await checkSubscriptionLive(uid);
  if (live === true) {
    db.upsertUser(uid, { subscribed: true, subCheckedAt: Date.now() });
    attributeReferralIfPending(uid);
    return true;
  }
  if (live === false) {
    db.upsertUser(uid, { subscribed: false, subCheckedAt: Date.now() });
  } else if (u && u.subscribed) {
    // API не відповів — не викидаємо людину через тимчасовий збій.
    attributeReferralIfPending(uid);
    return true;
  }

  await sendSubscribeRequired(ctx, uid);
  return false;
}

async function sendSubscribeRequired(ctx, uid) {
  const T = t(uid);
  const { text, entities } = buildText(T.subscribeRequired());

  // Партнерський канал показуємо ТУТ САМО — людина і так у режимі підписки,
  // тож другий канал коштує їй одного зайвого тапу. Це найдешевший трафік.
  const rows = [
    [urlBtn(T.btnSubscribe, CFG.CHANNEL_URL, 'primary', 'megaphone')],
    [callbackBtn(T.btnCheckSub, 'check_sub', 'success', 'check')],
  ];
  await bot.telegram.sendMessage(uid, text, { entities, ...Markup.inlineKeyboard(rows) }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Хелпер: text + entities (преміум-емодзі + форматування одночасно)
// ---------------------------------------------------------------------------
const STYLE_TYPES = { b: 'bold', i: 'italic', u: 'underline', code: 'code' };
function buildText(parts) {
  let text = '';
  const entities = [];
  function walk(items) {
    for (const part of items) {
      if (Array.isArray(part)) { walk(part); continue; }
      if (typeof part === 'string' && EMOJI[part]) {
        const e = EMOJI[part];
        const offset = text.length;
        text += e.fallback;
        if (e.id) entities.push({ type: 'custom_emoji', offset, length: e.fallback.length, custom_emoji_id: e.id });
      } else if (typeof part === 'string') {
        text += part;
      } else if (part) {
        const styleKey = Object.keys(STYLE_TYPES).find(k => part[k] !== undefined);
        if (styleKey) {
          const offset = text.length;
          text += part[styleKey];
          entities.push({ type: STYLE_TYPES[styleKey], offset, length: part[styleKey].length });
        }
      }
    }
  }
  walk(parts);
  return { text, entities };
}

function getLang(uid) { const u = db.getUser(uid); return (u && u.lang) || null; }
function t(uid) { return TEXTS[getLang(uid) || 'uk']; }
function referralCount(uid) { const u = db.getUser(uid); return (u && u.invitedIds) ? u.invitedIds.length : 0; }

// Показуємо реальне ім'я користувача завжди, як є (навіть "." чи щось коротке —
// це може бути свідомий вибір людини). Підміна лише коли ім'я справді порожнє.
function displayName(u) {
  if (u && u.anonymousInLeaderboard) return 'Гравець #' + String(u.id).slice(-4);
  const name = (u && u.name || '').trim();
  if (name.length > 0) return name;
  if (u && u.username) return '@' + u.username;
  return 'Гравець #' + String(u ? u.id : '').slice(-4);
}

// ---------------------------------------------------------------------------
// Кольорові кнопки (Bot API 9.4, лютий 2026): style = 'danger'|'success'|'primary'.
// Telegraf officially may not expose цю опцію в хелперах, тому будуємо об'єкт
// кнопки вручну — Telegram API прийме будь-які додаткові поля.
// ---------------------------------------------------------------------------
function callbackBtn(text, data, style, emojiKey) {
  const btn = { text, callback_data: data };
  if (style) btn.style = style; // 'danger' | 'success' | 'primary'
  if (emojiKey && EMOJI[emojiKey] && EMOJI[emojiKey].id) btn.icon_custom_emoji_id = EMOJI[emojiKey].id;
  return btn;
}
function urlBtn(text, url, style, emojiKey) {
  const btn = { text, url };
  if (style) btn.style = style;
  if (emojiKey && EMOJI[emojiKey] && EMOJI[emojiKey].id) btn.icon_custom_emoji_id = EMOJI[emojiKey].id;
  return btn;
}

// Меню-кнопка (персистентна клавіатура знизу екрана, а не інлайн) для "Назад".
// KeyboardButton теж підтримує icon_custom_emoji_id з Bot API 9.4.
const backBtnObj = { text: 'Назад' };
if (EMOJI.back && EMOJI.back.id) backBtnObj.icon_custom_emoji_id = EMOJI.back.id;
const backReplyKeyboard = { reply_markup: { keyboard: [[backBtnObj]], resize_keyboard: true } };

// Клавіатуру треба прикріпити до якогось повідомлення (Telegram не дозволяє
// порожній текст) — якщо підказку вимкнено, шлемо мінімальний пробіл замість тексту.
async function sendBackKeyboard(uid) {
  const T = t(uid);
  const u = db.getUser(uid);
  const showHint = u ? u.showBackHint !== false : true; // за замовчуванням увімкнено
  try {
    await bot.telegram.sendMessage(uid, showHint ? T.backHint : '·', backReplyKeyboard);
  } catch (e) {
    console.error('sendBackKeyboard failed:', e.message);
  }
}

bot.hears('Назад', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!(await requireSubscribed(ctx, uid))) return;
  awaitingPromoCode.delete(uid); // на випадок, якщо юзер вийшов старою клавіатурою, а не інлайн-кнопкою
  await ctx.reply('⌨️', Markup.removeKeyboard()); // прибираємо клавіатуру Назад
  await showMainMenu(ctx, uid);
});

// ---------------------------------------------------------------------------
// Екран: вибір мови
// ---------------------------------------------------------------------------
async function showLanguageSelect(ctx) {
  const { text, entities } = buildText([
    'flagUk', ' Українська\n', 'flagEn', ' English\n', 'flagRu', ' Русский\n\n',
    { b: 'Обери мову / Choose language / Выбери язык' },
  ]);
  await ctx.reply(text, {
    entities,
    ...Markup.inlineKeyboard([
      [callbackBtn('Українська', 'lang_uk', 'primary', 'flagUk')],
      [callbackBtn('English', 'lang_en', 'primary', 'flagEn')],
      [callbackBtn('Русский', 'lang_ru', 'primary', 'flagRu')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Екран: головне меню
// ---------------------------------------------------------------------------
async function showMainMenu(ctx, uid) {
  const T = t(uid);
  const u = db.getUser(uid);
  const balance = (u && u.starBalance) || 0;
  const { text: greetText, entities: greetEntities } = buildText(T.greeting());
  const tix = ticketsOf(u);
  const { text: balanceText, entities: balanceEntities } = buildText(['starIcon', ' ', { b: `БАЛАНС: ${fmtStars(balance)} ` }, 'starIcon', tix ? `   🎫 ${tix}` : '']);
  const text = greetText + '\n\n' + balanceText;
  const entities = [...greetEntities, ...balanceEntities.map(e => ({ ...e, offset: e.offset + greetText.length + 2 }))];

  const rows = [];
  // Головна дія — застосунок із колесами. Раніше в меню його не було взагалі:
  // людина мусила знайти кнопку меню біля поля вводу.
  if (WEBAPP_URL) rows.push([{ text: '🎰 ВІДКРИТИ КОЛЕСА', web_app: { url: WEBAPP_URL }, style: 'success' }]);
  rows.push([callbackBtn(T.btnRewards, 'rewards', 'primary', 'giftBox')]);

  rows.push([callbackBtn('🎲 ІГРИ (кубик, дартс, футбол, слоти)', 'dice_menu', 'danger', 'starIcon')]);
  {
    const bk = (db.getFeatureFlags() || {}).bank;
    if (bk && bk.status === 'open') {
      rows.push([callbackBtn(`🏦 СПІЛЬНИЙ БАНК — ${fmtStars(bk.stars != null ? bk.stars : bk.pot)}⭐`, 'bank_show', 'danger', 'starIcon')]);
    }
  }
  rows.push([callbackBtn('⭐ ПОПОВНИТИ БАЛАНС', 'topup_menu', 'success', 'starIcon')]);
  rows.push([callbackBtn('👤 МІЙ ПРОФІЛЬ', 'my_profile', 'primary', 'starIcon')]);
  rows.push([callbackBtn('ПРОМОКОД', 'promo_code_start', 'success', 'promoCode')]);
  rows.push([callbackBtn(T.btnWithdrawStars(balance), 'withdraw_stars', balance >= CFG.STAR_WITHDRAW_MIN ? 'success' : undefined, 'starIcon')]);

  const flags = db.getFeatureFlags();
  if (flags.eventUnlocked) rows.push([callbackBtn(T.btnEvent, 'event_status', 'success', 'trophy')]);

  // Показуємо кнопку для БУДЬ-якого активного розіграшу (не лише "подарунок") —
  // якщо їх кілька одночасно активні, показуємо всі.
  const giveaways = db.listGiveaways();
  for (const gid of Object.keys(giveaways)) {
    const g = giveaways[gid];
    if (g && g.active && Date.now() < g.endsAt) {
      const tier = CFG.getTier(g.tierId);
      const label = (g.winnersCount && g.winnersCount > 1) ? `РОЗІГРАШ (${g.winnersCount}x ${tierName(g.tierId, getLang(uid)).toUpperCase()})` : T.btnGiveawayMenu;
      rows.push([callbackBtn(label, 'ga_join_' + gid, 'danger', tier.emojiKey)]);
    }
  }

  const extPool = db.getExternalRefPool();
  if (extPool && extPool.active) {
    rows.push([callbackBtn(`ШАНС НА МІШКУ (мішок: ${extPool.wonCount || 0}/${extPool.winnersCount})`, 'ext_ref_join', 'danger', 'teddyBear')]);
  }

  rows.push([callbackBtn(T.btnSettings, 'settings', 'primary', 'settingsIcon')]);

  await ctx.reply(text, { entities, ...Markup.inlineKeyboard(rows) });
}

async function showSettings(ctx, uid) {
  const T = t(uid);
  const u = db.getUser(uid);
  const notifyOn = u ? u.notifyOnReferral !== false : true;
  const hintOn = u ? u.showBackHint !== false : true;
  const anonOn = u ? !!u.anonymousInLeaderboard : false; // за замовчуванням вимкнено (показуємо реальне ім'я)

  const { text, entities } = buildText(['settingsIcon', ' ', { b: T.settingsTitle }, '\n\n', { i: T.settingsNotifyHint }]);
  await ctx.reply(text, {
    entities,
    ...Markup.inlineKeyboard([
      [callbackBtn(T.btnChangeLang, 'change_language', 'primary', 'flagUk')],
      [callbackBtn(anonOn ? T.btnAnonOn : T.btnAnonOff, 'toggle_anon', anonOn ? 'success' : 'danger', anonOn ? 'greenCircle' : 'redCircle')],
      [callbackBtn(T.btnMyApplications, 'my_applications', 'primary', 'applicationsIcon')],
      [callbackBtn(notifyOn ? T.btnNotifyOn : T.btnNotifyOff, 'toggle_ref_notify', notifyOn ? 'success' : 'danger', notifyOn ? 'greenCircle' : 'redCircle')],
      [callbackBtn(hintOn ? T.btnHintOn : T.btnHintOff, 'toggle_back_hint', hintOn ? 'success' : 'danger', hintOn ? 'greenCircle' : 'redCircle')],
    ]),
  });
  await sendBackKeyboard(uid);
}

bot.action('change_language', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showLanguageSelect(ctx);
});

bot.action('toggle_anon', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  const u = db.getUser(uid);
  db.upsertUser(uid, { anonymousInLeaderboard: !(u && u.anonymousInLeaderboard) });
  await showSettings(ctx, uid);
});

async function showMyApplications(ctx, uid, filter) {
  const T = t(uid);
  filter = filter || 'pending';
  const mine = db.listApplications(filter).filter(a => a.uid === uid);

  const counts = {
    pending: db.listApplications('pending').filter(a => a.uid === uid).length,
    approved: db.listApplications('approved').filter(a => a.uid === uid).length,
    rejected: db.listApplications('rejected').filter(a => a.uid === uid).length,
  };

  const statusIcon = { pending: 'pendingIcon', approved: 'check', rejected: 'redCircle' };
  const statusLabel = { pending: T.filterPending, approved: T.filterApproved, rejected: T.filterRejected };

  let parts = ['applicationsIcon', ' ', { b: T.myApplicationsTitle }, '\n\n'];
  if (!mine.length) {
    parts.push({ i: T.noApplicationsForFilter });
  } else {
    mine.forEach(a => {
      const tier = CFG.getTier(a.tierId);
      const date = new Date(a.createdAt).toLocaleDateString(getLang(uid) === 'en' ? 'en-GB' : getLang(uid) === 'ru' ? 'ru-RU' : 'uk-UA');
      parts.push(tier.emojiKey, ' ', { b: tierName(a.tierId, getLang(uid)) }, ` · #${a.id} · ${date}\n`);
    });
  }

  const { text, entities } = buildText(parts);
  await ctx.reply(text, {
    entities,
    ...Markup.inlineKeyboard([
      [
        callbackBtn(`${T.filterPending} (${counts.pending})`, 'myapp_pending', filter === 'pending' ? 'primary' : undefined, 'pendingIcon'),
        callbackBtn(`${T.filterApproved} (${counts.approved})`, 'myapp_approved', filter === 'approved' ? 'primary' : undefined, 'check'),
      ],
      [callbackBtn(`${T.filterRejected} (${counts.rejected})`, 'myapp_rejected', filter === 'rejected' ? 'primary' : undefined, 'redCircle')],
    ]),
  });
  await sendBackKeyboard(uid);
}

bot.action('my_applications', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showMyApplications(ctx, uid, 'pending');
});

bot.action(/^myapp_(pending|approved|rejected)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showMyApplications(ctx, uid, ctx.match[1]);
});

bot.action('toggle_back_hint', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  const u = db.getUser(uid);
  const currentlyOn = u ? u.showBackHint !== false : true;
  db.upsertUser(uid, { showBackHint: !currentlyOn });
  await showSettings(ctx, uid);
});

// ---------------------------------------------------------------------------
// ВИВІД ЗІРОК. Вводиться сума ДО ВИДАЧІ, комісія додається зверху.
// Єдина межа — WITHDRAW_MIN_ANY (15⭐), далі будь-яке ціле число.
// Умова доступу: STAR_WITHDRAW_MIN_REFERRALS запрошених друзів за весь час.
const STAR_WITHDRAW_MIN_REFERRALS = 3;
const WITHDRAW_MIN_ANY = 15;
const APP_WITHDRAW_MIN = WITHDRAW_MIN_ANY;
const WITHDRAW_FEE_PERCENT = 5;
const APP_WITHDRAW_FEE_PERCENT = WITHDRAW_FEE_PERCENT;

// ==========================================================================
// БОНУС ЗА ПОПОВНЕННЯ: +10% на перші три поповнення.
// ==========================================================================
const DEPOSIT_BONUS_PERCENT = 10;   // +10% до суми
const DEPOSIT_BONUS_TIMES = 3;      // на перші 3 поповнення
// Telegram не приймає рахунки на довільно великі суми зірок — зайвий
// рахунок просто не створюється. Стелю можна змінити змінною оточення.
const TOPUP_MAX = Math.max(1, parseInt(process.env.TOPUP_MAX, 10) || 10000);

function withdrawCost(payout) {
  const cost = Math.ceil(payout * (1 + WITHDRAW_FEE_PERCENT / 100));
  return { payout, cost, fee: cost - payout };
}

function isAllowedPayout(payout) {
  return Number.isInteger(payout) && payout >= WITHDRAW_MIN_ANY;
}

// Єдина функція виплати для БОТА і ЗАСТОСУНКУ — щоб умови не розʼїжджались.
// Повертає { app } або { error, ... } з конкретною причиною відмови —
// раніше будь-яка відмова в застосунку показувалась як «встанови юзернейм».
// Викликати лише під balanceLocks: баланс читаємо тут, свіжий.
async function createStarPayout(uid, w) {
  const u = db.getUser(uid) || {};
  const refs = (u.invitedIds || []).length;
  if (!isAdminUid(uid) && refs < STAR_WITHDRAW_MIN_REFERRALS) {
    return { error: 'need_referrals', need: STAR_WITHDRAW_MIN_REFERRALS, have: refs };
  }
  if (!u.username) return { error: 'need_username' };
  const balance = u.starBalance || 0;
  if (balance < w.cost) return { error: 'not_enough', balance, cost: w.cost, payout: w.payout };

  db.upsertUser(uid, { starBalance: balance - w.cost });
  const app_ = db.addApplication({
    uid, tierId: 'stars_payout', status: 'pending', createdAt: Date.now(),
    source: 'app_withdrawal', payoutStars: w.payout, spentStars: w.cost, fee: w.fee,
  });

  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `💸 ВИВІД ЗІРОК! Заявка #${app_.id}\nНАДІСЛАТИ: ${w.payout}⭐\nСписано з балансу: ${w.cost}⭐ (комісія ${w.fee}⭐)\n${u.name || '—'} · @${u.username} · id ${uid}`,
      Markup.inlineKeyboard([[
        callbackBtn('Підтвердити', `admin_approve_${app_.id}`, 'success', 'check'),
        callbackBtn('Відхилити', `admin_reject_${app_.id}`, 'danger', 'redCircle'),
      ]])
    ).catch(() => {});
  }

  bot.telegram.sendMessage(
    uid,
    `✅ Заявка #${app_.id} створена.\nДо видачі: ${w.payout}⭐\nСписано: ${w.cost}⭐ (комісія ${w.fee}⭐)\n\nОбробимо найближчим часом.`
  ).catch(() => {});

  return { app: app_, balance: Math.round((balance - w.cost) * 100) / 100 };
}

// Вивід — ОДИН шлях, у застосунку. Кнопки бота ведуть у гаманець, тож
// техроботи «лише вивід» блокують усі шляхи однаково.
function webAppUrl(tab) {
  if (!WEBAPP_URL) return null;
  return tab ? WEBAPP_URL + (WEBAPP_URL.includes('?') ? '&' : '?') + 'tab=' + tab : WEBAPP_URL;
}
async function redirectWithdraw(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const mt = maintState();
  if (mt.mode !== 'off' && !isAdmin(ctx)) {
    return ctx.reply('🛠 Вивід тимчасово недоступний — технічні роботи.\n\n' + (mt.text || '')).catch(() => {});
  }
  const url = webAppUrl('wallet');
  return ctx.reply('💸 <b>Вивід зірок — у застосунку</b>\n\nТам видно баланс, суму з комісією та всі умови. Тисни 👇',
    { parse_mode: 'HTML', ...(url ? { reply_markup: { inline_keyboard: [[{ text: '💸 Відкрити гаманець', web_app: { url } }]] } } : {}) }).catch(() => {});
}

bot.action('withdraw_stars', (ctx) => redirectWithdraw(ctx));
bot.action(/^wd_fixed_(\d+)$/, (ctx) => redirectWithdraw(ctx));
bot.action('withdraw_stars_custom', (ctx) => redirectWithdraw(ctx));

bot.action('back_to_menu', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await ctx.deleteMessage().catch(() => {});
  await showMainMenu(ctx, uid);
});

// ---------------------------------------------------------------------------
// Промокоди — замість щоденного бонусу. Адмін створює код командою
// /addpromo КОД 50 [ліміт_використань], юзер вводить код і отримує зірки.
const awaitingPromoCode = new Set();

bot.action('my_profile', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;

  const u = db.getUser(uid) || {};
  const best = u.bestWin || null;
  const bestName = best && best.outcomeId
    ? (String(best.outcomeId).indexOf('star') === 0 ? best.value + '⭐' : CFG.getTier(best.outcomeId).name)
    : 'ще нічого';

  const since = u.firstSeenAt
    ? new Date(u.firstSeenAt).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })
    : '—';

  const fmt = n => (Math.round((n || 0) * 100) / 100);
  const rq = reqFor(uid);

  let text =
    `👤 <b>Твій профіль</b>\n\n` +
    `🎰 Спінів усього: <b>${u.spinsTotal || 0}</b>\n` +
    `💳 З них платних: <b>${u.paidSpinsTotal || 0}</b>\n` +
    `🎁 Призів виграно: <b>${u.prizesWonTotal || 0}</b>\n` +
    `💎 Найкращий виграш: <b>${bestName}</b>\n\n` +
    `⭐ Баланс: <b>${fmt(u.starBalance)}</b>\n` +
    `📈 Зароблено за весь час: <b>${fmt(u.starsEarnedTotal)}⭐</b>\n` +
    `📉 Витрачено на спіни: <b>${u.starsSpentTotal || 0}⭐</b>\n\n` +
    `🔥 Серія: <b>${u.dailyStreak || 0}</b> дн. (рекорд: ${u.bestStreak || 0})\n` +
    `👥 Рефералів: <b>${(u.invitedIds || []).length}</b>\n` +
    `🎫 Білетів: <b>${ticketsOf(u)}</b>\n` +
    `🛒 Магазин: <b>${rq.ok ? 'відкрито' : rq.have + '/' + rq.need + ' спінів'}</b>\n\n` +
    `<i>У боті з ${since}</i>`;

  // Історія останніх виграшів
  const hist = (u.spinHistory || []).slice(-10).reverse();
  if (hist.length) {
    text += '\n\n📜 <b>Останні виграші:</b>\n';
    for (const h of hist) {
      const d = new Date(h.at).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
      text += `  ${historyIcon(h)} ${historyName(h)} · ${d}\n`;
    }
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[callbackBtn('Назад', 'back_to_menu', undefined, 'back')]]),
  });
});

bot.action('promo_code_start', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;

  awaitingPromoCode.add(uid);
  await ctx.reply(
    '💎 Введи промокод текстом (як є, регістр не важливий):',
    Markup.inlineKeyboard([[callbackBtn('Назад', 'promo_code_cancel', undefined, 'back')]])
  );
});

// ІНЛАЙН-кнопка "Назад" — це callback_data, а не текстове повідомлення,
// тому воно фізично не потрапляє в текстовий обробник і не може випадково
// зчитатись як спроба промокоду. Тут просто прибираємо режим очікування.
bot.action('promo_code_cancel', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  awaitingPromoCode.delete(uid);
  await ctx.deleteMessage().catch(() => {});
});

bot.action('settings', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showSettings(ctx, uid);
});

bot.action('toggle_ref_notify', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  const u = db.getUser(uid);
  const currentlyOn = u ? u.notifyOnReferral !== false : true;
  db.upsertUser(uid, { notifyOnReferral: !currentlyOn });
  await showSettings(ctx, uid);
});

// ---------------------------------------------------------------------------
// Екран: сходи призів
// ---------------------------------------------------------------------------
async function showRewardsScreen(ctx, uid) {
  const T = t(uid);
  const count = referralCount(uid);
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;

  let parts = ['lockIcon', ' ', ...T.rewardsHeader(count), '\n\n',
    { b: 'Твоє посилання:' }, '\n', { code: link }, '\n\n',
    ...T.conditionsNote(), '\n\n'];
  const claimableButtons = [];

  // Те саме правило, що й у db.hasApplicationFor: сходинку закривають лише
  // заявки «за друзів». Раніше тут був чорний список джерел, і виграна
  // на колесі мішка показувалась як уже отримана за рефералів.
  const mineApps = db.listApplications().filter(a => a.uid === uid && db.isLadderApp(a));
  for (const tier of CFG.TIERS) {
    if (tier.excludeFromLadder) continue;
    const approved = mineApps.find(a => a.status === 'approved' && a.tierId === tier.id);
    const pending = mineApps.find(a => a.status === 'pending' && a.tierId === tier.id);
    const rejected = !approved && !pending && mineApps.find(a => a.status === 'rejected' && a.tierId === tier.id);

    let state, statusParts;
    if (approved) { state = 'approved'; statusParts = T.tierStatusApproved(); }
    else if (pending) { state = 'pending'; statusParts = T.tierStatusPending(); }
    else if (rejected) { state = 'rejected'; statusParts = T.tierStatusRejected(); }
    else if (count >= tier.referrals) {
      state = 'claimable'; statusParts = T.tierStatusClaimable();
      claimableButtons.push([callbackBtn(T.claimBtn(tier.emoji, tierName(tier.id, getLang(uid))), 'claim_' + tier.id, 'primary', tier.emojiKey)]);
    } else { state = 'locked'; statusParts = T.tierStatusLocked(tier.referrals - count); }

    const doneCircle = approved ? 'greenCircle' : 'redCircle';
    parts.push(T.tierLine(STATE_ICON[state], tier.emojiKey, tierName(tier.id, getLang(uid)), tier.referrals, tier.priceStars, statusParts, doneCircle), '\n');
  }

  const { text, entities } = buildText(parts);

  const shareText = encodeURIComponent(T.shareMessage);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${shareText}`;

  const rows = [
    [urlBtn(T.btnShareOneTap, shareUrl, 'success', 'lightning')],
    ...claimableButtons,
  ];
  await ctx.reply(text, { entities, ...Markup.inlineKeyboard(rows) });
  await sendBackKeyboard(uid);
}

// ---------------------------------------------------------------------------
// Реферали
// ---------------------------------------------------------------------------
// Реферал зараховується ТІЛЬКИ коли підписку на канал реально підтверджено —
// зберігаємо "відкладений" реферал при /start і зараховуємо лише в момент
// успішної перевірки підписки (requireSubscribed). Це закриває дірку з
// фейковими акаунтами, які тиснуть /start і йдуть, не підписуючись.
function attributeReferralIfPending(uid) {
  const u = db.getUser(uid);
  if (u && u.pendingRef && !u.referredBy) {
    attributeReferral(uid, u.pendingRef);
    db.upsertUser(uid, { pendingRef: null });
  }
}

function attributeReferral(uid, inviterId) {
  if (!inviterId || inviterId === uid) return;
  const u = db.getUser(uid);
  if (!u || u.referredBy) return;
  const inviter = db.getUser(inviterId);
  if (!inviter) return;

  db.upsertUser(uid, { referredBy: inviterId });
  const invitedIds = inviter.invitedIds || [];
  if (!invitedIds.includes(uid)) {
    invitedIds.push(uid);
    db.upsertUser(inviterId, { invitedIds });

    // Пас качається і за друзів, а не лише за ставки.
    // Білет за друга окремо НЕ нараховуємо: ticketsOf() уже рахує кожного
    // запрошеного як білет. Раніше тут був ще addTickets(+1) — і кожен друг
    // давав два білети замість одного.
    awardPassXp(inviterId, 'referral', 'приведений друг');
    leagueXp(inviterId, 'friend', 1);

    const ev = db.getEvent();
    if (ev && ev.active && Date.now() < ev.endsAt) {
      db.upsertUser(inviterId, { eventReferrals: (db.getUser(inviterId).eventReferrals || 0) + 1 });
    }

    // Кожен новий реферал додає квиток у всі активні розіграші, де людина вже бере участь.
    const giveaways = db.listGiveaways();
    for (const gid of Object.keys(giveaways)) {
      const g = giveaways[gid];
      if (!g.active || Date.now() >= g.endsAt) continue;
      const p = g.participants && g.participants[inviterId];
      if (p) {
        p.tickets = (p.tickets !== undefined ? p.tickets : 1) + 1;
        db.setGiveaway(gid, g);
      }
    }

    // Особисте сповіщення про нового реферала — лише якщо у людини увімкнено цю опцію.
    const freshInviter = db.getUser(inviterId);
    if (freshInviter.notifyOnReferral !== false) {
      const T = t(inviterId);
      bot.telegram.sendMessage(inviterId,
        T.newReferralNotify(u.username ? '@' + u.username : (u.name || '—'), invitedIds.length) +
        `\n🎫 Білетів: ${ticketsOf(freshInviter)}`).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------
bot.start(async (ctx) => {
  const uid = String(ctx.from.id);
  const u = db.getUser(uid);
  if (!u) {
    db.upsertUser(uid, {
      id: uid, name: ctx.from.first_name || '', username: ctx.from.username || null,
      lang: null, joinedAt: Date.now(), invitedIds: [],
      eventReferrals: 0, subscribed: false,
    });
  }

  const payload = ctx.startPayload;
  if (payload && payload.startsWith('ref_')) {
    const refId = payload.slice(4).replace(/\D/g, '');
    const current = db.getUser(uid);
    // Реферал — лише новий гравець: той, хто ще жодного разу не пройшов
    // старт (не обрав мову). Раніше будь-який давній гравець міг «стати
    // рефералом» друга, просто відкривши його посилання.
    if (refId && current && !current.referredBy && !current.pendingRef && refId !== uid && !current.lang && db.getUser(refId)) {
      db.upsertUser(uid, { pendingRef: refId });
    }
  }

  if (!(await requireSubscribed(ctx, uid))) return;

  const current = db.getUser(uid);
  if (!current.lang) { await showLanguageSelect(ctx); return; }

  if (payload === PASSWORD_CHALLENGE_PAYLOAD) {
    const pc = db.getPasswordChallenge();
    if (pc && pc.active) {
      db.upsertUser(uid, { awaitingPasswordChallenge: true });
      const { text: pcText, entities: pcEntities } = buildText(['teddyBear', ' Введи пароль, щоб отримати мішку:']);
      await ctx.reply(pcText, { entities: pcEntities });
      return;
    }
    const { text: pcEndText, entities: pcEndEntities } = buildText(['warn', ' Челендж уже завершено — стеж за наступним у каналі.']); await ctx.reply(pcEndText, { entities: pcEndEntities });
  }

  await showMainMenu(ctx, uid);
});

bot.action(/^lang_(uk|en|ru)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  db.upsertUser(uid, { lang: ctx.match[1] });
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showMainMenu(ctx, uid);
});

bot.action('check_sub', async (ctx) => {
  const uid = String(ctx.from.id);
  // Людина щойно натиснула "я підписався" — кеш тут не має права заважати.
  invalidateSubCache(uid);
  const live = await checkSubscriptionLive(uid);
  if (live !== true) {
    await ctx.answerCbQuery();
    const T = t(uid);
    const { text, entities } = buildText(T.subNotYet());
    await ctx.reply(text, { entities });
    return;
  }
  // Фіксуємо час перевірки й зараховуємо реферала одразу — раніше це
  // відбувалось лише при наступній дії людини, і друг «зависав».
  db.upsertUser(uid, { subscribed: true, subCheckedAt: Date.now() });
  attributeReferralIfPending(uid);
  await ctx.answerCbQuery('✅');
  const u = db.getUser(uid) || {};
  if (u.lang) await showMainMenu(ctx, uid);
  else await showLanguageSelect(ctx);
});

bot.action('menu_back', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showMainMenu(ctx, uid);
});

bot.action('rewards', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  await showRewardsScreen(ctx, uid);
});

const processingClaims = new Set(); // захист від подвійного тапу (race condition)

// Будь-яка сходинка драбини, а не лише перші чотири: кнопки «Забрати» для
// NFT-сходинок раніше просто нічого не робили.
const LADDER_TIER_IDS = new Set(CFG.TIERS.filter(t => !t.excludeFromLadder && t.referrals).map(t => t.id));

bot.action(/^claim_([a-z0-9_]+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  const tierId = ctx.match[1];
  if (!LADDER_TIER_IDS.has(tierId)) return ctx.answerCbQuery('Ця нагорода недоступна').catch(() => {});
  const lockKey = uid + ':' + tierId;

  // Синхронна перевірка ДО будь-яких await — блокує паралельну обробку
  // другого тапу навіть якщо він прийшов у тому самому пакеті оновлень.
  if (processingClaims.has(lockKey)) {
    await ctx.answerCbQuery();
    return;
  }
  processingClaims.add(lockKey);

  try {
    await ctx.answerCbQuery();
    if (!(await requireSubscribed(ctx, uid))) return;

    const tier = CFG.getTier(tierId);
    const count = referralCount(uid);
    const T = t(uid);

    if (count < tier.referrals) return; // кнопки не мало бути, про всяк випадок
    if (db.hasApplicationFor(uid, tierId)) {
      const { text, entities } = buildText(T.applicationAlreadyExists());
      await ctx.reply(text, { entities });
      return;
    }

    if (!ctx.from.username) {
      const { text, entities } = buildText(T.needUsername());
      await ctx.reply(text, { entities });
      return;
    }

    const app = db.addApplication({ uid, tierId, status: 'pending', createdAt: Date.now(), source: 'ladder' });

    // Прибираємо кнопку зі старого повідомлення — навіть якщо хтось
    // збереже /відкриє його пізніше й тисне ще раз, кнопки вже не буде.
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}

    const { text, entities } = buildText(T.applicationCreated(tier.emojiKey, tierName(tier.id, getLang(uid)), app.id));
    await ctx.reply(text, { entities });

    if (ADMIN_CHAT_ID) {
      const u = db.getUser(uid);
      bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📥 Нова заявка #${app.id}\n${tier.emoji} ${tier.name} (${tier.referrals} реф.)\n` +
        `Користувач: ${u.name || '—'} (${u.username ? '@' + u.username : 'без юзернейму'}) · id ${uid}`,
        Markup.inlineKeyboard([
          [
            callbackBtn('Підтвердити', `admin_approve_${app.id}`, 'success', 'check'),
            callbackBtn('Відхилити', `admin_reject_${app.id}`, 'danger', 'redCircle'),
          ],
        ])
      ).catch(() => {});
    }
  } finally {
    processingClaims.delete(lockKey);
  }
});

bot.action(/^admin_approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.match[1];
  const app = db.getApplication(id);
  await ctx.answerCbQuery();
  if (!app || app.status !== 'pending') return ctx.reply('Заявка вже оброблена або не знайдена.');

  app.status = 'approved';
  app.decidedAt = Date.now();
  db.save();

  const tier = CFG.getTier(app.tierId);
  const T = t(app.uid);
  const { text, entities } = buildText(T.applicationApproved(tier.emojiKey, tierName(tier.id, getLang(app.uid)), app.id));
  await bot.telegram.sendMessage(app.uid, text, { entities }).catch(() => {});
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Підтверджено');
});

// Замість миттєвого відхилення — просимо адміна написати причину, або "-" якщо без причини.
const awaitingRejectReason = new Map(); // adminChatId -> applicationId

bot.action(/^admin_reject_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.match[1];
  const app = db.getApplication(id);
  await ctx.answerCbQuery();
  if (!app || app.status !== 'pending') return ctx.reply('Заявка вже оброблена або не знайдена.');

  awaitingRejectReason.set(String(ctx.chat.id), id);
  await ctx.reply(`Напиши причину відхилення заявки #${id}, або просто "-" якщо без причини.`);
});

// ---------------------------------------------------------------------------
// Адмін: перегляд і рішення по заявках
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Адмін: /dbstats — повний зріз усього, що є в реальній базі даних
// ---------------------------------------------------------------------------
// Швидко виставити собі баланс зірок для тестування (лише адмін, лише собі).
bot.command('set', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.split(' ')[1];
  const amount = parseInt(arg, 10);
  if (isNaN(amount) || amount < 0) return ctx.reply('Формат: /set 100 — виставить твій баланс на 100 зірок.');

  const uid = String(ctx.from.id);
  db.upsertUser(uid, { starBalance: amount });
  await ctx.reply(`✅ Твій баланс тепер: ${amount}⭐`);
});

// Швидко виставити собі кількість "рефералів" для тестування (лише адмін,
// лише собі). Генерує фейкові id в invitedIds — реальну статистику
// (/dbstats, топ-5) це псує лише для твого власного акаунта, не чіпає нікого.
bot.command('setrefs', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.split(' ')[1];
  const count = parseInt(arg, 10);
  if (isNaN(count) || count < 0) return ctx.reply('Формат: /setrefs 25 — виставить твою кількість рефералів на 25.');

  const fakeIds = [];
  for (let i = 0; i < count; i++) fakeIds.push('test_ref_' + i);

  const uid = String(ctx.from.id);
  // Скидаємо й referralSpinsUsed, щоб тест реф-колеса стартував "з нуля".
  db.upsertUser(uid, { invitedIds: fakeIds, referralSpinsUsed: 0 });
  await ctx.reply(`✅ Твоя кількість рефералів тепер: ${count} (це тестові id, не реальні люди). referralSpinsUsed скинуто на 0.`);
});

// Створити/оновити промокод: /addpromo КОД 50 [ліміт_використань]
// Без ліміту — кожен юзер може використати його рівно 1 раз (стандартна поведінка).
bot.command('addpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const code = (parts[1] || '').toUpperCase();
  const amount = parseInt(parts[2], 10);
  const limit = parts[3] ? parseInt(parts[3], 10) : null; // null = необмежена кількість різних юзерів

  if (!code || isNaN(amount) || amount <= 0) {
    return ctx.reply('Формат: /addpromo КОД 50 [ліміт]\nНаприклад: /addpromo LAUNCH50 50 100 — код LAUNCH50 дає 50⭐, максимум 100 різних юзерів можуть його використати.');
  }

  db.setPromoCode(code, { amount, usesLeft: limit, usedBy: [], createdAt: Date.now() });
  await ctx.reply(`✅ Промокод "${code}" створено: +${amount}⭐${limit ? `, ліміт ${limit} використань` : ', без ліміту використань (кожен юзер — 1 раз)'}.`);
});

bot.command('delpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = (ctx.message.text.split(' ')[1] || '').toUpperCase();
  if (!code) return ctx.reply('Формат: /delpromo КОД');
  db.setPromoCode(code, null);
  await ctx.reply(`✅ Промокод "${code}" видалено.`);
});

// Топ-50 юзерів за балансом зірок.
bot.command('top50', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const allUsers = db.allUsers();
  const sorted = Object.entries(allUsers)
    .map(([uid, u]) => ({ uid, name: u.name || '—', username: u.username, balance: u.starBalance || 0 }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 50);

  if (!sorted.length) return ctx.reply('Юзерів у базі ще немає.');

  let text = '⭐ Топ-50 за балансом зірок:\n\n';
  sorted.forEach((u, i) => {
    text += `${i + 1}. ${u.name} (${u.username ? '@' + u.username : u.uid}) — ${u.balance}⭐\n`;
  });
  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

// Хто робив хоч якусь дію в боті за останні 24 години (реальна активність,
// не просто "коли-небудь писав боту").
bot.command('active_today', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const allUsers = db.allUsers();
  const cutoff = Date.now() - 86400000;
  const active = Object.entries(allUsers)
    .map(([uid, u]) => ({ uid, name: u.name || '—', username: u.username, lastActiveAt: u.lastActiveAt || 0 }))
    .filter(u => u.lastActiveAt >= cutoff)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  if (!active.length) return ctx.reply('За останні 24 години активності не було.');

  let text = `🟢 Активні за останні 24 год (${active.length} чол.):\n\n`;
  active.forEach((u, i) => {
    const minsAgo = Math.round((Date.now() - u.lastActiveAt) / 60000);
    text += `${i + 1}. ${u.name} (${u.username ? '@' + u.username : u.uid}) — ${minsAgo} хв тому\n`;
  });
  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

// Хто й яке колесо відкриває/крутить — журнал у базі даних (останні 2000 подій).
// Виявлення зловживання багом (щоденне колесо крутилось без обмеження до
// фіксу). Журнал у базі даних, переживає перезапуск сервера.
// Зловживання — це два ЗВИЧАЙНІ (не бонусні) щоденні спіни ближче ніж за
// 23 години. Раніше рахувалось «більше 2 щоденних спінів у журналі», і
// після появи бонусних спінів (питання дня, промокоди, пас) під покарання
// потрапили б чесні гравці. Повертає [uid, кількість порушень].
function findWheelAbusers() {
  const byUid = {};
  for (const ev of db.getWheelLog()) {
    if (ev.kind !== 'spin' || ev.wheel !== 'daily') continue;
    if (ev.extra && ev.extra.bonus) continue;
    (byUid[ev.uid] = byUid[ev.uid] || []).push(ev.ts || 0);
  }
  const out = [];
  for (const [uid, list] of Object.entries(byUid)) {
    list.sort((a, b) => a - b);
    let bad = 0;
    for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] < 23 * 3600000) bad++;
    if (bad > 0) out.push([uid, bad]);
  }
  return out;
}

// Ті, хто крутив колесо "за рефералів" більше разів, ніж мав на це право
// (1 спін = 5 запрошених). Саме цю дірку закрили — тут видно, хто нею
// встиг скористатись до фіксу.
function findReferralAbusers() {
  const counts = {};
  for (const ev of db.getWheelLog()) {
    if (ev.kind === 'spin' && ev.wheel === 'referral') {
      counts[ev.uid] = (counts[ev.uid] || 0) + 1;
    }
  }
  const result = [];
  for (const [uid, spinCount] of Object.entries(counts)) {
    const u = db.getUser(uid);
    const refCount = (u && u.invitedIds || []).length;
    const earnedSpins = Math.floor(refCount / WHEEL_CONFIGS.referral.unlockEvery);
    if (spinCount > earnedSpins) {
      result.push({ uid, spinCount, refCount, earnedSpins, excess: spinCount - earnedSpins });
    }
  }
  return result.sort((a, b) => b.excess - a.excess);
}

bot.command('referral_abuse_check', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const abusers = findReferralAbusers();
  if (!abusers.length) {
    await ctx.reply('Порушників не знайдено.');
    return;
  }
  let text = `⚠️ Знайдено ${abusers.length} акаунтів, які крутили колесо «за білети» частіше, ніж дають самі реферали:\n` +
    `ℹ️ Колесо тепер крутиться за БІЛЕТИ, а білети дають і промокоди, чат, банк, пас — перевищення саме по собі не доводить зловживання.\n\n`;
  for (const a of abusers) {
    const u = db.getUser(a.uid);
    text += `${(u && u.name) || '—'} (${u && u.username ? '@' + u.username : a.uid})\n`;
    text += `  спінів: ${a.spinCount} · рефералів: ${a.refCount} (заробив ${a.earnedSpins} спінів) · перебір: +${a.excess}\n`;
    text += `  баланс зараз: ${(u && u.starBalance) || 0}⭐\n\n`;
  }
  text += 'Щоб покарати когось конкретного — напиши /punish_user @юзернейм';
  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

bot.command('wheel_abuse_check', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const abusers = findWheelAbusers();
  if (!abusers.length) {
    await ctx.reply('Зловживань не знайдено.');
    return;
  }
  let text = `⚠️ Знайдено ${abusers.length} акаунтів зі щоденними спінами частіше, ніж раз на добу (бонусні спіни не враховано):\n\n`;
  for (const [uid, c] of abusers) {
    const u = db.getUser(uid);
    text += `${(u && u.name) || '—'} (${u && u.username ? '@' + u.username : uid}) — порушень: ${c}, баланс: ${(u && u.starBalance) || 0}⭐\n`;
  }
  text += '\nЩоб обнулити баланс і надіслати попередження всім у списку — напиши /wheel_abuse_punish так';
  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

bot.command('wheel_abuse_punish', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const abusers = findWheelAbusers();
  if (!abusers.length) return ctx.reply('Нікого карати — список порожній.');
  // Масове обнулення балансів — лише з явним підтвердженням.
  if ((ctx.message.text.split(/\s+/)[1] || '').toLowerCase() !== 'так') {
    return ctx.reply(`⚠️ Обнулити баланс ${abusers.length} акаунтам зі списку /wheel_abuse_check?\n\nПідтверди: /wheel_abuse_punish так`);
  }

  let done = 0;
  for (const [uid] of abusers) {
    db.upsertUser(uid, { starBalance: 0 });
    await bot.telegram.sendMessage(
      uid,
      '⚠️ Виявлено зловживання технічною помилкою в щоденному колесі (можливість крутити багато разів без обмеження). Твій баланс зірок обнулено.\n\nБудь ласка, дотримуйся правил — повторне зловживання призведе до блокування в боті.'
    ).catch(() => {});
    done++;
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply(`✅ Покарано ${done} акаунтів — баланс обнулено, попередження надіслано.`);
});

// Покарати КОНКРЕТНОГО юзера за юзернеймом — для будь-якого типу зловживання,
// не лише щоденного колеса. Приклад: /punish_user Mark3652
// Обнуляє баланс, відхиляє ВСІ його pending-заявки (вже підтверджені —
// не чіпає, ті призи вже реально видані). Бот далі юзати можна.
// Двокроково з підтвердженням — щоб одруківка в юзернеймі не вдарила по
// невинній людині випадково.
function findUserByUsername(username) {
  const allUsers = db.allUsers ? db.allUsers() : null;
  if (!allUsers) return null;
  for (const [uid, u] of Object.entries(allUsers)) {
    if (u.username && u.username.toLowerCase() === username.toLowerCase()) return { uid, u };
  }
  return null;
}

const pendingPunishConfirm = new Map(); // adminChatId -> { targetUid, username }

bot.command('punish_user', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const username = (ctx.message.text.split(' ')[1] || '').replace(/^@/, '');
  if (!username) return ctx.reply('Формат: /punish_user Mark3652 (без @)');

  const found = findUserByUsername(username);
  if (!found) return ctx.reply(`Юзера @${username} не знайдено в базі.`);

  const { uid: targetUid, u: target } = found;
  const pendingCount = db.listApplications('pending').filter(a => a.uid === targetUid).length;

  pendingPunishConfirm.set(String(ctx.chat.id), { targetUid, username });
  await ctx.reply(
    `⚠️ Підтверди покарання:\n\n` +
    `Ім'я: ${target.name || '—'}\nUsername: @${username}\nID: ${targetUid}\n` +
    `Поточний баланс: ${target.starBalance || 0}⭐\n` +
    `Pending-заявок, які буде скасовано: ${pendingCount}\n\n` +
    `Напиши "так" щоб підтвердити, або будь-що інше щоб скасувати.`
  );
});

bot.command('wheel_log', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const wheelLogData = db.getWheelLog();
  if (!wheelLogData.length) return ctx.reply('Журнал порожній — ще ніхто не відкривав колесо.');

  const arg = ctx.message.text.split(' ')[1];
  const limit = arg ? parseInt(arg, 10) : 30;
  const last = wheelLogData.slice(-limit).reverse();

  let text = `🎰 Останні ${last.length} подій колеса:\n\n`;
  for (const ev of last) {
    const time = new Date(ev.ts).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    const who = `${ev.name || '—'}${ev.username ? ' (@' + ev.username + ')' : ''} · id ${ev.uid}`;
    if (ev.kind === 'open') {
      text += `${time} · ВІДКРИВ колесо · ${who}\n`;
    } else {
      const outcome = ev.extra.isSpecial ? '🎁 ' + ev.extra.outcomeId : ev.extra.outcomeId;
      text += `${time} · СПІН [${ev.wheel}] → ${outcome} · ${who}\n`;
    }
  }
  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

bot.command('dbstats', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const users = Object.values(db.allUsers());
  const byLang = users.reduce((acc, u) => { const l = u.lang || 'не обрано'; acc[l] = (acc[l] || 0) + 1; return acc; }, {});
  const withUsername = users.filter(u => u.username).length;
  const subscribed = users.filter(u => u.subscribed).length;
  const totalReferrals = users.reduce((s, u) => s + (u.invitedIds || []).length, 0);
  const topInviters = users.filter(u => (u.invitedIds || []).length > 0)
    .sort((a, b) => (b.invitedIds || []).length - (a.invitedIds || []).length)
    .slice(0, 5)
    .map(u => `${u.name || u.id} — ${(u.invitedIds || []).length}`);

  const apps = db.listApplications();
  const appsByStatus = apps.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {});
  const appsBySource = apps.reduce((acc, a) => { const s = a.source || 'ladder'; acc[s] = (acc[s] || 0) + 1; return acc; }, {});
  const appsByTier = apps.reduce((acc, a) => { acc[a.tierId] = (acc[a.tierId] || 0) + 1; return acc; }, {});

  const giveaways = db.listGiveaways();
  const giveawayIds = Object.keys(giveaways);
  const event = db.getEvent();
  const flags = db.getFeatureFlags();

  let text = `📊 ПОВНИЙ ЗРІЗ БАЗИ ДАНИХ\n\n`;
  text += `👥 Користувачі: ${users.length}\n`;
  text += `  За мовою: ${Object.entries(byLang).map(([l, n]) => `${l}=${n}`).join(', ')}\n`;
  text += `  З юзернеймом: ${withUsername}/${users.length}\n`;
  text += `  Підписані на канал: ${subscribed}/${users.length}\n\n`;

  text += `🔗 Реферали:\n`;
  text += `  Всього залучено: ${totalReferrals}\n`;
  text += `  Топ-5 запрошувачів:\n${topInviters.map((s, i) => `    ${i + 1}. ${s}`).join('\n') || '    немає'}\n\n`;

  text += `📥 Заявки: ${apps.length} всього\n`;
  text += `  За статусом: ${Object.entries(appsByStatus).map(([s, n]) => `${s}=${n}`).join(', ') || 'немає'}\n`;
  text += `  За джерелом: ${Object.entries(appsBySource).map(([s, n]) => `${s}=${n}`).join(', ') || 'немає'}\n`;
  text += `  За рівнем: ${Object.entries(appsByTier).map(([t, n]) => `${t}=${n}`).join(', ') || 'немає'}\n\n`;

  if (giveawayIds.length) {
    text += `🧸 Розіграші:\n`;
    for (const gid of giveawayIds) {
      const g = giveaways[gid];
      const count = Object.keys(g.participants || {}).length;
      text += `  ${gid}: ${g.active ? '🟢 активний' : '⏹ завершено'}, учасників: ${count}\n`;
    }
    text += '\n';
  } else {
    text += `🧸 Розіграші: ще не запускались\n\n`;
  }

  text += `🏆 Подія: ${event ? (event.active ? '🟢 активна' : '⏹ завершена') + `, дедлайн: ${new Date(event.endsAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : 'ще не почалась'}\n\n`;

  text += `🔐 Фічефлаги: eventUnlocked=${flags.eventUnlocked}\n`;

  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

// Якщо адмін випадково відхилив заявку — ця команда видаляє запис про відхилення,
// і людина знову зможе подати заявку на цей рівень (кнопка з'явиться сама,
// якщо рефералів все ще достатньо).
bot.command('reopen', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.message.text.split(' ')[1];
  const app = db.getApplication(id);
  if (!app) return ctx.reply('Заявку не знайдено.');
  if (app.status !== 'rejected') return ctx.reply(`Заявка #${id} не відхилена (статус: ${app.status}) — скасовувати нема чого.`);

  const tier = CFG.getTier(app.tierId);
  db.deleteApplication(id);

  bot.telegram.sendMessage(
    app.uid,
    `Адмін переглянув рішення по твоїй заявці на ${tier.emoji} ${tier.name} — можеш подати заявку ще раз.`
  ).catch(() => {});
  await ctx.reply(`✅ Заявку #${id} відкрито заново. Юзер може подати її повторно.`);
});

bot.command('requests', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || 'pending').toLowerCase();
  const statusMap = { pending: 'pending', approved: 'approved', closed: 'approved', rejected: 'rejected' };
  const status = statusMap[arg] || 'pending';
  const list = db.listApplications(status);

  if (!list.length) return ctx.reply(`Заявок зі статусом "${status}" немає.`);

  let text = `📋 Заявки (${status}), всього: ${list.length}\n\n`;
  text += list.map(a => {
    const u = db.getUser(a.uid);
    const tier = CFG.getTier(a.tierId);
    return `#${a.id} · ${tier.emoji} ${tier.name} · ${u ? (u.username ? '@' + u.username : u.name) : '—'} (id ${a.uid})`;
  }).join('\n');

  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Адмін: прихована фаза 2 — подія має свою команду й пароль підтвердження.
// ---------------------------------------------------------------------------
const awaitingUnlockPassword = new Map(); // chatId -> 'event'

bot.command('unlock_event', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const flags = db.getFeatureFlags();
  awaitingUnlockPassword.set(String(ctx.chat.id), 'event');
  await ctx.reply(
    flags.eventUnlocked
      ? '🔐 Подія зараз УВІМКНЕНА. Введи пароль, щоб ВИМКНУТИ.'
      : '🔐 Введи пароль, щоб УВІМКНУТИ подію-лідерборд.'
  );
});

// ==========================================================================
// ПОПОВНЕННЯ БАЛАНСУ РЕАЛЬНИМИ TELEGRAM STARS — прямо в боті.
// Раніше поповнення жило тільки всередині WebApp, і людина, яка спілкується
// з ботом у чаті, просто не знала, що воно взагалі існує.
// ==========================================================================
const TOPUP_AMOUNTS = [1, 5, 15, 50, 100, 500];
const awaitingTopUpAmount = new Set();

function topUpMenu(uid) {
  const u = db.getUser(uid) || {};
  const bal = Math.round((u.starBalance || 0) * 100) / 100;
  const left = Math.max(0, DEPOSIT_BONUS_TIMES - (u.depositCount || 0));

  const rows = [];
  for (let i = 0; i < TOPUP_AMOUNTS.length; i += 2) {
    const row = [];
    for (const a of TOPUP_AMOUNTS.slice(i, i + 2)) {
      const bonus = left > 0 ? depositBonusFor(uid, a) : 0;
      row.push(callbackBtn(bonus ? `${a}⭐ → ${fmtStars(a + bonus)}⭐` : `${a}⭐`, `topup_${a}`, 'success', 'starIcon'));
    }
    rows.push(row);
  }
  rows.push([callbackBtn('✏️ Своя сума', 'topup_own', 'primary', 'starIcon')]);
  rows.push([callbackBtn('Назад', 'back_to_menu', undefined, 'back')]);

  return {
    text: `⭐ <b>Поповнення балансу</b>\n\n` +
      `Баланс: <b>${fmtStars(bal)}⭐</b>\n\n` +
      `Оплата — реальними Telegram Stars, тими самими, що ти купуєш у Telegram.\n` +
      (left > 0
        ? `🎁 <b>Бонус +${DEPOSIT_BONUS_PERCENT}%</b> ще на ${left} поповн.: кладеш 100⭐ — отримуєш ${100 + DEPOSIT_BONUS_PERCENT}⭐\n\n`
        : `\n`) +
      `Обери суму:`,
    keyboard: Markup.inlineKeyboard(rows),
  };
}

bot.action('topup_menu', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  const m = topUpMenu(uid);
  await ctx.reply(m.text, { parse_mode: 'HTML', ...m.keyboard });
});

bot.command('topup', async (ctx) => {
  const uid = String(ctx.from.id);
  const m = topUpMenu(uid);
  await ctx.reply(m.text, { parse_mode: 'HTML', ...m.keyboard });
});

// Бонус за поповнення — одна формула для підпису в рахунку і для нарахування.
// Раніше рахунок округлював бонус до цілого, а нараховувалось із копійками.
function depositBonusFor(uid, amount) {
  const u = db.getUser(uid) || {};
  if ((u.depositCount || 0) >= DEPOSIT_BONUS_TIMES) return 0;
  return Math.round(amount * DEPOSIT_BONUS_PERCENT) / 100;
}

function parseTopUpAmount(raw) {
  // «1 000» → 1000, «75⭐» → 75; «1.5» — це 1, а не 15.
  const a = parseInt(String(raw == null ? '' : raw).replace(/\s/g, ''), 10);
  if (!a || a < 1) return { error: 'Сума має бути цілим числом від 1.' };
  if (a > TOPUP_MAX) return { error: `Максимум за один раз — ${TOPUP_MAX}⭐. Можна поповнити кілька разів.` };
  return { amount: a };
}

async function sendTopUpInvoice(ctx, uid, amount) {
  const p = parseTopUpAmount(amount);
  if (p.error) return ctx.reply(p.error);
  const a = p.amount;
  const bonus = depositBonusFor(uid, a);
  try {
    await ctx.replyWithInvoice({
      title: `Поповнення на ${a}⭐`,
      description: bonus
        ? `${a}⭐ на внутрішній баланс + бонус ${fmtStars(bonus)}⭐. Разом ${fmtStars(a + bonus)}⭐.`
        : `${a}⭐ на внутрішній баланс StarForge.`,
      payload: JSON.stringify({ uid, starsAmount: a, ts: Date.now() }),
      // provider_token для XTR не передається взагалі.
      currency: 'XTR',
      prices: [{ label: `${a}⭐`, amount: a }],
    });
  } catch (e) {
    console.error('topup invoice failed:', e.message);
    await ctx.reply('Не вдалось створити рахунок: ' + e.message + '\n\nСпробуй ще раз або напиши адміну.');
  }
}

bot.action(/^topup_(\d+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  await sendTopUpInvoice(ctx, uid, ctx.match[1]);
});

bot.action('topup_own', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  awaitingTopUpAmount.add(uid);
  await ctx.reply(`Напиши суму поповнення числом. Від 1 до ${TOPUP_MAX}⭐.\n\nНаприклад: <code>75</code>`, { parse_mode: 'HTML' });
});

function parsePaymentPayload(raw) {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && p.uid ? p : null;
  } catch (e) { return null; }
}

// Telegram Stars: обов'язково відповісти на pre_checkout протягом 10с.
// Раніше відповідь була «так» на все підряд — тепер відсікаємо чужі й
// застарілі рахунки ще до списання грошей у людини.
bot.on('pre_checkout_query', async (ctx) => {
  const q = ctx.preCheckoutQuery;
  const payload = parsePaymentPayload(q.invoice_payload);
  let err = null;
  if (q.currency !== 'XTR') err = 'Непідтримувана валюта.';
  else if (!payload) err = 'Рахунок пошкоджено. Створи новий.';
  else if (String(payload.uid) !== String(q.from.id)) err = 'Цей рахунок створено для іншого акаунта.';
  else if (payload.type === 'premium_spin' && WHEEL_CONFIGS.premium.disabled) err = 'Преміум-колесо вимкнено.';
  else if (payload.type === 'pass_premium' && pass.ensure(db.getUser(String(q.from.id)) || {}, Date.now()).premium) err = 'Платна лінія пасу вже відкрита.';
  if (err) return ctx.answerPreCheckoutQuery(false, err).catch(() => {});
  await ctx.answerPreCheckoutQuery(true).catch(() => {});
});

// Успішна оплата зірками Telegram -> нараховуємо на внутрішній баланс.
bot.on('message', async (ctx, next) => {
  if (!(ctx.message && ctx.message.successful_payment)) return next();
  const payment = ctx.message.successful_payment;
  const payload = parsePaymentPayload(payment.invoice_payload);
  // Скільки людина РЕАЛЬНО заплатила. Саме цю суму й зараховуємо, а не
  // число з payload: payload — лише наша позначка, гроші — ось тут.
  const paid = payment.currency === 'XTR' ? Math.max(0, parseInt(payment.total_amount, 10) || 0) : 0;
  const payer = String(ctx.from.id);
  const uid = payload && payload.uid ? String(payload.uid) : payer;

  // ЗАХИСТ ВІД ПОДВІЙНОГО НАРАХУВАННЯ. Telegram може передоставити апдейт
  // (рестарт під час оплати, повтор офсету при polling).
  const chargeId = payment.telegram_payment_charge_id || '';
  if (chargeId) {
    const f = db.getFeatureFlags() || {};
    const seenGlobal = f.paidCharges || [];
    const uPrev = db.getUser(uid) || {};
    const seen = uPrev.paidCharges || [];
    if (seen.indexOf(chargeId) !== -1 || seenGlobal.indexOf(chargeId) !== -1) {
      console.log('Повторний апдейт платежу, пропускаю:', chargeId);
      return;
    }
    db.upsertUser(uid, { paidCharges: seen.concat([chargeId]).slice(-50) });
    db.setFeatureFlags({ paidCharges: seenGlobal.concat([chargeId]).slice(-500) });
  }
  console.log(`💳 Оплата ${paid} XTR від ${payer} (${payload && payload.type || 'topup'}) charge=${chargeId}`);

  if (!paid) {
    if (ADMIN_CHAT_ID) bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Дивний платіж без суми XTR від ${payer}: ${JSON.stringify(payment).slice(0, 500)}`).catch(() => {});
    return;
  }

  const creditBalance = (why) => {
    const u = db.getUser(uid) || {};
    const bal = Math.round(((u.starBalance || 0) + paid) * 100) / 100;
    db.upsertUser(uid, { starBalance: bal });
    bot.telegram.sendMessage(uid, `${why}\n\n${paid}⭐ зараховано на внутрішній баланс.\nБаланс: ${fmtStars(bal)}⭐`).catch(() => {});
    return bal;
  };

  if (payload && payload.type === 'pass_premium') {
    // Платна лінія пасу, куплена за РЕАЛЬНІ Telegram Stars.
    const u = db.getUser(uid) || {};
    const pp = pass.ensure(u, Date.now());
    const r = pass.buy(pp, 0, 'xtr');
    if (r.ok) {
      db.upsertUser(uid, { pass: pp });
      const caption = `💎 <b>Платну лінію відкрито</b>\n\n` +
        `Оплачено ${paid} Telegram Stars.\n` +
        `Бонус за оплату зірками: <b>+${pass.XTR_BONUS_LEVELS} рівні</b> (зараз ${r.level}).\n` +
        (r.unlocked ? `Доступно нагород: <b>${r.unlocked}</b>.\n` : '') +
        `Фінал на 30 рівні — Мішка, спін платного колеса і 30⭐.`;
      const kb = Markup.inlineKeyboard([[callbackBtn('🎁 Забрати нагороди', 'pass_claim_all', 'success', 'starIcon')]]);
      const ph = media.photo('bear');
      const sent = ph ? await bot.telegram.sendPhoto(uid, ph, { caption, parse_mode: 'HTML', ...kb }).catch(() => null) : null;
      if (!sent) await bot.telegram.sendMessage(uid, caption, { parse_mode: 'HTML', ...kb }).catch(() => {});
      if (ADMIN_CHAT_ID) {
        bot.telegram.sendMessage(ADMIN_CHAT_ID, `💎 Куплено пас за РЕАЛЬНІ зірки: ${paid}⭐\nЮзер: ${uid}`).catch(() => {});
      }
    } else {
      // Уже куплений пас оплатили вдруге — повертаємо внутрішнім балансом,
      // бо інакше людина просто втратить гроші через подвійний тап.
      creditBalance('Платна лінія вже була відкрита.');
    }
  } else if (payload && payload.type === 'premium_spin') {
    if (WHEEL_CONFIGS.premium.disabled) {
      // Колесо вимкнене — спін використати ніде. Гроші не мають зникнути.
      creditBalance('Преміум-колесо зараз вимкнене, тому спін не нараховано.');
    } else {
      const u = db.getUser(uid);
      const spins = ((u && u.premiumSpinsAvailable) || 0) + 1;
      db.upsertUser(uid, { premiumSpinsAvailable: spins });
      await bot.telegram.sendMessage(uid, `✅ Оплата пройшла! Доступно преміум-спінів: ${spins}\nВідкрий колесо й крути.`).catch(() => {});
    }
  } else {
    // Поповнення балансу. Бонус +10% на перші три поповнення — одразу.
    const u = db.getUser(uid) || {};
    const deposits = u.depositCount || 0;
    const bonus = depositBonusFor(uid, paid);
    const newBalance = Math.round(((u.starBalance || 0) + paid + bonus) * 100) / 100;
    db.upsertUser(uid, { starBalance: newBalance, depositCount: deposits + 1, depositedTotal: (u.depositedTotal || 0) + paid });
    awardPassXp(uid, 'deposit', 'поповнення балансу');
    await bot.telegram.sendMessage(uid,
      `✅ Поповнення успішне! +${paid}⭐` +
      (bonus ? `\n🎁 Бонус новачка: +${fmtStars(bonus)}⭐ (лишилось ${Math.max(0, DEPOSIT_BONUS_TIMES - deposits - 1)} з бонусом)` : '') +
      `\nНовий баланс: ${fmtStars(newBalance)}⭐`
    ).catch(() => {});
    if (ADMIN_CHAT_ID && paid >= 50) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID, `💳 Поповнення ${paid}⭐ від ${u.username ? '@' + u.username : uid}`).catch(() => {});
    }
  }
  // Це не звичайне текстове повідомлення — далі не пропускаємо.
});

bot.on('text', async (ctx, next) => {
  const chatId = String(ctx.chat.id);
  const uid = String(ctx.from.id);

  // Команди НІКОЛИ не мають з'їдатися станами очікування. Раніше, якщо людина
  // (чи адмін) була в режимі "введи промокод"/"введи суму", будь-яка команда
  // сприймалась як відповідь на той запит і не спрацьовувала.
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    awaitingPromoCode.delete(uid);
    awaitingDiceBet.delete(uid);
    awaitingTopUpAmount.delete(uid);
    awaitingBankBet.delete(uid);
    pendingPunishConfirm.delete(chatId);
    awaitingRejectReason.delete(chatId);
    awaitingExtProofRejectReason.delete(chatId);
    return next();
  }

  // Своя ставка в спільний банк.
  if (awaitingBankBet.has(uid)) {
    awaitingBankBet.delete(uid);
    const a = parseInt(String(ctx.message.text).replace(/\s/g, ''), 10);
    if (!a || a < 1) { await ctx.reply('Це не схоже на суму. Напиши ціле число.'); return; }
    await placeBankBet(ctx, uid, a);
    return;
  }

  // Своя сума поповнення.
  if (awaitingTopUpAmount.has(uid)) {
    awaitingTopUpAmount.delete(uid);
    await sendTopUpInvoice(ctx, uid, String(ctx.message.text).trim());
    return;
  }

  // Своя ставка в емодзі-грі.
  if (awaitingDiceBet.has(uid)) {
    const gameId = awaitingDiceBet.get(uid);
    awaitingDiceBet.delete(uid);
    const g = DICE_GAMES[gameId];
    const raw = ctx.message.text.trim().replace(',', '.');
    const bet = Math.floor(Number(raw));
    const u = db.getUser(uid) || {};
    const bal = u.starBalance || 0;

    if (!g) return;
    if (!Number.isFinite(bet) || bet < 1) {
      await ctx.reply('Це не схоже на суму. Напиши ціле число від 1.');
      return;
    }
    if (bet > bal) {
      await ctx.reply(`Замало зірок: ставка ${bet}⭐, у тебе ${Math.round(bal * 100) / 100}⭐.`);
      return;
    }
    await ctx.reply(
      `${g.emoji} <b>${g.label}</b> · ставка <b>${bet}⭐</b>\n` +
      `Виграш: ${Math.round(bet * g.k * 100) / 100}⭐ · +${bet * pass.XP_PER_STAR_BET} XP у пас`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [callbackBtn(`Кидати на ${bet}⭐`, `dice_b_${gameId}_${bet}`, 'success', 'starIcon')],
        [callbackBtn('Назад', 'dice_menu', undefined, 'back')],
      ]) }
    );
    return;
  }

  // Промокод — лише якщо саме зараз юзер у режимі очікування коду.
  // "Назад" з reply-клавіатури обробляється окремим bot.hears('Назад', ...)
  // ЩЕ РАНІШЕ в ланцюжку (рядок ~232), тому сюди вона взагалі не долітає —
  // жодного ризику, що "Назад" зарахується як спроба промокоду.
  if (awaitingPromoCode.has(uid)) {
    awaitingPromoCode.delete(uid);
    const code = ctx.message.text.trim().toUpperCase();
    const promo = db.getPromoCode(code);

    if (!promo) {
      await ctx.reply('❌ Такого промокоду не існує або він більше не діє.');
      await sendBackKeyboard(uid);
      return;
    }
    if (promo.usedBy.includes(uid)) {
      await ctx.reply('⚠️ Ти вже використав цей промокод раніше.');
      await sendBackKeyboard(uid);
      return;
    }
    if (promo.usesLeft != null && promo.usedBy.length >= promo.usesLeft) {
      await ctx.reply('❌ Ліміт використань цього промокоду вичерпано.');
      await sendBackKeyboard(uid);
      return;
    }

    const u = db.getUser(uid);
    const newBalance = Math.round(((u ? u.starBalance || 0 : 0) + (promo.amount || 0)) * 100) / 100;
    const patch = { starBalance: newBalance };
    if (promo.spins) patch.freeSpins = ((u && u.freeSpins) || 0) + promo.spins;
    db.upsertUser(uid, patch);
    if (promo.tickets) addTickets(uid, promo.tickets, 'промокод ' + code);
    awardPassXp(uid, 'promo', 'промокод');
    promo.usedBy.push(uid);
    db.setPromoCode(code, promo);

    const got = [];
    if (promo.amount) got.push(`+${promo.amount}⭐`);
    if (promo.tickets) got.push(`+${promo.tickets} 🎫 білет${promo.tickets > 1 ? 'и' : ''}`);
    if (promo.spins) got.push(`+${promo.spins} спін${promo.spins > 1 ? 'и' : ''}`);
    await ctx.reply(`✅ Промокод активовано!\n\n${got.join('\n')}\n\nБаланс: ${newBalance}⭐`);
    await sendBackKeyboard(uid);
    return;
  }

  // Підтвердження покарання ("так"/будь-що інше) — лише якщо саме зараз
  // очікується відповідь на конкретний запит /punish_user для цього чату.
  if (isAdmin(ctx) && pendingPunishConfirm.has(chatId)) {
    const pending = pendingPunishConfirm.get(chatId);
    pendingPunishConfirm.delete(chatId);

    if (ctx.message.text.trim().toLowerCase() !== 'так') {
      await ctx.reply('Скасовано, нікого не покарано.');
      return;
    }

    const { targetUid, username } = pending;
    const target = db.getUser(targetUid);
    if (!target) { await ctx.reply('Юзера більше немає в базі.'); return; }

    const oldBalance = target.starBalance || 0;
    db.upsertUser(targetUid, { starBalance: 0 });

    const pendingApps = db.listApplications('pending').filter(a => a.uid === targetUid);
    for (const app of pendingApps) {
      app.status = 'rejected';
      app.decidedAt = Date.now();
      app.reason = 'Зловживання багом — заявку скасовано адміністрацією.';
    }
    if (pendingApps.length) db.save();

    await bot.telegram.sendMessage(
      targetUid,
      `⚠️ УВАГА — ЗЛОВЖИВАННЯ ВИЯВЛЕНО ⚠️\n\nМи зафіксували, що ти скористався технічною помилкою в боті для отримання зірок/призів в обхід чесних правил.\n\nНаслідки:\n• Баланс зірок обнулено (було ${oldBalance}⭐)\n• Всі твої заявки, що очікували підтвердження (${pendingApps.length}), скасовано\n\nЦе останнє попередження. Наступне зловживання — і акаунт буде заблоковано в боті НАЗАВЖДИ, без можливості відновлення.\n\nБотом і надалі можеш користуватись чесно.`
    ).catch(() => {});

    await ctx.reply(`✅ Покарано @${username} (id ${targetUid}):\n— баланс: ${oldBalance}⭐ → 0⭐\n— скасовано pending-заявок: ${pendingApps.length}\n— бот НЕ заблокований, попередження надіслано`);
    return;
  }

  // FOMO-челендж на пароль: перший, хто вгадає правильний пароль, забирає мішку.
  // Синхронна перевірка (без await всередині) — атомарно проти паралельних спроб.
  const uForChallenge = db.getUser(uid);
  if (uForChallenge && uForChallenge.awaitingPasswordChallenge) {
    const pc = db.getPasswordChallenge();
    const guess = ctx.message.text.trim().toLowerCase();

    if (!pc || !pc.active) {
      db.upsertUser(uid, { awaitingPasswordChallenge: false });
      const { text: pcEndText, entities: pcEndEntities } = buildText(['warn', ' Челендж уже завершено — стеж за наступним у каналі.']); await ctx.reply(pcEndText, { entities: pcEndEntities });
      return;
    }

    // Перебір паролів ботом-автоклікером: одна спроба на 3 секунди.
    const lastGuess = passwordGuessAt.get(uid) || 0;
    if (Date.now() - lastGuess < 3000) { await ctx.reply('⏳ Не так швидко — одна спроба на 3 секунди.'); return; }
    passwordGuessAt.set(uid, Date.now());

    if (guess === pc.password.trim().toLowerCase()) {
      // Хто перший — той і забрав. Синхронно позначаємо challenge неактивним
      // ДО будь-яких await, щоб паралельна спроба іншого юзера не проскочила.
      pc.active = false;
      pc.winnerId = uid;
      db.setPasswordChallenge(pc);
      db.upsertUser(uid, { awaitingPasswordChallenge: false });

      const tier = CFG.getTier(pc.tierId);
      const u = db.getUser(uid);
      const app = db.addApplication({ uid, tierId: pc.tierId, status: 'pending', createdAt: Date.now(), source: 'password_challenge' });
      await ctx.reply(`🎉 ВІРНО! Ти перший — ${tier.emoji} ${tier.name} твоя! Заявку передано адміну на розгляд.`);
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🧸 Переможець пароль-челенджу! Заявка #${app.id}\nІм'я: ${u.name || '—'}\nUsername: ${u.username ? '@' + u.username : 'без юзернейму'}\nID: ${uid}`,
          Markup.inlineKeyboard([[
            callbackBtn('Підтвердити', `admin_approve_${app.id}`, 'success', 'check'),
            callbackBtn('Відхилити', `admin_reject_${app.id}`, 'danger', 'redCircle'),
          ]])
        ).catch(() => {});
      }
    } else {
      const { text: wrongText, entities: wrongEntities } = buildText(['redCircle', ' Невірний пароль, спробуй ще раз.']); await ctx.reply(wrongText, { entities: wrongEntities });
    }
    return;
  }

  if (isAdmin(ctx) && awaitingExtProofRejectReason.has(chatId)) {
    const uid = awaitingExtProofRejectReason.get(chatId);
    awaitingExtProofRejectReason.delete(chatId);

    const raw = ctx.message.text.trim();
    const reason = raw === '-' ? null : raw;

    await bot.telegram.sendMessage(
      uid,
      `❌ Твій доказ реєстрації за посиланням не підтверджено адміном.` + (reason ? `\n\nПричина: ${reason}` : '') + '\n\nЯкщо вважаєте це помилкою — напишіть у підтримку @getbearhere.'
    ).catch(() => {});
    await ctx.reply(`❌ Відхилено${reason ? ` (причина: ${reason})` : ' (без причини)'}.`);
    return;
  }

  if (isAdmin(ctx) && awaitingProofRejectReason.has(chatId)) {
    const { proofType, gid, uid } = awaitingProofRejectReason.get(chatId);
    awaitingProofRejectReason.delete(chatId);

    const raw = ctx.message.text.trim();
    const reason = raw === '-' ? null : raw;
    const typeLabel = PROOF_TYPE_LABEL[proofType] || proofType;

    await bot.telegram.sendMessage(
      uid,
      `❌ Твій доказ ${typeLabel} не підтверджено адміном.` + (reason ? `\n\nПричина: ${reason}` : '') + '\n\nЯкщо вважаєте це помилкою — напишіть у підтримку @getbearhere.'
    ).catch(() => {});
    await ctx.reply(`❌ Відхилено${reason ? ` (причина: ${reason})` : ' (без причини)'}.`);
    return;
  }

  if (isAdmin(ctx) && awaitingRejectReason.has(chatId)) {
    const id = awaitingRejectReason.get(chatId);
    awaitingRejectReason.delete(chatId);

    const app = db.getApplication(id);
    if (!app || app.status !== 'pending') { await ctx.reply('Заявка вже оброблена або не знайдена.'); return; }

    const raw = ctx.message.text.trim();
    const reason = raw === '-' ? null : raw;

    app.status = 'rejected';
    app.decidedAt = Date.now();
    if (reason) app.reason = reason;
    // Вивід і покупка в магазині оплачені зірками — при відмові їх треба
    // повернути. Раніше заявка відхилялась, а зірки просто зникали.
    const back = refundApplication(app);
    db.save();

    const tier = CFG.getTier(app.tierId);
    const T = t(app.uid);
    const { text, entities } = buildText(T.applicationRejected(tier.emojiKey, tierName(tier.id, getLang(app.uid)), reason, app.id));
    await bot.telegram.sendMessage(app.uid, text, { entities }).catch(() => {});
    if (back) {
      await bot.telegram.sendMessage(app.uid, `↩️ ${fmtStars(back)}⭐ за заявку #${app.id} повернуто на баланс.`).catch(() => {});
    }
    await ctx.reply(`❌ Заявку #${id} відхилено${reason ? ` (причина: ${reason})` : ' (без причини)'}.` +
      (back ? `\n↩️ Повернуто ${fmtStars(back)}⭐ на баланс.` : ''));
    return;
  }

  if (isAdmin(ctx) && awaitingUnlockPassword.has(chatId)) {
    const feature = awaitingUnlockPassword.get(chatId);
    awaitingUnlockPassword.delete(chatId);
    // Пароль не має лишатись в історії чату.
    ctx.deleteMessage().catch(() => {});

    if (ctx.message.text.trim() === CFG.ADVANCED_UNLOCK_PASSWORD) {
      const flags = db.getFeatureFlags();

      if (feature === 'event') {
        const newState = !flags.eventUnlocked;
        db.setFeatureFlags({ eventUnlocked: newState });
        if (newState && !db.getEvent()) {
          db.setEvent({ active: true, startedAt: Date.now(), endsAt: CFG.EVENT_END });
          scheduleEventCheck();
          await ctx.reply('📣 Розсилаю анонс події всім користувачам...');
          const sent = await broadcastEventStart();
          await ctx.reply(`✅ Подію увімкнено, анонс розіслано ${sent} користувачам.`);
        } else {
          await ctx.reply(newState ? '✅ Подію увімкнено.' : '⏹ Подію вимкнено.');
        }
      }
    } else {
      await ctx.reply('❌ Невірний пароль. Нічого не змінено.');
    }
    return;
  }
  return next();
});

bot.action('event_status', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!db.getFeatureFlags().eventUnlocked) return;

  const T = t(uid);
  const ev = db.getEvent();
  if (!ev) return ctx.reply(T.eventNotStarted);

  const ranked = Object.values(db.allUsers())
    .filter(u => (u.eventReferrals || 0) > 0)
    .sort((a, b) => (b.eventReferrals || 0) - (a.eventReferrals || 0));

  const u = db.getUser(uid);
  const myRank = ranked.findIndex(x => x.id === uid) + 1;
  const daysLeft = Math.max(0, Math.ceil((ev.endsAt - Date.now()) / 86400000));

  const medalKeys = ['goldMedal', 'silverMedal', 'bronzeMedal'];
  const topParts = [];
  ranked.slice(0, 5).forEach((x, i) => {
    const isMe = x.id === uid ? T.eventYouSuffix : '';
    const line = `${displayName(x)}${isMe}${T.eventRefSuffix(x.eventReferrals)}\n`;
    if (i < 3) topParts.push(medalKeys[i], ' ' + line);
    else topParts.push(`${i + 1}. ${line}`);
  });
  if (!ranked.length) topParts.push({ i: T.eventNoScores });

  const deadlineLocale = getLang(uid) === 'en' ? 'en-GB' : getLang(uid) === 'ru' ? 'ru-RU' : 'uk-UA';
  const deadlineStr = new Date(ev.endsAt).toLocaleString(deadlineLocale, { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;

  const thirdPlaceScore = ranked[2] ? ranked[2].eventReferrals : 0;
  const myScore = u.eventReferrals || 0;
  const neededForTop3 = thirdPlaceScore - myScore + 1;
  let motivationLine;
  if (myRank && myRank <= 3) motivationLine = { i: T.eventMotivationTop3(daysLeft) };
  else if (neededForTop3 <= 3) motivationLine = { i: T.eventMotivationClose(neededForTop3) };
  else motivationLine = { i: T.eventMotivationFar(daysLeft) };

  const { text, entities } = buildText([
    'trophy', ' ', { b: T.eventTitle }, '\n',
    'clockIcon', ' ' + T.eventDeadlineLine(deadlineStr, daysLeft) + '\n\n',
    { b: T.linkLabel }, '\n', { code: link }, '\n\n',
    'statsIcon', ' ', { b: T.eventLeaderboard }, '\n',
    ...topParts,
    '\n',
    T.eventYourPlace, ' ', { b: myRank ? `${myRank}` : '—' }, ` ${T.eventRefForEvent(myScore)}\n`,
    motivationLine, '\n\n',
    ...T.conditionsNote(), '\n\n',
    'infoIcon', ' ', { b: T.eventLearnMore }, '\n',
    T.eventPlacesLine, '\n',
    { i: T.eventRulesNote },
  ]);

  const shareText = encodeURIComponent(T.shareMessage);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${shareText}`;

  await ctx.reply(text, { entities, ...Markup.inlineKeyboard([[urlBtn(T.btnShareOneTap, shareUrl, 'success', 'lightning')]]) });
  await sendBackKeyboard(uid);
});

// ---------------------------------------------------------------------------
// Завершення події: розподіл призів у інвентар топ-10
// ---------------------------------------------------------------------------
async function broadcastEventStart() {
  const deadlineStr = new Date(CFG.EVENT_END).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const users = Object.values(db.allUsers());
  let sent = 0;
  for (const u of users) {
    if (!u.lang) continue;
    const { text, entities } = buildText([
      'megaphone', ' ', { b: 'ПОДІЯ ТИЖНЯ СТАРТУВАЛА!' }, '\n\n',
      'Запрошуй друзів і піднімайся в лідерборді — топ-3 отримають реальні призи:\n',
      'goldMedal', ' ', 'rocket', ' Ракета · ', 'silverMedal', ' ', 'giftBox', ' Подарунок · ', 'bronzeMedal', ' ', 'teddyBear', ' Мішка\n\n',
      'clockIcon', ` Дедлайн: ${deadlineStr} (Київ)\n\n`,
      'infoIcon', ' ', { i: 'Рахуються лише нові запрошення за час події — старий прогрес не враховується. Перевір свій лідерборд у меню ' }, 'trophy', { i: ' ПОДІЯ.' },
    ]);
    try { await bot.telegram.sendMessage(u.id, text, { entities }); sent++; } catch (e) { /* заблокував бота */ }
    await new Promise(r => setTimeout(r, 60));
  }
  return sent;
}
let eventTimer = null;
function scheduleEventCheck() {
  if (eventTimer) clearTimeout(eventTimer);
  const ev = db.getEvent();
  if (!ev || !ev.active) return;
  const delay = Math.max(1000, ev.endsAt - Date.now());
  eventTimer = setTimeout(finishEvent, delay);
}

async function finishEvent() {
  const ev = db.getEvent();
  if (!ev || !ev.active) return;
  ev.active = false;
  db.setEvent(ev);

  const ranked = Object.values(db.allUsers())
    .filter(u => (u.eventReferrals || 0) > 0)
    .sort((a, b) => b.eventReferrals - a.eventReferrals);

  const summary = [];
  ranked.forEach((u, idx) => {
    const place = idx + 1;
    let prizes = [];
    if (CFG.EVENT_PRIZES_BY_PLACE[place]) prizes = CFG.EVENT_PRIZES_BY_PLACE[place];
    else if (CFG.EVENT_PLACES_BEAR_ONLY.includes(place)) prizes = [{ id: 'bear', qty: 1 }];
    if (!prizes.length) return;

    // Замість інвентарю — одразу створюємо заявку(и) на кожен приз, як і в сходах.
    prizes.forEach(p => {
      for (let i = 0; i < p.qty; i++) {
        const tier = CFG.getTier(p.id);
        const app = db.addApplication({ uid: u.id, tierId: p.id, status: 'pending', createdAt: Date.now(), source: 'event' });
        if (ADMIN_CHAT_ID) {
          bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🏆 Приз за подію, заявка #${app.id}\n${tier.emoji} ${tier.name} · місце ${place}\nКористувач: ${u.name || '—'} (${u.username ? '@' + u.username : 'без юзернейму'}) · id ${u.id}`,
            Markup.inlineKeyboard([[
              callbackBtn('Підтвердити', `admin_approve_${app.id}`, 'success', 'check'),
              callbackBtn('Відхилити', `admin_reject_${app.id}`, 'danger', 'redCircle'),
            ]])
          ).catch(() => {});
        }
      }
    });
    summary.push(`${place}. ${u.name || u.id} — ${prizes.map(p => `${p.qty}x ${CFG.getTier(p.id).emoji}`).join(' ')}`);

    const winMsgParts = place === 1
      ? ['crown', ' ', { b: 'ТИ ПЕРЕМІГ У ПОДІЇ!' }, ` Твоє місце: 1. Заявку на приз передано адміну на розгляд.` ]
      : [{ b: `Подія завершена! Твоє місце: ${place}.` }, ' Заявку на приз передано адміну на розгляд.'];
    const { text: winText, entities: winEntities } = buildText(winMsgParts);
    bot.telegram.sendMessage(u.id, winText, { entities: winEntities }).catch(() => {});
  });

  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🏁 Подія завершена! Заявки на призи надіслані окремо.\n\n${summary.join('\n') || 'Учасників не було.'}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Розіграші за квитками: приєднуєшся кнопкою, кожен новий реферал з цього
// моменту — +1 квиток (більше квитків = більше шансів). Можна вести кілька
// паралельно (зараз: мішка + подарунок), незалежно від основної події.
// ---------------------------------------------------------------------------
// Сьогодні HH:MM за Києвом. Раніше зсув був жорстко +3 год, і взимку
// (UTC+2) усі дедлайни розіграшів з'їжджали на годину.
function kyivTodayAt(hour, minute) {
  const day = league.dayKey(Date.now());
  const t = league.parseKyiv(day + ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'));
  return new Date(t || Date.now());
}

const LIVE_GIVEAWAYS = [
  { id: 'ga_gift', tierId: 'gift' },
];

const giveawayTimers = {};
function scheduleGiveawayCheck(gid) {
  if (giveawayTimers[gid]) clearTimeout(giveawayTimers[gid]);
  const g = db.getGiveaway(gid);
  if (!g || !g.active) return;
  const delay = Math.max(1000, g.endsAt - Date.now());
  giveawayTimers[gid] = setTimeout(() => finishGiveaway(gid), delay);
}
function scheduleAllGiveawayChecks() {
  for (const gid of Object.keys(db.listGiveaways())) scheduleGiveawayCheck(gid);
}

async function broadcastGiveaways(endsAtLabel) {
  const users = Object.values(db.allUsers());
  let sent = 0;
  for (const u of users) {
    if (!u.lang) continue; // ще не обрав мову — пропускаємо
    const T = t(u.id);
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${u.id}`;
    const localName = tierName('gift', u.lang);

    const { text, entities } = buildText([
      ...T.gaAnnounce(localName, endsAtLabel),
      { b: T.linkLabel }, '\n', { code: link }, '\n\n',
      ...T.conditionsNote(),
    ]);

    const shareText = encodeURIComponent(T.shareMessage);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${shareText}`;

    try {
      await bot.telegram.sendMessage(u.id, text, {
        entities,
        ...Markup.inlineKeyboard([
          [callbackBtn(T.btnJoinGiveaway, 'ga_join_ga_gift', 'danger', 'giftBox')],
          [urlBtn(T.btnShareOneTap, shareUrl, 'primary', 'lightning')],
        ]),
      });
      sent++;
    } catch (e) { /* заблокував бота — пропускаємо */ }
    await new Promise(r => setTimeout(r, 60));
  }
  return sent;
}

async function finishGiveaway(gid) {
  const g = db.getGiveaway(gid);
  if (!g || !g.active) return;
  const tier = CFG.getTier(g.tierId);
  const participants = g.participants || {};
  let pool = Object.keys(participants);
  const winnersCount = g.winnersCount || 1;

  g.active = false;
  g.finishedAt = Date.now();

  if (pool.length === 0) {
    db.setGiveaway(gid, g);
    if (ADMIN_CHAT_ID) await bot.telegram.sendMessage(ADMIN_CHAT_ID, `${tier.emoji} Розіграш "${tier.name}" завершено — учасників не було.`).catch(() => {});
    return;
  }

  const withUsername = pool.filter(uid => { const u = db.getUser(uid); return u && u.username; });
  if (withUsername.length) pool = withUsername;

  // Зважений вибір N переможців без повторів: кожен раунд обираємо одного
  // зваженим рандомом, прибираємо його з пулу, повторюємо.
  const winners = [];
  let remaining = pool.slice();
  for (let round = 0; round < winnersCount && remaining.length > 0; round++) {
    const totalTickets = remaining.reduce((s, uid) => s + (participants[uid].tickets !== undefined ? participants[uid].tickets : 1), 0);
    let r = Math.random() * totalTickets;
    let picked = remaining[0];
    for (const uid of remaining) {
      r -= (participants[uid].tickets !== undefined ? participants[uid].tickets : 1);
      if (r <= 0) { picked = uid; break; }
    }
    winners.push(picked);
    remaining = remaining.filter(uid => uid !== picked);
  }

  g.winnerIds = winners;
  g.winnerId = winners[0] || null; // сумісність зі старим кодом, що читає winnerId
  db.setGiveaway(gid, g);

  const summaryLines = [];
  for (const winnerId of winners) {
    const winner = db.getUser(winnerId);
    const app = db.addApplication({ uid: winnerId, tierId: g.tierId, status: 'pending', createdAt: Date.now(), source: 'giveaway' });
    const winnerText = buildText([tier.emojiKey, ' ' + t(winnerId).gaWin(tierName(g.tierId, getLang(winnerId)))]);
    await bot.telegram.sendMessage(winnerId, winnerText.text, { entities: winnerText.entities }).catch(() => {});
    summaryLines.push(`${winner.name || '—'} (${winner.username ? '@' + winner.username : '—'}) · id ${winnerId} · 🎫${participants[winnerId].tickets !== undefined ? participants[winnerId].tickets : 1} · заявка #${app.id}`);

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `${tier.emoji} Переможець розіграшу "${tier.name}"! Заявка #${app.id}\n` +
        `Ім'я: ${winner.name || '—'}\nUsername: ${winner.username ? '@' + winner.username : '—'}\nID: ${winnerId}\n` +
        `Квитків: ${participants[winnerId].tickets !== undefined ? participants[winnerId].tickets : 1}`,
        Markup.inlineKeyboard([[
          callbackBtn('Підтвердити', `admin_approve_${app.id}`, 'success', 'check'),
          callbackBtn('Відхилити', `admin_reject_${app.id}`, 'danger', 'redCircle'),
        ]])
      ).catch(() => {});
    }
  }

  if (ADMIN_CHAT_ID && winners.length > 1) {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `📋 Усі переможці розіграшу "${tier.name}" (${winners.length}):\n\n${summaryLines.join('\n\n')}`).catch(() => {});
  }

  for (const uid of pool) {
    if (winners.includes(uid)) continue;
    const loseText = buildText([tier.emojiKey, ' ' + t(uid).gaLose(tierName(g.tierId, getLang(uid)))]);
    await bot.telegram.sendMessage(uid, loseText.text, { entities: loseText.entities }).catch(() => {});
    await new Promise(r2 => setTimeout(r2, 60));
  }
}

// Спільний розіграш із партнерським каналом: умова — підписка на ОБИДВА канали,
// 4 переможці (2 видаєш ти, 2 — партнер, вирішуєте самі після розіграшу).
// Соло-розіграш (3x Мішка): постить красиво оформлений анонс ПРЯМО В КАНАЛ
// (бот має бути адміном каналу з правом постити) + розсилає всім у боті.
// Приклад використання: /giveaway_solo_start 21 00  (година хвилина дедлайну, Київ)
function buildSoloGiveawayAnnouncement(timeLabel) {
  const { text, entities } = buildText([
    'megaphone', ' ', { b: 'РОЗІГРАШ: 3x 🧸 МІШКА!' }, ' 🔥\n\n',
    'Три переможці, кожен отримає справжню ', { b: 'Мішку' }, '.\n\n',
    'almost', ' ', { b: 'Як брати участь:' }, '\n',
    '1️⃣ Тисни "Участь" нижче.\n',
    '2️⃣ Кожен ', { b: 'НОВИЙ' }, ' друг, якого запросиш після цього — ', { b: '+1 квиток' }, '.\n',
    '3️⃣ Постав реакцію на цей пост і надішли скрін боту — ', { b: '+1 квиток' }, ' (адмін підтвердить вручну).\n\n',
    'clockIcon', ` Дедлайн: ${timeLabel} (Київ)\n\n`,
    'warn', ' ', { i: "Обов'язково: юзернейм у Telegram і увімкнене отримання подарунків." },
  ]);
  const rows = [
    [callbackBtn('Участь', 'ga_join_ga_solo_bear', 'danger', 'teddyBear')],
    [callbackBtn('Надіслати доказ реакції (+1 квиток)', 'ga_proof_ga_solo_bear', 'primary', 'check')],
  ];
  return { text, entities, rows };
}

bot.command('giveaway_solo_start', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const hour = args[0] ? parseInt(args[0], 10) : 21;
  const minute = args[1] ? parseInt(args[1], 10) : 0;
  const endsAt = kyivTodayAt(hour, minute).getTime();
  if (endsAt <= Date.now()) return ctx.reply('⚠️ Цей час уже минув сьогодні. Формат: /giveaway_solo_start 21 00');

  const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  db.setGiveaway('ga_solo_bear', {
    tierId: 'bear', active: true, participants: {}, startedAt: Date.now(), endsAt, winnerId: null, winnersCount: 3,
  });
  scheduleGiveawayCheck('ga_solo_bear');

  const { text, entities, rows } = buildSoloGiveawayAnnouncement(timeLabel);

  // 1. Постимо прямо в канал (бот має бути адміном каналу з правом постити).
  try {
    await bot.telegram.sendMessage(CFG.CHANNEL_USERNAME, text, { entities, ...Markup.inlineKeyboard(rows) });
    await ctx.reply('✅ Пост опубліковано в каналі.');
  } catch (e) {
    await ctx.reply('⚠️ Не вдалось запостити в канал: ' + e.message + '\nПеревір, що бот — адмін каналу з правом постити.');
  }

  // 2. Розсилаємо всім, хто вже є в базі бота.
  let sent = 0;
  const users = Object.values(db.allUsers());
  for (const u of users) {
    if (!u.lang) continue;
    try {
      await bot.telegram.sendMessage(u.id, text, { entities, ...Markup.inlineKeyboard(rows) });
      sent++;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply(`✅ Розіслано ${sent} користувачам бота.`);
});

// Якщо пост у каналі випадково видалили (чи просто треба перепостити) — ця команда
// ЛИШЕ публікує той самий пост у канал ще раз. НЕ чіпає учасників, НЕ розсилає всім
// повторно, НЕ змінює дедлайн — розіграш триває з тим самим станом, що й був.
// Окремий пост + розсилка: за репост у канал з 35+ підписниками, АБО репост
// (пересилку) 3 друзям, які ЩЕ не беруть участі — +1 квиток (перевірка вручну,
// через скрін-доказ, той самий механізм, що й для реакції).
// Міні-пост про фічу "+2 квитки за тег у імені" — окремо, коротко.
// Швидкий FOMO-челендж: мінімалістичний пост у каналі з кнопкою-посиланням
// (не callback — гарантовано працює навіть для тих, хто ще не писав боту).
// Клік відкриває бота, бот питає пароль, перший, хто вгадав — забирає мішку.
const PASSWORD_CHALLENGE_PAYLOAD = 'freemishka';
const passwordGuessAt = new Map();   // uid -> час останньої спроби

// Мішка за реєстрацію в зовнішньому боті за реф-посиланням адміна (starscase тощо).
// Без формального розіграшу/квитків — просто перевірка скріном і пряма заявка.
const EXTERNAL_REF_POOL_CAP = 10;
const EXTERNAL_REF_WINNERS = 3;

// Математика: 2 випадкові позиції серед 1-9 (рівний шанс кожній) + позиція 10
// завжди виграє гарантовано (щоб усі 3 мішки точно розійшлись за 10 підтверджень).
function pickWinningPositions() {
  const pool9 = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const chosen = [];
  while (chosen.length < 2) {
    const idx = Math.floor(Math.random() * pool9.length);
    chosen.push(pool9.splice(idx, 1)[0]);
  }
  chosen.push(10); // гарантований переможець
  return chosen;
}

function externalRefStatusText(pool) {
  const count = (pool.participants || []).length;
  return buildText([
    'teddyBear', ' ', { b: 'ШАНС НА МІШКУ' }, '\n\n',
    'Перейди за посиланням, зроби скрін і надішли боту.\n\n',
    'almost', ' ', { b: `Приєднались: ${count}/${EXTERNAL_REF_POOL_CAP}` }, '\n',
    { b: `Отримано мішок: ${pool.wonCount || 0}/${EXTERNAL_REF_WINNERS}` }, '\n',
    { i: '10-й учасник гарантовано отримує мішку!' },
  ]);
}

bot.command('external_ref_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const link = ctx.message.text.split(' ')[1];
  if (!link) return ctx.reply('Формат: /external_ref_announce <посилання>\nНапр: /external_ref_announce https://t.me/starscase_robot?startapp=ref_6280327267');

  const pool = { active: true, poolCap: EXTERNAL_REF_POOL_CAP, winnersCount: EXTERNAL_REF_WINNERS, tierId: 'bear', participants: [], winningPositions: pickWinningPositions(), wonCount: 0, link };
  db.setExternalRefPool(pool);

  const { text, entities } = externalRefStatusText(pool);
  const rows = [
    [urlBtn('Перейти в бота', link, 'primary', 'lightning')],
    [callbackBtn('Приєднатись', 'ext_ref_join', 'danger', 'teddyBear')],
  ];

  let sent = 0;
  const users = Object.values(db.allUsers());
  for (const u of users) {
    if (!u.lang) continue;
    try { await bot.telegram.sendMessage(u.id, text, { entities, ...Markup.inlineKeyboard(rows) }); sent++; } catch (e) {}
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply(`✅ Розіслано ${sent} користувачам бота. Кнопка "🧸 Шанс на мішку" тепер з'явиться і в головному меню.`);
});

bot.action('ext_ref_join', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;

  const pool = db.getExternalRefPool();
  if (!pool || !pool.active) {
    const { text, entities } = buildText(['warn', ' ', { b: 'Ця можливість уже закрита' }, ' — стеж за наступною в каналі 👀']);
    await bot.telegram.sendMessage(uid, text, { entities }).catch(() => {});
    return;
  }
  if ((pool.participants || []).includes(uid)) {
    const { text, entities } = buildText(['check', ' ', { b: 'Ти вже в пулі!' }, ` Зараз приєдналось ${pool.participants.length}/${pool.poolCap} людей — очікуй результат.`]);
    await bot.telegram.sendMessage(uid, text, { entities }).catch(() => {});
    return;
  }
  db.upsertUser(uid, { awaitingProofFor: 'external:external_ref' });
  const { text, entities } = buildText([
    'teddyBear', ' ', { b: 'ШАНС НА МІШКУ — ІНСТРУКЦІЯ' }, '\n\n',
    '1️⃣ Тисни кнопку ', { b: '"Перейти в бота"' }, ' нижче — відкриється інший бот.\n',
    '2️⃣ Там просто натисни ', { code: '/start' }, ' — це і є реєстрація.\n',
    '3️⃣ Зроби ', { b: 'скріншот' }, ' екрану того бота (щоб було видно, що ти зайшов).\n',
    '4️⃣ Повернись у ', { b: 'цей' }, ' чат і надішли той скрін просто сюди (як звичайне фото).\n\n',
    'almost', ' ', { i: 'Після цього я передам скрін адміну — він перевірить і скаже, виграла ти мішку чи ні. Кожне підтвердження — це одразу реальний шанс, а не черга.' },
  ]);
  await bot.telegram.sendMessage(uid, text, {
    entities,
    ...Markup.inlineKeyboard([[urlBtn('Перейти в бота', pool.link, 'primary', 'lightning')]]),
  }).catch(() => {});
});

bot.command('password_challenge_start', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const password = args.join(' ').trim() || 'FREEMISHKAAA';

  db.setPasswordChallenge({ active: true, password, tierId: 'bear', winnerId: null, startedAt: Date.now() });

  const { text, entities } = buildText(['teddyBear', ' ', { b: 'Чек на мішку!' }]);
  const link = `https://t.me/${BOT_USERNAME}?start=${PASSWORD_CHALLENGE_PAYLOAD}`;

  try {
    await bot.telegram.sendMessage(CFG.CHANNEL_USERNAME, text, {
      entities,
      ...Markup.inlineKeyboard([[urlBtn('Отримати', link, 'danger', 'teddyBear')]]),
    });
    await ctx.reply(`✅ Пост опубліковано. Пароль: "${password}" — перший, хто введе правильно, забирає мішку.`);
  } catch (e) {
    await ctx.reply('⚠️ Не вдалось запостити: ' + e.message);
  }
});

bot.command('nametag_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const { text, entities } = buildText([
    'lightning', ' ', { b: 'ЛАЙФХАК НА +2 КВИТКИ' }, ' (без скрінів!) 🎫\n\n',
    'Додай ', { code: '@' + (BOT_USERNAME || 'StarForgeX_bot') }, ' у своє ім\'я в Telegram —\n',
    { b: 'бот сам побачить це' }, ' і нарахує ', { b: '+2 квитки' }, ' автоматично, щойно ти зайдеш у бота.\n\n',
    'warn', ' ', { i: 'Прибереш тег — квитки так само автоматично зніме. Тримай, поки триває розіграш 👀' },
  ]);

  try {
    await bot.telegram.sendMessage(CFG.CHANNEL_USERNAME, text, { entities });
    await ctx.reply('✅ Пост опубліковано в каналі.');
  } catch (e) {
    await ctx.reply('⚠️ Не вдалось запостити: ' + e.message);
  }

  let sent = 0;
  const users = Object.values(db.allUsers());
  for (const u of users) {
    if (!u.lang) continue;
    try { await bot.telegram.sendMessage(u.id, text, { entities }); sent++; } catch (e) {}
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply(`✅ Розіслано ${sent} користувачам бота.`);
});

bot.command('repost_ticket_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const activeGids = Object.keys(db.listGiveaways()).filter(id => db.getGiveaway(id).active);
  if (activeGids.length === 0) return ctx.reply('Немає активних розіграшів — спочатку запусти якийсь.');
  if (activeGids.length > 1) return ctx.reply(`Активних розіграшів декілька — вкажи ID першим аргументом.\nФормат: /repost_ticket_announce <ID>\nАктивні: ${activeGids.join(', ')}`);
  const gid = ctx.message.text.split(' ')[1] || activeGids[0];
  const g = db.getGiveaway(gid);
  if (!g) return ctx.reply(`Розіграш "${gid}" не знайдено.`);
  const tier = CFG.getTier(g.tierId);

  const { text, entities } = buildText([
    'megaphone', ' ', { b: 'ЩЕ ОДИН СПОСІБ ЗАРОБИТИ КВИТОК' }, ' 🎫\n\n',
    'Розповідай про розіграш ', tier.emojiKey, ' ', { b: tier.name }, ' друзям — і отримуй ', { b: '+1 квиток' }, '.\n\n',
    'Обери будь-який зі способів:\n\n',
    '✅ ', { b: 'Репост у канал/чат' }, '\n',
    { i: 'з 35+ підписниками' }, '\n\n',
    '✅ ', { b: 'Перешли 3 друзям' }, '\n',
    { i: 'які ще НЕ беруть участі в розіграші (усі 3 — одним скріном)' }, '\n\n',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n',
    'almost', ' ', { b: 'Далі:' }, ' надішли скрін-доказ боту кнопкою нижче — адмін перевірить вручну і зарахує квиток.',
  ]);

  const rows = [[callbackBtn('Надіслати доказ репосту', 'ga_proof_repost_' + gid, 'primary', 'check')]];

  try {
    await bot.telegram.sendMessage(CFG.CHANNEL_USERNAME, text, { entities, ...Markup.inlineKeyboard(rows) });
    await ctx.reply('✅ Пост опубліковано в каналі.');
  } catch (e) {
    await ctx.reply('⚠️ Не вдалось запостити в канал: ' + e.message);
  }

  let sent = 0;
  const users = Object.values(db.allUsers());
  for (const u of users) {
    if (!u.lang) continue;
    try {
      await bot.telegram.sendMessage(u.id, text, { entities, ...Markup.inlineKeyboard(rows) });
      sent++;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply(`✅ Розіслано ${sent} користувачам бота.`);
});

bot.command('giveaway_solo_repost', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const g = db.getGiveaway('ga_solo_bear');
  if (!g) return ctx.reply('Розіграш "ga_solo_bear" ще не запускався — спочатку /giveaway_solo_start 21 00.');

  const timeLabel = new Date(g.endsAt).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
  const { text, entities, rows } = buildSoloGiveawayAnnouncement(timeLabel);

  try {
    await bot.telegram.sendMessage(CFG.CHANNEL_USERNAME, text, { entities, ...Markup.inlineKeyboard(rows) });
    await ctx.reply('✅ Пост знову опубліковано в каналі. Учасники й дедлайн — без змін.');
  } catch (e) {
    await ctx.reply('⚠️ Не вдалось запостити: ' + e.message);
  }
});

// "Доказ реакції" — фото-скрін, який іде на ручну перевірку адміну.
bot.action(/^ga_proof_(ga_[a-z0-9_]+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  const gid = ctx.match[1];
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  db.upsertUser(uid, { awaitingProofFor: gid + ':reaction' });
  await bot.telegram.sendMessage(uid, '📸 Надішли сюди, в особисті боту, скріншот своєї реакції на пост (просто прикріпи фото).').catch(() => {});
});

bot.action(/^ga_proof_repost_(ga_[a-z0-9_]+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  const gid = ctx.match[1];
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  db.upsertUser(uid, { awaitingProofFor: gid + ':repost' });
  await bot.telegram.sendMessage(uid, '📸 Надішли сюди, в особисті боту, скріншот репосту (просто прикріпи фото).').catch(() => {});
});

const PROOF_TYPE_LABEL = { reaction: 'реакції', repost: 'репосту', external_ref: 'реєстрації за посиланням' };

bot.on('photo', async (ctx, next) => {
  const uid = String(ctx.from.id);
  const u = db.getUser(uid);
  if (!u || !u.awaitingProofFor) return next();

  const [gidOrMarker, proofType] = u.awaitingProofFor.split(':');
  db.upsertUser(uid, { awaitingProofFor: null });

  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // найбільший розмір
  const typeLabel = PROOF_TYPE_LABEL[proofType] || proofType;

  await ctx.reply('✅ Скрін отримано, передав адміну на перевірку.');

  if (!ADMIN_CHAT_ID) return;

  // Окремий випадок: доказ реєстрації в зовнішньому боті за реф-посиланням —
  // НЕ прив'язаний до квитків/розіграшу, а веде одразу до прямої заявки на приз.
  if (proofType === 'external_ref') {
    await bot.telegram.sendPhoto(ADMIN_CHAT_ID, photo.file_id, {
      caption: `📸 Доказ реєстрації за реф-посиланням (${gidOrMarker})\nВід: ${u.name || '—'} (${u.username ? '@' + u.username : 'без юзернейму'}) · id ${uid}`,
      ...Markup.inlineKeyboard([[
        callbackBtn('Підтвердити (дати мішку)', `extproof_ok_${uid}`, 'success', 'check'),
        callbackBtn('Відхилити', `extproof_no_${uid}`, 'danger', 'redCircle'),
      ]]),
    }).catch(() => {});
    return;
  }

  const gid = gidOrMarker;
  const g = db.getGiveaway(gid);
  const tier = g ? CFG.getTier(g.tierId) : null;

  await bot.telegram.sendPhoto(ADMIN_CHAT_ID, photo.file_id, {
    caption: `📸 Доказ ${typeLabel} для розіграшу "${tier ? tier.name : gid}"\nВід: ${u.name || '—'} (${u.username ? '@' + u.username : 'без юзернейму'}) · id ${uid}`,
    ...Markup.inlineKeyboard([[
      callbackBtn('Зарахувати +1 квиток', `proof_ok_${proofType}_${gid}_${uid}`, 'success', 'check'),
      callbackBtn('Відхилити', `proof_no_${proofType}_${gid}_${uid}`, 'danger', 'redCircle'),
    ]]),
  }).catch(() => {});
});

// "Зовнішній реферал" (starscase тощо) — кожне підтвердження одразу перевіряє,
// чи саме ЦЯ позиція (1-10) — виграшна. 2 позиції серед 1-9 обрані випадково
// заздалегідь (при старті пулу), позиція 10 — гарантований переможець завжди.
// Щоденна місія: реакція на пост у каналі + скрін-доказ -> +1 бонус-спін
// до щоденного колеса (не прив'язано до жодного розіграшу).
bot.action(/^extproof_ok_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const uid = ctx.match[1];

  const pool = db.getExternalRefPool();
  if (!pool || !pool.active) return ctx.reply('Пул уже закрито або ще не запускався.');
  if ((pool.participants || []).includes(uid)) return ctx.reply('Ця людина вже в пулі.');

  pool.participants = pool.participants || [];
  pool.participants.push(uid);
  const position = pool.participants.length;
  const isWinner = pool.winningPositions.includes(position);
  const tier = CFG.getTier(pool.tierId);

  if (isWinner) {
    pool.wonCount = (pool.wonCount || 0) + 1;
    const app = db.addApplication({ uid, tierId: pool.tierId, status: 'pending', createdAt: Date.now(), source: 'external_ref' });
    const winText = buildText([
      'lightning', ' ', { b: 'ОГО! ТИ ВИГРАВ(-ЛА)!! 🎉🎉🎉' }, '\n\n',
      tier.emojiKey, ' ', { b: tier.name }, ' твоя! Заявку вже передано адміну на розгляд.\n\n',
      { i: `Отримано мішок: ${pool.wonCount}/${pool.winnersCount}` },
    ]);
    await bot.telegram.sendMessage(uid, winText.text, { entities: winText.entities }).catch(() => {});
    if (ADMIN_CHAT_ID) {
      const w = db.getUser(uid);
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `${tier.emoji} Переможець "зовнішній реферал" (позиція ${position}/10)! Заявка #${app.id}\nІм'я: ${w.name || '—'}\nUsername: ${w.username ? '@' + w.username : 'без юзернейму'}\nID: ${uid}`,
        Markup.inlineKeyboard([[
          callbackBtn('Підтвердити', `admin_approve_${app.id}`, 'success', 'check'),
          callbackBtn('Відхилити', `admin_reject_${app.id}`, 'danger', 'redCircle'),
        ]])
      ).catch(() => {});
    }
    await ctx.reply(`🎉 ВИГРАШ! Позиція ${position}/10. Отримано мішок: ${pool.wonCount}/${pool.winnersCount}. Заявку #${app.id} створено.`);
  } else {
    const winText = buildText([
      { b: 'Нічого страшного! 😊' }, ` Цього разу без призу (позиція ${position}/10) — буде ще багато шансів.\n\n`,
      { i: `Отримано мішок: ${pool.wonCount || 0}/${pool.winnersCount}` },
    ]);
    await bot.telegram.sendMessage(uid, winText.text, { entities: winText.entities }).catch(() => {});
    await ctx.reply(`Без виграшу (позиція ${position}/10). Отримано мішок: ${pool.wonCount || 0}/${pool.winnersCount}.`);
  }

  if (position >= pool.poolCap) pool.active = false;
  db.setExternalRefPool(pool);
});

const awaitingExtProofRejectReason = new Map(); // adminChatId -> uid

bot.action(/^extproof_no_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  awaitingExtProofRejectReason.set(String(ctx.chat.id), ctx.match[1]);
  await ctx.reply('Напиши причину відхилення, або просто "-" якщо без причини.');
});

bot.action(/^proof_ok_(reaction|repost)_(ga_[a-z0-9_]+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const proofType = ctx.match[1];
  const gid = ctx.match[2];
  const uid = ctx.match[3];
  const g = db.getGiveaway(gid);
  if (!g) return ctx.reply('Розіграш не знайдено.');

  const participants = g.participants || {};
  if (!participants[uid]) participants[uid] = { tickets: 0, joinedAt: Date.now() };
  participants[uid].tickets = (participants[uid].tickets || 0) + 1;
  g.participants = participants;
  db.setGiveaway(gid, g);

  const typeLabel = PROOF_TYPE_LABEL[proofType] || proofType;
  await bot.telegram.sendMessage(uid, `✅ Твій доказ ${typeLabel} підтверджено — +1 квиток! Твоїх квитків тепер: ${participants[uid].tickets}.`).catch(() => {});
  await ctx.reply('✅ Квиток зараховано.');
});

// Відхилення доказу — теж просимо причину або "-" для без причини.
const awaitingProofRejectReason = new Map(); // adminChatId -> {proofType, gid, uid}

bot.action(/^proof_no_(reaction|repost)_(ga_[a-z0-9_]+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  awaitingProofRejectReason.set(String(ctx.chat.id), { proofType: ctx.match[1], gid: ctx.match[2], uid: ctx.match[3] });
  await ctx.reply('Напиши причину відхилення доказу, або просто "-" якщо без причини.');
});

bot.command('joint_giveaway_start', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!CFG.PARTNER_CHANNEL_USERNAME) return ctx.reply('⚠️ Спочатку встанови CFG.PARTNER_CHANNEL_USERNAME у config.js.');

  const endsAt = kyivTodayAt(20, 0).getTime(); // дедлайн сьогодні 20:00 — зміни в коді за потреби
  if (endsAt <= Date.now()) return ctx.reply('⚠️ 20:00 за Києвом вже минуло сьогодні.');

  db.setGiveaway('ga_joint_bear', {
    tierId: 'bear', active: true, participants: {}, startedAt: Date.now(), endsAt,
    winnerId: null, winnersCount: 4, requireChannels: [CFG.CHANNEL_USERNAME, CFG.PARTNER_CHANNEL_USERNAME],
  });
  scheduleGiveawayCheck('ga_joint_bear');

  await ctx.reply(`📣 Розсилаю спільний розіграш (4x Мішка, підписка на два канали) усім користувачам...`);
  let sent = 0;
  const users = Object.values(db.allUsers());
  for (const u of users) {
    if (!u.lang) continue;
    const T = t(u.id);
    const link = `https://t.me/${BOT_USERNAME}?start=ref_${u.id}`;
    const { text, entities } = buildText([
      'teddyBear', ' ', { b: 'СПІЛЬНИЙ РОЗІГРАШ: 4x МІШКА!' }, ' 🔥\n\n',
      'Розігруємо разом із ', { code: CFG.PARTNER_CHANNEL_USERNAME }, ' — 4 переможці, кожен отримає 🧸 Мішку.\n\n',
      'warn', ' ', { b: "Обов'язкова умова:" }, ' підписка на ОБИДВА канали:\n',
      '1️⃣ ', { code: CFG.CHANNEL_USERNAME }, '\n',
      '2️⃣ ', { code: CFG.PARTNER_CHANNEL_USERNAME }, '\n\n',
      'clockIcon', ' Дедлайн: 20:00 (Київ)\n\n',
      ...T.conditionsNote(),
    ]);
    try {
      await bot.telegram.sendMessage(u.id, text, {
        entities,
        ...Markup.inlineKeyboard([[callbackBtn('Участь', 'ga_join_ga_joint_bear', 'danger', 'teddyBear')]]),
      });
      sent++;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply(`✅ Розіслано ${sent} користувачам.`);
});

bot.command('giveaway_start', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const endsAt = kyivTodayAt(17, 45).getTime();
  if (endsAt <= Date.now()) return ctx.reply('⚠️ 17:45 за Києвом вже минуло сьогодні.');

  for (const def of LIVE_GIVEAWAYS) {
    db.setGiveaway(def.id, { tierId: def.tierId, active: true, participants: {}, startedAt: Date.now(), endsAt, winnerId: null });
    scheduleGiveawayCheck(def.id);
  }

  await ctx.reply('📣 Розсилаю розіграш "Подарунок" усім користувачам...');
  const sent = await broadcastGiveaways('17:45');
  await ctx.reply(`✅ Розіслано ${sent} користувачам.`);
});

// Прибрати N квитків у людини. Формати:
//   /deleteticket @username 4                 — якщо активний лише 1 розіграш
//   /deleteticket ga_solo_bear @username 4     — якщо активних декілька, вкажи ID
bot.command('deleteticket', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  let gid, usernameArg, amountArg;
  if (args.length === 3) { [gid, usernameArg, amountArg] = args; }
  else if (args.length === 2) { [usernameArg, amountArg] = args; }
  else return ctx.reply('Формат: /deleteticket [ID_розіграшу] @username кількість\nНапр: /deleteticket @ivan123 4');

  const amount = parseInt(amountArg, 10);
  if (isNaN(amount) || amount <= 0) return ctx.reply('Кількість має бути додатним числом.');

  const username = usernameArg.replace('@', '').toLowerCase();
  const targetUser = Object.values(db.allUsers()).find(u => u.username && u.username.toLowerCase() === username);
  if (!targetUser) return ctx.reply(`Юзера @${username} не знайдено в базі.`);

  let targetGid = gid;
  if (!targetGid) {
    const activeGids = Object.keys(db.listGiveaways()).filter(id => db.getGiveaway(id).active);
    if (activeGids.length === 0) return ctx.reply('Немає активних розіграшів.');
    if (activeGids.length > 1) return ctx.reply(`Активних розіграшів декілька — вкажи ID: ${activeGids.join(', ')}\nФормат: /deleteticket <ID> @username кількість`);
    targetGid = activeGids[0];
  }

  const g = db.getGiveaway(targetGid);
  if (!g) return ctx.reply(`Розіграш "${targetGid}" не знайдено.`);
  const participants = g.participants || {};
  if (!participants[targetUser.id]) return ctx.reply(`Юзер @${username} не бере участі в розіграші "${targetGid}".`);

  const before = participants[targetUser.id].tickets !== undefined ? participants[targetUser.id].tickets : 1;
  participants[targetUser.id].tickets = Math.max(0, before - amount);
  g.participants = participants;
  db.setGiveaway(targetGid, g);

  await ctx.reply(`✅ @${username} у "${targetGid}": було ${before} квитків, забрано ${amount}, лишилось ${participants[targetUser.id].tickets}.`);
});

bot.command('giveaway_stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterGid = ctx.message.text.split(' ')[1]; // напр. /giveaway_stats ga_solo_bear
  const all = db.listGiveaways();
  const ids = filterGid ? (all[filterGid] ? [filterGid] : []) : Object.keys(all);
  if (!ids.length) return ctx.reply(filterGid ? `Розіграш "${filterGid}" не знайдено.` : 'Розіграшів ще не було.');

  let text = '';
  for (const gid of ids) {
    const g = all[gid];
    const tier = CFG.getTier(g.tierId);
    const participants = g.participants || {};
    const uids = Object.keys(participants);
    const status = g.active ? '🟢 Активний' : (g.winnerId ? '✅ Завершено' : '⏹ Завершено (без переможця)');
    text += `${tier.emoji} ${tier.name} (${gid}) — ${status}\n👥 Учасників: ${uids.length}\n`;
    uids.forEach((uid, i) => {
      const u = db.getUser(uid);
      const uname = u && u.username ? '@' + u.username : '⚠️ без юзернейму';
      const tickets = participants[uid].tickets !== undefined ? participants[uid].tickets : 1;
      text += `  ${i + 1}. ${(u && u.name) || '—'} (${uname}) · id ${uid} · 🎫${tickets}${g.winnerId === uid ? ' 🏆' : ''}\n`;
    });
    text += '\n';
  }
  while (text.length > 0) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

bot.action(/^ga_join_(ga_[a-z0-9_]+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  const gid = ctx.match[1];
  const g = db.getGiveaway(gid);
  const tier = g ? CFG.getTier(g.tierId) : null;
  const T = t(uid);
  const localName = tier ? tierName(g.tierId, getLang(uid)) : '';

  if (!g || !g.active || Date.now() >= g.endsAt) return ctx.answerCbQuery(T.gaFinished());

  // Якщо в цього розіграшу є вимога підписки на кілька каналів (спільний
  // розіграш із партнером) — перевіряємо ВСІ, перш ніж дозволити участь.
  if (g.requireChannels && g.requireChannels.length) {
    for (const channelUsername of g.requireChannels) {
      const subscribed = await checkChannelSubscription(channelUsername, uid);
      if (subscribed !== true) {
        await ctx.answerCbQuery();
        await bot.telegram.sendMessage(uid, `⚠️ Для участі потрібна підписка на ${channelUsername} — перевір і спробуй ще раз.`).catch(() => {});
        return;
      }
    }
  }

  const participants = g.participants || {};
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
  const shareText = encodeURIComponent(T.shareMessage);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${shareText}`;

  if (participants[uid]) {
    await ctx.answerCbQuery();
    const deadlineLocale = getLang(uid) === 'en' ? 'en-GB' : getLang(uid) === 'ru' ? 'ru-RU' : 'uk-UA';
    const deadlineLabel = new Date(g.endsAt).toLocaleTimeString(deadlineLocale, { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    const statusText = buildText([
      tier.emojiKey, ' ' + T.gaAlreadyJoined(localName), '\n\n',
      { b: T.gaYourTickets(participants[uid].tickets !== undefined ? participants[uid].tickets : 1) }, '\n',
      T.gaDeadlineIs(deadlineLabel), '\n\n',
      { i: T.gaMoreTicketsHint }, '\n\n',
      { b: T.linkLabel }, '\n', { code: link },
    ]);
    await bot.telegram.sendMessage(uid, statusText.text, {
      entities: statusText.entities,
      ...Markup.inlineKeyboard([
        [urlBtn(T.btnShareOneTap, shareUrl, 'success', 'lightning')],
        [callbackBtn('Надіслати доказ реакції', 'ga_proof_' + gid, 'primary', 'check')],
        [callbackBtn('Надіслати доказ репосту', 'ga_proof_repost_' + gid, 'primary', 'megaphone')],
      ]),
    }).catch(() => {});
    await sendBackKeyboard(uid);
    return;
  }

  const uObj = db.getUser(uid);
  const startTickets = (uObj && uObj.hasNameTag) ? 3 : 1; // база 1 + бонус 2, якщо тег вже є в імені
  participants[uid] = { tickets: startTickets, joinedAt: Date.now() };
  g.participants = participants;
  db.setGiveaway(gid, g);

  await ctx.answerCbQuery('✅');
  const deadlineLocale = getLang(uid) === 'en' ? 'en-GB' : getLang(uid) === 'ru' ? 'ru-RU' : 'uk-UA';
  const deadlineLabel = new Date(g.endsAt).toLocaleTimeString(deadlineLocale, { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
  const joinText = buildText([
    tier.emojiKey, ' ' + T.gaJoined(localName), '\n\n',
    { b: T.gaYourTickets(startTickets) }, startTickets > 1 ? ' 🎉 (+2 за тег у імені)' : '', '\n',
    T.gaDeadlineIs(deadlineLabel), '\n\n',
    { i: T.gaMoreTicketsHint }, '\n\n',
    { b: T.linkLabel }, '\n', { code: link },
  ]);
  await bot.telegram.sendMessage(uid, joinText.text, {
    entities: joinText.entities,
    ...Markup.inlineKeyboard([
      [urlBtn(T.btnShareOneTap, shareUrl, 'success', 'lightning')],
      [callbackBtn('Надіслати доказ реакції', 'ga_proof_' + gid, 'primary', 'check')],
      [callbackBtn('Надіслати доказ репосту', 'ga_proof_repost_' + gid, 'primary', 'megaphone')],
    ]),
  }).catch(() => {});
  await sendBackKeyboard(uid);
});

// ---------------------------------------------------------------------------
// WebApp: колесо удачі — окремий HTTP-сервер поверх бота.
// ---------------------------------------------------------------------------
// Перевірка Telegram.WebApp initData: HMAC-SHA256 підпис від бота.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// Додатково: порівняння за сталий час (без витоку через таймінг) і термін
// придатності — раніше один раз перехоплений initData діяв вічно.
const WEBAPP_SECRET = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
const INITDATA_MAX_AGE_SEC = (function () {
  const v = parseInt(process.env.INITDATA_MAX_AGE_SEC, 10);
  return Number.isFinite(v) && v >= 0 ? v : 7 * 86400;   // 0 — без обмеження
})();

function verifyInitData(initData) {
  try {
    if (!initData || typeof initData !== 'string' || initData.length > 8192) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
    params.delete('hash');

    const pairs = [];
    for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const computed = crypto.createHmac('sha256', WEBAPP_SECRET).update(dataCheckString).digest();
    const given = Buffer.from(hash, 'hex');
    if (given.length !== computed.length || !crypto.timingSafeEqual(given, computed)) return null;

    if (INITDATA_MAX_AGE_SEC) {
      const authDate = parseInt(params.get('auth_date'), 10) || 0;
      if (!authDate || Date.now() / 1000 - authDate > INITDATA_MAX_AGE_SEC) return null;
    }

    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user || !user.id) return null;
    return String(user.id);
  } catch (e) {
    return null;
  }
}

// Той самий ваговий механізм, що й у mockup — тепер джерело правди тут,
// на сервері, клієнт лише візуалізує результат.
// Спеціальні призи (не "зірки") — рахуються як окремі рівні з config.js.
// Кожен NFT — ОКРЕМИЙ приз зі своєю (дуже малою) вагою, не один загальний "джекпот".
const SPECIAL_OUTCOME_IDS = ['gift', 'rocket', 'trophy', 'premium3m', 'wheel_eye', 'wheel_stocking', 'wheel_snake', 'wheel_lolpop'];

const WHEEL_CONFIGS = {
  daily: {
    cost: 0,
    weights: {
      // 1⭐ прибрано зовсім: воно випадало в половині спінів і перетворювало
      // захід у бота на «нічого не сталось». Тепер мінімум 2⭐, а 27% спінів
      // дають БІЛЕТИ — вони йдуть у банк і в реф-колесо, тож кожен результат
      // щось означає. Вартість для бота майже не змінилась: 3.61 проти 3.34.
      star2: 300, star3: 300, star5: 90, star8: 22, star12: 6, star25: 1.5,
      tix1: 180, tix3: 75, tix5: 20,
      gift: 2.2, rocket: 1.1, trophy: 0.45, wheel_stocking: 0.65, wheel_snake: 0.65, wheel_lolpop: 0.45, wheel_eye: 0.22, premium3m: 0.07,
    },
  },
  referral: {
    cost: 0,
    unlockEvery: 5,
    weights: {
      star2: 400, star3: 250, star5: 150, star7: 60, star10: 20, star15: 8,
      gift: 4, rocket: 2, trophy: 0.9, wheel_stocking: 1.4, wheel_snake: 1.4, wheel_lolpop: 1, wheel_eye: 0.5, premium3m: 0.15,
    },
  },
  paid: {
    cost: 15,
    weights: {
      star5: 520, star7: 230, star10: 120, star15: 40, star25: 12, star50: 3,
      gift: 5, rocket: 2, trophy: 0.9, wheel_stocking: 1.3, wheel_snake: 1.3, wheel_lolpop: 0.9, wheel_eye: 0.4, premium3m: 0.12,
    },
  },
  // Колесо за РЕАЛЬНІ Telegram Stars (25⭐ за спін, оплата інвойсом, не з
  // внутрішнього балансу) — тому й шанси на спецпризи тут найщедріші.
  // ВИМКНЕНО: колесо за 25 реальних зірок прибрано за рішенням адміна.
  // Конфіг лишено, щоб історія спінів і старі кнопки не падали.
  premium: {
    disabled: true,
    cost: 0,
    realStarsCost: 25,
    weights: {
      star5: 300, star10: 220, star15: 150, star20: 90, star30: 40, star50: 14,
      gift: 9, rocket: 5, trophy: 3, wheel_stocking: 4, wheel_snake: 4, wheel_lolpop: 3, wheel_eye: 1.6, premium3m: 0.6,
    },
  },
};

// ---------------------------------------------------------------------------
// ГАРАНТІЇ (pity): стеля невдач. Лічильник росте з кожним спіном без призу
// і обнуляється, коли приз випав сам. На безкоштовних колесах гарантується
// лише подарунок — гарантія NFT там зруйнувала б економіку.
const PITY = {
  daily:    { gift: 50, nft: null },
  referral: { gift: 40, nft: null },
  paid:     { gift: 30, nft: 100 },
  premium:  { gift: 15, nft: 50 },
};
const GIFT_TIER_IDS = ['gift', 'rocket', 'trophy'];
const WHEEL_NFT_IDS = ['wheel_stocking', 'wheel_snake', 'wheel_lolpop', 'wheel_eye'];

// ЩАСЛИВА ГОДИНА: щодня одна випадкова година з подвоєними шансами на NFT.
function getHappyHour() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const flags = db.getFeatureFlags() || {};
  if (flags.happyHourDate === todayStr && typeof flags.happyHourUTC === 'number') {
    return { date: todayStr, hourUTC: flags.happyHourUTC };
  }
  // Обираємо годину в межах 9:00-21:00 за Києвом (UTC+3 узимку/+3 влітку —
  // беремо UTC 6..18, щоб не потрапити на ніч).
  const hourUTC = 6 + Math.floor(Math.random() * 13);
  db.setFeatureFlags({ happyHourDate: todayStr, happyHourUTC: hourUTC });
  return { date: todayStr, hourUTC };
}

function isHappyHourNow() {
  return new Date().getUTCHours() === getHappyHour().hourUTC;
}

// Під час щасливої години ваги NFT подвоюються.
function applyHappyHour(weights) {
  if (!isHappyHourNow()) return weights;
  const out = { ...weights };
  for (const id of WHEEL_NFT_IDS) if (out[id]) out[id] *= 2;
  return out;
}

function weightedPickServer(weights) {
  let total = 0;
  const keys = Object.keys(weights);
  for (const k of keys) total += weights[k];
  let r = Math.random() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Railway стоїть за проксі — інакше req.ip у всіх однаковий

// Стиснення: сторінка застосунку — сотні КБ тексту, gzip зменшує її в рази.
try { app.use(require('compression')()); } catch (e) { console.warn('ℹ️ compression не встановлено — відповіді без стиснення'); }

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

// Великі тіла потрібні лише для скріна-доказу. Раніше будь-який запит міг
// принести 10 МБ JSON — і сервер чесно парсив його в пам'ять.
app.use('/api/task-proof', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '64kb' }));

// Грубий захист від флуду: не більше API_RATE запитів на хвилину з однієї
// адреси. Звичайний гравець робить кілька десятків — ліміт із великим запасом.
const API_RATE = Math.max(60, parseInt(process.env.API_RATE_PER_MIN, 10) || 600);
const apiHits = new Map();   // ip -> { n, at }
setInterval(() => { const now = Date.now(); for (const [k, v] of apiHits) if (now - v.at > 60000) apiHits.delete(k); }, 60000).unref();
app.use('/api/', (req, res, next) => {
  const ip = req.ip || 'x';
  const now = Date.now();
  let h = apiHits.get(ip);
  if (!h || now - h.at > 60000) { h = { n: 0, at: now }; apiHits.set(ip, h); }
  if (++h.n > API_RATE) return res.status(429).json({ error: 'rate_limited' });
  next();
});

// Техроботи «full» блокують будь-які дії в застосунку і на сервері, а не лише
// екраном у браузері: раніше спін чи ставку можна було зробити прямим запитом.
app.use('/api/', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const m = maintState();
  if (m.mode !== 'full') return next();
  const uid = verifyInitData((req.body || {}).initData);
  if (uid && isAdminUid(uid)) return next();
  return res.status(503).json({ error: 'maintenance', message: m.text });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round((Date.now() - BOOT_AT) / 1000), bot: !!BOT_USERNAME }));

// Картинки призів — окремими файлами з кешем на тиждень.
app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '7d', fallthrough: false }));

// Блокування одночасних дій з балансом одного юзера (закриває дірку: подав
// заявку на вивід і одночасно крутить колесо — без цього можлива гонка,
// де обидві дії читають "старий" баланс і одна перезаписує іншу).
const balanceLocks = new Set();

// Журнал спінів колеса — у базі даних, тож переживає перезапуск сервера.
// Відкриття колеса більше НЕ пишемо: вони займали більшість із 500 місць
// журналу й витісняли реальні спіни, за якими шукаються зловживання.
function logWheelEvent(uid, wheel, kind, extra) {
  const u = db.getUser(uid);
  db.addWheelLogEvent({
    ts: Date.now(), uid, wheel, kind,
    name: u ? u.name : '—', username: u ? u.username : null,
    extra: extra || null,
  });
}
// Версія застосунку — читаємо прямо з wheel.html, тож вона завжди збігається
// з тим, що реально залито. Застосунок звіряє її й сам оновлюється зі старого кешу.
let APP_BUILD = null;
try {
  const m = fs.readFileSync(path.join(__dirname, 'wheel.html'), 'utf8').match(/var APP_BUILD = '([^']+)'/);
  APP_BUILD = m ? m[1] : null;
  console.log('📦 Версія застосунку:', APP_BUILD);
} catch (e) {}

app.get('/wheel.html', (req, res) => {
  // Telegram WebView кешує сторінку дуже агресивно — люди тижнями бачать
  // стару версію після оновлення. Тому кеш дозволено лише з обов'язковою
  // перевіркою: незмінена сторінка приходить як 304 без тіла, змінена — одразу нова.
  res.set({
    'Cache-Control': 'no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  res.sendFile(path.join(__dirname, 'wheel.html'));
});

app.get('/', (req, res) => {
  res.redirect('/wheel.html');
});

// Фото профілю Telegram передає в даних запуску лише тоді, коли людина
// дозволила його показувати. Запам'ятовуємо, щоб показувати в лізі.
function rememberPhoto(initData, uid) {
  try {
    const raw = new URLSearchParams(initData).get('user');
    if (!raw) return;
    const tu = JSON.parse(raw);
    const photo = tu && typeof tu.photo_url === 'string' && /^https:\/\//.test(tu.photo_url) ? tu.photo_url : null;
    const u = db.getUser(uid) || {};
    if (u.photo !== photo) db.upsertUser(uid, { photo });
  } catch (e) {}
}

app.get('/api/wheel-status', async (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  rememberPhoto(req.query.initData, uid);
  res.set('X-App-Build', APP_BUILD || '');

  // Дірка: людина могла відкрити колесо, не підписавшись на канал.
  // Перевіряємо так само, як і в самому боті.
  const subscribed = await checkChannelSubscription(CFG.CHANNEL_USERNAME, uid);
  if (subscribed !== true) return res.status(403).json({ error: 'not_subscribed', channel: CFG.CHANNEL_USERNAME, channelUrl: CFG.CHANNEL_URL });

  const u = db.getUser(uid) || {};
  const refCount = (u.invitedIds || []).length;
  // Колесо «За білети» відкривають БІЛЕТИ (саме їх списує /api/spin), а не
  // кількість друзів. Раніше застосунок рахував друзів і блокував кнопку
  // людям, у яких білети були — з промокодів, чату чи банку.
  const tickets = ticketsOf(u);
  const availableRefSpins = Math.floor(tickets / TICKETS_PER_SPIN);
  const referralUnlocked = availableRefSpins > 0;
  const lang = u.lang || 'uk';

  const canSpinFreeToday = !u.lastDailySpinAt || (Date.now() - u.lastDailySpinAt >= 86400000);
  const nextDailySpinAt = canSpinFreeToday ? null : (u.lastDailySpinAt + 86400000);

  // Особиста історія — з запису гравця, а не з загального журналу на 500
  // подій, звідки її витісняли чужі спіни.
  const myHistory = (u.spinHistory || [])
    .filter(h => h.w && h.w !== 'risk')
    .slice(-6)
    .map(h => ({ outcomeId: h.id, isSpecial: !!h.sp }));

  res.json({
    build: APP_BUILD,
    autoPct: Math.max(0, Math.min(100, (((db.getFeatureFlags() || {}).autowd || {}).pct) || 0)),
    chatLevel: (function () { try { return chat.levelInfo(u.chatPts || 0); } catch (e) { return null; } })(),
    balance: u.starBalance || 0,
    lang,
    referral: { unlocked: referralUnlocked, progress: tickets % TICKETS_PER_SPIN, need: TICKETS_PER_SPIN, available: availableRefSpins, refCount: refCount, tickets },
    dailyStreak: u.dailyStreak || 0,
    paidSpinsTotal: u.paidSpinsTotal || 0,
    paidSpinsGifted: u.paidSpinsGifted || 0,
    depositCount: u.depositCount || 0,
    depositBonusLeft: Math.max(0, DEPOSIT_BONUS_TIMES - (u.depositCount || 0)),
    showFeaturePopup: (u.featurePopupVer || 0) < FEATURE_VERSION,
    earnTab: (function () { const t = earnTabState(); return { active: t.active, endsAt: t.endsAt }; })(),
    earnLink: EARN_CHANNEL_LINK,
    earnContact: EARN_CONTACT,
    goal: (function () {
      const g = getGoal();
      return { count: g.count, target: GOAL_TARGET, done: g.done,
               joined: g.participants.includes(uid), participants: g.participants.length,
               prize: CFG.getTier(GOAL_PRIZE_TIER).name };
    })(),
    withdrawMin: APP_WITHDRAW_MIN,
    withdrawNeedRefs: STAR_WITHDRAW_MIN_REFERRALS,
    withdrawHaveRefs: (u.invitedIds || []).length,
    withdrawHasApproved: db.listApplications('approved').some(a => a.uid === uid),
    withdrawFeePercent: APP_WITHDRAW_FEE_PERCENT,
    hasUsername: !!u.username,
    premiumSpins: u.premiumSpinsAvailable || 0,
    tickets: ticketsOf(u),
    ticketsPerSpin: TICKETS_PER_SPIN,
    freeSpins: u.freeSpins || 0,
    // Адмін заходить у застосунок під час техробіт як завжди — інакше
    // неможливо перевірити те, що ти щойно полагодив.
    maintenance: (function () {
      const mt = maintState();
      if (isAdminUid(uid) && mt.mode !== 'off') {
        return { mode: 'off', adminBypass: true, realMode: mt.mode, text: mt.text, until: mt.until, left: mt.left };
      }
      return mt;
    })(),
    pass: pass.view(pass.ensure(u, Date.now()), Date.now()),
    pity: (function () {
      const out = {};
      for (const [w, cfgP] of Object.entries(PITY)) {
        const g = (u.pityGift && u.pityGift[w]) || 0;
        const n = (u.pityNft && u.pityNft[w]) || 0;
        out[w] = {
          giftLeft: cfgP.gift ? Math.max(1, cfgP.gift - g) : null,
          nftLeft: cfgP.nft ? Math.max(1, cfgP.nft - n) : null,
        };
      }
      return out;
    })(),
    happyHour: (function () {
      const hh = getHappyHour();
      return { hourUTC: hh.hourUTC, active: isHappyHourNow() };
    })(),
    premiumSpinCost: WHEEL_CONFIGS.premium.realStarsCost,
    canSpinFreeToday,
    nextDailySpinAt,
    history: myHistory,
  });
});

// Мінімальний інтервал між спінами одного юзера — захист від автокліку
// і від паралельних запитів, які прослизали повз balanceLocks.
const lastSpinAt = new Map();
const MIN_SPIN_GAP_MS = (function () {
  const v = parseInt(process.env.SPIN_MIN_GAP_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 1500;
})();

app.post('/api/spin', async (req, res) => {
  const { initData, wheel } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const cfg = Object.prototype.hasOwnProperty.call(WHEEL_CONFIGS, wheel) ? WHEEL_CONFIGS[wheel] : null;
  if (!cfg) return res.status(400).json({ error: 'unknown wheel' });
  if (cfg.disabled) return res.status(410).json({ error: 'wheel_disabled' });

  // Дірка: спін без підписки на канал.
  const subscribed = await checkChannelSubscription(CFG.CHANNEL_USERNAME, uid);
  if (subscribed !== true) return res.status(403).json({ error: 'not_subscribed', channel: CFG.CHANNEL_USERNAME, channelUrl: CFG.CHANNEL_URL });

  // Занадто часті спіни — це подвійний тап або автоклік. Відхиляємо тихо,
  // щоб паралельні запити не списували баланс двічі.
  const prevSpin = lastSpinAt.get(uid) || 0;
  if (Date.now() - prevSpin < MIN_SPIN_GAP_MS) {
    return res.status(429).json({ error: 'too_fast' });
  }

  // Дірка: паралельні запити (вивід + спін одночасно) могли гонити баланс.
  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  lastSpinAt.set(uid, Date.now());

  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found — /start бота спочатку' });

    // ── 1. ПЕРЕВІРКИ. Нічого не списуємо, доки не впевнені, що спін буде.
    // Раніше списання (білети, кулдаун) йшло впереміш із перевірками, і
    // невдала перевірка посередині лишала людину без ресурсу й без спіну.
    const now = Date.now();
    const balance = u.starBalance || 0;
    const spinCost = Math.max(0, cfg.cost || 0);
    const gifted = u.paidSpinsGifted || 0;
    const useGift = wheel === 'paid' && gifted > 0;
    let useFreeSpin = false;

    if (wheel === 'premium' && (u.premiumSpinsAvailable || 0) <= 0) {
      return res.status(402).json({ error: 'no_premium_spins', realStarsCost: WHEEL_CONFIGS.premium.realStarsCost });
    }
    if (wheel === 'referral') {
      // Колесо БІЛЕТІВ: 5 білетів за спін, звідки б вони не прийшли.
      const have = ticketsOf(u);
      if (have < TICKETS_PER_SPIN) return res.status(403).json({ error: 'not_enough_tickets', have, need: TICKETS_PER_SPIN });
    }
    if (wheel === 'daily') {
      const canSpinFree = !u.lastDailySpinAt || (now - u.lastDailySpinAt >= 86400000);
      if (!canSpinFree) {
        // Бонусні безкоштовні спіни обходять добовий кулдаун, але серію не рухають.
        if ((u.freeSpins || 0) > 0) useFreeSpin = true;
        else return res.status(429).json({ error: 'daily_cooldown', nextSpinAt: u.lastDailySpinAt + 86400000 });
      }
    }
    if (!useGift && spinCost > balance) {
      return res.status(402).json({ error: 'not enough stars', balance, cost: spinCost });
    }

    // ── 2. СПИСАННЯ.
    const patch = {};
    let streakBonus = 0;
    let currentStreak = u.dailyStreak || 0;
    if (wheel === 'premium') patch.premiumSpinsAvailable = (u.premiumSpinsAvailable || 0) - 1;
    if (wheel === 'referral') patch.ticketsUsed = (u.ticketsUsed || 0) + TICKETS_PER_SPIN;
    if (useGift) patch.paidSpinsGifted = gifted - 1;
    if (wheel === 'daily') {
      if (useFreeSpin) {
        patch.freeSpins = (u.freeSpins || 0) - 1;
      } else {
        // Серія: попередній спін 24–48 год тому — «наступний день поспіль».
        const gapOk = u.lastDailySpinAt && (now - u.lastDailySpinAt < 172800000);
        currentStreak = gapOk ? (u.dailyStreak || 0) + 1 : 1;
        patch.lastDailySpinAt = now;
        patch.dailyStreak = currentStreak;
        // Сходинкові нагороди за серію — головний стимул повертатись щодня.
        if (currentStreak % 30 === 0) streakBonus = 10;
        else if (currentStreak % 14 === 0) streakBonus = 5;
        else if (currentStreak % 7 === 0) streakBonus = 3;
        else if (currentStreak % 3 === 0) streakBonus = 1;
      }
    }
    const paidStars = useGift ? 0 : spinCost;

    // ── 3. РЕЗУЛЬТАТ. Лічильники гарантій для цього колеса.
    const pityCfg = PITY[wheel] || { gift: null, nft: null };
    const pityGift = (u.pityGift && u.pityGift[wheel]) || 0;
    const pityNft = (u.pityNft && u.pityNft[wheel]) || 0;

    let outcomeId;
    if (pityCfg.nft && pityNft + 1 >= pityCfg.nft) {
      outcomeId = WHEEL_NFT_IDS[crypto.randomInt(WHEEL_NFT_IDS.length)];
    } else if (pityCfg.gift && pityGift + 1 >= pityCfg.gift) {
      outcomeId = GIFT_TIER_IDS[crypto.randomInt(GIFT_TIER_IDS.length)];
    } else {
      outcomeId = weightedPickServer(applyHappyHour(cfg.weights));
    }

    const isSpecial = SPECIAL_OUTCOME_IDS.includes(outcomeId);
    const isTix = isTixId(outcomeId);
    // ТУТ БУВ БАГ, ЧЕРЕЗ ЯКИЙ ВИСІЛО ~27% ЩОДЕННИХ СПІНІВ: amount була const,
    // а білетна гілка робила amount = 0 → TypeError уже ПІСЛЯ списання
    // кулдауну. Людина втрачала спін, застосунок не отримував відповіді,
    // а статистика й гарантії не оновлювались.
    const amount = (isSpecial || isTix) ? 0 : (parseInt(String(outcomeId).replace('star', ''), 10) || 0);
    const wonTickets = isTix ? (parseInt(String(outcomeId).slice(3), 10) || 1) : 0;

    let appId = null;
    const finalBalance = Math.round((balance - paidStars + amount + streakBonus) * 100) / 100;
    patch.starBalance = finalBalance;

    // Гарантії: обнуляємо той лічильник, приз якого щойно випав.
    patch.pityGift = { ...(u.pityGift || {}), [wheel]: GIFT_TIER_IDS.includes(outcomeId) ? 0 : pityGift + 1 };
    patch.pityNft = { ...(u.pityNft || {}), [wheel]: WHEEL_NFT_IDS.includes(outcomeId) ? 0 : pityNft + 1 };

    // Ризикнути можна лише щойно виграними зірками.
    const spinStartedAt = now;
    patch.pendingRisk = (!isSpecial && amount > 0)
      ? { amount, streak: 0, at: spinStartedAt, spinAt: spinStartedAt }
      : null;

    // Статистика для профілю.
    const isPaid = wheel === 'paid' || wheel === 'premium';
    const prizeValue = isSpecial ? (CFG.getTier(outcomeId).priceStars || 0) : amount;
    const best = u.bestWin || { value: 0, outcomeId: null, at: 0 };
    patch.paidSpinsTotal = (u.paidSpinsTotal || 0) + (isPaid ? 1 : 0);
    patch.spinsTotal = (u.spinsTotal || 0) + 1;
    patch.starsEarnedTotal = Math.round(((u.starsEarnedTotal || 0) + amount + streakBonus) * 100) / 100;
    patch.starsSpentTotal = (u.starsSpentTotal || 0) + paidStars;
    patch.ticketsWonTotal = (u.ticketsWonTotal || 0) + wonTickets;
    patch.prizesWonTotal = (u.prizesWonTotal || 0) + (isSpecial ? 1 : 0);
    patch.bestStreak = Math.max(u.bestStreak || 0, currentStreak || 0);
    patch.bestWin = prizeValue > best.value ? { value: prizeValue, outcomeId, at: now } : best;
    patch.firstSeenAt = u.firstSeenAt || now;
    patch.spinHistory = (u.spinHistory || []).concat([{
      id: outcomeId, sp: isSpecial ? 1 : 0, am: amount, tk: wonTickets || undefined, w: wheel, at: now,
    }]).slice(-25);

    // Один запис у базу замість дев'яти — атомарно і швидше.
    db.upsertUser(uid, patch);
    if (wonTickets) addTickets(uid, wonTickets, 'виграш у колесі', { silent: true });

    if (isSpecial) {
      const tier = CFG.getTier(outcomeId);
      const app_ = db.addApplication({ uid, tierId: outcomeId, status: 'pending', createdAt: now, source: 'wheel_' + wheel });
      appId = app_.id;
      // Великий виграш — у чат, щоб усі бачили, що тут реально дають.
      // Із затримкою: спершу людина має побачити приз сама.
      setTimeout(() => {
        chat.announce('🎉 <b>' + whoOf(u) + '</b> щойно виграв <b>' + tier.emoji + ' ' + esc(tier.name) + '</b> на колесі!').catch(() => {});
      }, 7000);
      if (ADMIN_CHAT_ID) setTimeout(() => {
        bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `${tier.emoji} Виграш у колесі (${wheel})! ${tier.name} (~${tier.priceStars}⭐) Заявка #${appId}\nІм'я: ${u.name || '—'}\nUsername: ${u.username ? '@' + u.username : 'без юзернейму'}\nID: ${uid}`,
          Markup.inlineKeyboard([[
            callbackBtn('Підтвердити', `admin_approve_${appId}`, 'success', 'check'),
            callbackBtn('Відхилити', `admin_reject_${appId}`, 'danger', 'redCircle'),
          ]])
        ).catch(() => {});
      }, 6500);
    }

    // ── 4. ПОБІЧНЕ: пас, ліга, спільна ціль, журнал. Помилка тут не має
    // зіпсувати вже зроблений спін.
    try {
      if (wheel === 'daily' && !useFreeSpin) awardPassXp(uid, 'streak', 'щоденний спін');
      const up = db.getUser(uid) || {};
      const pp = pass.ensure(up, now);
      if (isPaid) {
        // Платний спін качає пас: XP за кожну витрачену зірку.
        const spent = wheel === 'premium' ? WHEEL_CONFIGS.premium.realStarsCost : paidStars;
        if (spent) pass.addWagerXp(pp, spent, 'spin', now);
      } else {
        // Безкоштовний спін теж рухає пас — інакше гравець без грошей стоїть.
        pass.addFreeXp(pp, pass.XP_DAILY_SPIN, 'daily', now);
      }
      db.upsertUser(uid, { pass: pp });
    } catch (e) { console.error('pass onSpin failed:', e.message); }

    if (wheel === 'paid' && paidStars) leagueXp(uid, 'paid_star', paidStars);
    if (wheel === 'daily') {
      leagueXp(uid, 'daily_spin', 1);
      if (!useFreeSpin) leagueXp(uid, 'streak_day', Math.min(currentStreak || 1, 7));
    }
    if (wheel === 'referral') leagueXp(uid, 'ref_spin', 1);

    try { addGoalSpin(uid); } catch (e) { console.error('goal failed:', e.message); }
    logWheelEvent(uid, wheel, 'spin', { outcomeId, isSpecial, streakBonus, bonus: useFreeSpin || undefined, gift: useGift || undefined });

    // Сповіщення адміну про спін — чекає, поки людина закінчить із ризиком ×2,
    // інакше в чаті лишалась неправдива сума. Вимикається командою /spin_notify off.
    if (ADMIN_CHAT_ID && !isSpecial && spinNotifyOn()) setTimeout(() => {
      const wheelNames = { daily: 'щоденне', referral: 'за білети', paid: 'за зірки', premium: 'ПРЕМІУМ' };
      const uNow = db.getUser(uid) || {};
      const rr = uNow.lastRiskResult;
      const freshRisk = rr && rr.spinAt === spinStartedAt;
      const what = isTix ? `+${wonTickets}🎫` : `+${amount}⭐`;
      let line;
      if (freshRisk) {
        line = rr.won
          ? `🎰 Спін (${wheelNames[wheel] || wheel}): ${what} → ризик ×2 виграв → підсумок +${rr.finalAmount}⭐`
          : `🎰 Спін (${wheelNames[wheel] || wheel}): ${what} → ризик ×2 ЗЛИВ → підсумок 0⭐`;
      } else {
        line = `🎰 Спін (${wheelNames[wheel] || wheel}): ${what}${streakBonus ? ' (+' + streakBonus + '⭐ бонус серії)' : ''}`;
      }
      bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        line + `\nБаланс зараз: ${fmtStars(uNow.starBalance || 0)}⭐\n` +
        `${u.name || '—'} (${u.username ? '@' + u.username : 'без юзернейму'}) · id ${uid}`
      ).catch(() => {});
    }, 45000); // час на кілька спроб ризику

    const after = db.getUser(uid) || {};
    res.json({
      outcomeId, isSpecial, amount, wonTickets, balance: finalBalance, applicationId: appId,
      streakBonus, streak: currentStreak,
      // Стан після спіну — щоб застосунок не вгадував, коли наступний спін.
      usedFreeSpin: useFreeSpin, usedGift: useGift,
      freeSpins: after.freeSpins || 0,
      paidSpinsGifted: after.paidSpinsGifted || 0,
      premiumSpins: after.premiumSpinsAvailable || 0,
      tickets: ticketsOf(after),
      nextDailySpinAt: after.lastDailySpinAt && (Date.now() - after.lastDailySpinAt < 86400000) ? after.lastDailySpinAt + 86400000 : null,
    });
  } catch (e) {
    console.error('spin failed:', e && e.stack || e);
    if (!res.headersSent) res.status(500).json({ error: 'spin_failed' });
  } finally {
    balanceLocks.delete(uid);
  }
});

// Адмінські сповіщення про кожен спін: /spin_notify on|off
function spinNotifyOn() { return !(db.getFeatureFlags() || {}).spinNotifyOff; }
bot.command('spin_notify', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
  if (arg === 'on' || arg === 'off') db.setFeatureFlags({ spinNotifyOff: arg === 'off' });
  await ctx.reply('🎰 Сповіщення про кожен спін: ' + (spinNotifyOn() ? 'УВІМКНЕНО' : 'вимкнено') +
    '\n\nЗмінити: /spin_notify on · /spin_notify off\n(Виграші призів приходять завжди.)');
});

// ---------------------------------------------------------------------------
// Тапалка ВИМКНЕНА. У застосунку її давно немає, але API лишався живим:
// 0.2⭐ за тап і відновлення енергії давали до ~5700⭐ на добу прямими
// запитами, без жодного інтерфейсу. Ендпоінти лишаються, щоб старі
// клієнти отримували зрозумілу відповідь, а не 404.
// ---------------------------------------------------------------------------
app.get('/api/tap-status', (req, res) => res.status(410).json({ error: 'tap_disabled' }));
app.post('/api/tap', (req, res) => res.status(410).json({ error: 'tap_disabled' }));

// Реальне поповнення через Telegram Stars (валюта XTR — токен провайдера
// не потрібен, це вбудована валюта Telegram).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// СПІЛЬНА ЦІЛЬ: усі разом крутять N спінів — випадковий учасник отримує приз.
// Рахуються БУДЬ-ЯКІ спіни, тож долучитись може кожен, навіть безкоштовно.
const GOAL_TARGET = 100;
const GOAL_PRIZE_TIER = 'gift';   // 25⭐ — у межах маржі від 100 спінів (~58⭐)

function getGoal() {
  const f = db.getFeatureFlags() || {};
  return { count: f.goalCount || 0, participants: f.goalParticipants || [], done: !!f.goalDone };
}

function addGoalSpin(uid) {
  const g = getGoal();
  if (g.done) return g;
  const parts = g.participants.includes(uid) ? g.participants : g.participants.concat([uid]);
  const count = g.count + 1;
  db.setFeatureFlags({ goalCount: count, goalParticipants: parts });

  if (count >= GOAL_TARGET) finishGoal(parts);
  return { count, participants: parts, done: count >= GOAL_TARGET };
}

async function finishGoal(parts) {
  db.setFeatureFlags({ goalDone: true });
  if (!parts.length) return;

  const winner = parts[Math.floor(Math.random() * parts.length)];
  const tier = CFG.getTier(GOAL_PRIZE_TIER);
  const app_ = db.addApplication({
    uid: winner, tierId: GOAL_PRIZE_TIER, status: 'pending',
    createdAt: Date.now(), source: 'goal',
  });

  const wu = db.getUser(winner) || {};
  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🎯 СПІЛЬНУ ЦІЛЬ ДОСЯГНУТО! ${GOAL_TARGET} спінів\nУчасників: ${parts.length}\nПереможець: ${wu.name || '—'} ${wu.username ? '@' + wu.username : ''} · id ${winner}\nПриз: ${tier.emoji} ${tier.name} · заявка #${app_.id}`,
      Markup.inlineKeyboard([[
        callbackBtn('Підтвердити', `admin_approve_${app_.id}`, 'success', 'check'),
        callbackBtn('Відхилити', `admin_reject_${app_.id}`, 'danger', 'redCircle'),
      ]])
    ).catch(() => {});
  }

  // Сповіщаємо всіх учасників — і переможця, і решту.
  for (const uid of parts) {
    const txt = uid === winner
      ? `🎯 ЦІЛЬ ДОСЯГНУТО!\n\nІ приз дістався саме тобі — ${tier.emoji} ${tier.name}!\nЗаявка #${app_.id} створена, видамо найближчим часом.`
      : `🎯 ЦІЛЬ ДОСЯГНУТО!\n\nРазом накрутили ${GOAL_TARGET} спінів. Приз ${tier.emoji} ${tier.name} дістався іншому учаснику — цього разу не пощастило.\n\nДякую, що був частиною 🙌`;
    await bot.telegram.sendMessage(uid, txt).catch(() => {});
    await new Promise(r => setTimeout(r, 120));
  }
}

// Адмін: запустити нову ціль
bot.command('goal_reset', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.setFeatureFlags({ goalCount: 0, goalParticipants: [], goalDone: false });
  await ctx.reply(`🎯 Нову ціль запущено: ${GOAL_TARGET} спінів. Приз: ${CFG.getTier(GOAL_PRIZE_TIER).name}.`);
});

bot.command('goal_stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const g = getGoal();
  await ctx.reply(`🎯 Ціль: ${g.count}/${GOAL_TARGET}\nУчасників: ${g.participants.length}\nСтатус: ${g.done ? 'ДОСЯГНУТО' : 'триває'}`);
});

// ---------------------------------------------------------------------------
// МАГАЗИН: пряма покупка призу за накопичені зірки, без рандому.
// Комісія така сама, як на виводі — одне правило скрізь.
// NFT і Premium у магазині НЕМАЄ навмисно: інакше немає сенсу крутити колесо
// за 15⭐, коли той самий приз можна просто купити. Колесо — єдиний шлях до
// дорогих призів, магазин — для дрібних і як спосіб не піти ні з чим.
const SHOP_ITEMS = ['bear', 'gift', 'rocket', 'trophy'];

// Умова замість ціни чи заборони: щоб забрати приз, треба реально грати.
// Це заодно вирішує головну проблему — раніше не було сенсу крутити платне
// колесо, бо приз простіше було купити. Тепер колесо є шляхом до магазину.
// ОДНА умова на весь магазин, а не сходинки по призах. Сходинки давали
// перекос: дві мішки за 3 спіни вигідніші за подарунок за 6, тож дорожчі
// призи не мали сенсу. Тепер 3 платні спіни відкривають усе й назавжди.
const SHOP_UNLOCK_SPINS = 1;

// Скільки платних спінів (за зірки + преміум) людина зробила за весь час.
function paidSpinsOf(uid) {
  const u = db.getUser(uid) || {};
  return u.paidSpinsTotal || 0;
}

function reqFor(uid) {
  const have = paidSpinsOf(uid);
  return { need: SHOP_UNLOCK_SPINS, have, ok: have >= SHOP_UNLOCK_SPINS };
}




const WHEEL_ONLY = ['wheel_snake', 'wheel_stocking', 'wheel_lolpop', 'wheel_eye', 'premium3m'];
const SHOP_FEE_PERCENT = 0;   // умова зі спінами вже є платою — комісії не треба
function shopPrice(tier) { return Math.ceil(tier.priceStars * (1 + SHOP_FEE_PERCENT / 100)); }

// Одноразова пропозиція заробітку — показуємо РІВНО один раз на акаунт.
const EARN_CHANNEL_LINK = process.env.EARN_CHANNEL_LINK || 'https://t.me/+xEU88NBPgm5iYzYy';
const EARN_CONTACT = '@sherik17';

// Розділ «Заробити» живе обмежений час. Дата старту фіксується при першому
// запуску після деплою, далі 14 днів — і вкладка зникає сама.
const EARN_TAB_DAYS = 14;

function earnTabState() {
  const f = db.getFeatureFlags() || {};
  let startedAt = f.earnTabStartedAt;
  if (!startedAt) {
    startedAt = Date.now();
    db.setFeatureFlags({ earnTabStartedAt: startedAt });
  }
  const endsAt = startedAt + EARN_TAB_DAYS * 86400000;
  return { endsAt, active: Date.now() < endsAt };
}

// Одноразове вікно про нову фічу. Версію можна підняти — і всі побачать знову.
const FEATURE_VERSION = 6;   // вікно про секретне завдання

app.post('/api/feature-popup-seen', (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  db.upsertUser(uid, { featurePopupVer: FEATURE_VERSION });
  res.json({ ok: true });
});

app.post('/api/earn-popup-seen', (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  db.upsertUser(uid, { earnPopupSeen: true });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ЗАВДАННЯ ПАРТНЕРА. Бота в канал не додали, тож перевірити підписку
// автоматично неможливо. Тому працюємо на довірі + вибіркова перевірка:
// нагорода одразу, а адмін час від часу звіряє список і забирає в тих,
// хто обманув. Конверсія від цього найвища, а ризик керований.
// Порядок тут = порядок у застосунку. Temu першим — найбільша нагорода.
const PARTNER_TASKS = {
  // Temu: скачати додаток, протримати 48 год, надіслати доказ.
  // Працює лише для тих, хто раніше додаток не мав.
  // ВИМКНЕНО за рішенням адміна. Записи НЕ видалені навмисно: у черзі
  // лишились заявки на ці завдання, і /accept по них має працювати далі.
  // hidden прибирає завдання зі списку в застосунку, не ламаючи обробку.
  temu:  { reward: 0, once: true, label: 'Встановити Temu', top: true, bears: 3, manager: true, managerOnly: true, hidden: true },
  agent: { reward: 2, once: true, label: 'Перейти в Agent301', proof: true, bonusSpin: true, hidden: true },
};
const PARTNER_TASK_LINK = process.env.TEMU_LINK || 'https://temu.to/k/efbg59c6x6b';
const AGENT_LINK = process.env.AGENT_LINK || 'https://t.me/Agent301Bot/app?startapp=ref_HqqXRf';

app.get('/api/tasks', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const u = db.getUser(uid) || {};
  const done = u.taskDone || {};

  const list = Object.entries(PARTNER_TASKS).map(([id, t]) => {
    const last = done[id] || 0;
    let ready = true, wait = null;
    if (t.once && last) ready = false;
    if (!t.once && last) {
      const left = last + t.cooldownH * 3600000 - Date.now();
      if (left > 0) { ready = false; wait = Math.ceil(left / 3600000) + ' год'; }
    }
    const inReview = !!(u.taskPending || {})[id];
    if (inReview) ready = false;


    return { id, label: t.label, reward: t.reward, ready, wait, doneOnce: !!last && t.once,
             top: !!t.top, inReview, review: !!t.review, proof: !!t.proof,
             bears: t.bears || 0, manager: !!t.manager, managerOnly: !!t.managerOnly };
  });

  res.json({ tasks: list.filter(t => !(PARTNER_TASKS[t.id] || {}).hidden), contact: EARN_CONTACT, manager: EARN_CONTACT });
});

app.post('/api/task-proof', async (req, res) => {
  const { initData, taskId, photoBase64 } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const t = Object.prototype.hasOwnProperty.call(PARTNER_TASKS, taskId) ? PARTNER_TASKS[taskId] : null;
  // Сховані завдання не приймаємо: раніше скрін на вимкнене завдання
  // можна було надіслати прямим запитом.
  if (!t || !t.proof || t.hidden) return res.status(400).json({ error: 'unknown_task' });
  if (!photoBase64 || typeof photoBase64 !== 'string') return res.status(400).json({ error: 'no_photo' });
  if (!ADMIN_CHAT_ID) return res.status(500).json({ error: 'no_admin' });

  const u = db.getUser(uid) || {};
  if ((u.taskDone || {})[taskId]) return res.status(429).json({ error: 'already_done' });
  // Не більше одного скріна на 10 хвилин — інакше адмінський чат можна
  // засипати фотографіями.
  if (Date.now() - (u.taskProofAt || 0) < 10 * 60000) return res.status(429).json({ error: 'wait', wait: '10 хв' });
  db.upsertUser(uid, { taskProofAt: Date.now() });

  try {
    const buf = Buffer.from(String(photoBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await bot.telegram.sendPhoto(ADMIN_CHAT_ID, { source: buf }, {
      caption: `🤖 ${t.label}\n${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}\n` +
               `Нагорода: +${t.reward}⭐${t.bonusSpin ? ' + 1 щоденний спін' : ''}`,
      ...Markup.inlineKeyboard([[
        callbackBtn('Зарахувати', `tproof_ok_${taskId}_${uid}`, 'success', 'check'),
        callbackBtn('Відхилити', `tproof_no_${uid}`, 'danger', 'redCircle'),
      ]]),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('task proof failed', e.message);
    res.status(500).json({ error: 'send_failed' });
  }
});

bot.action(/^tr_ok_(\w+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const [, taskId, uid] = ctx.match;
  const t = PARTNER_TASKS[taskId];
  const u = db.getUser(uid);
  if (!t || !u) return ctx.reply('Не знайдено.');

  const pend = { ...(u.taskPending || {}) };
  delete pend[taskId];
  const done = { ...(u.taskDone || {}) };
  done[taskId] = Date.now();
  const acts = taskId === 'activity' ? ((u.taskActivityCount || 0) + 1) : (u.taskActivityCount || 0);
  const nb = Math.round(((u.starBalance || 0) + t.reward) * 100) / 100;
  db.upsertUser(uid, { starBalance: nb, taskDone: done, taskPending: pend, taskActivityCount: acts });

  await bot.telegram.sendMessage(uid,
    `✅ ${t.label} — зараховано!\n⭐ +${t.reward} (баланс: ${nb}⭐)`
  ).catch(() => {});
  await ctx.reply(`✅ +${t.reward}⭐ для ${u.username ? '@' + u.username : uid}`);
});

bot.action(/^tr_no_(\w+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const [, taskId, uid] = ctx.match;
  const u = db.getUser(uid);
  if (!u) return ctx.reply('Не знайдено.');
  const pend = { ...(u.taskPending || {}) };
  delete pend[taskId];
  db.upsertUser(uid, { taskPending: pend });
  await bot.telegram.sendMessage(uid,
    '❌ Активність не зараховано.\n\nТреба реально читати пости, ставити реакції й писати коментарі в каналі SmartCode. Спробуй ще раз завтра.'
  ).catch(() => {});
  await ctx.reply('Відхилено.');
});

bot.action(/^tproof_ok_(\w+)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const [, taskId, uid] = ctx.match;
  const t = PARTNER_TASKS[taskId];
  const u = db.getUser(uid);
  if (!t || !u) return ctx.reply('Не знайдено.');
  if ((u.taskDone || {})[taskId]) return ctx.reply('Вже зараховано.');

  const done = { ...(u.taskDone || {}) };
  done[taskId] = Date.now();
  const nb = Math.round(((u.starBalance || 0) + t.reward) * 100) / 100;
  const patch = { starBalance: nb, taskDone: done };
  // Бонусний спін — окремим лічильником. Раніше обнулявся кулдаун щоденного
  // спіну, і разом з ним ламалась серія днів поспіль.
  if (t.bonusSpin) patch.freeSpins = (u.freeSpins || 0) + 1;
  db.upsertUser(uid, patch);

  // Мішки видаються заявками — по одній на кожну, щоб видача була звична.
  const apps = [];
  for (let i = 0; i < (t.bears || 0); i++) {
    const a = db.addApplication({ uid, tierId: 'bear', status: 'pending', createdAt: Date.now(), source: 'temu' });
    apps.push('#' + a.id);
  }

  await bot.telegram.sendMessage(uid,
    `✅ ${t.label} — зараховано!\n\n` +
    (t.bears ? `🧸 ${t.bears} мішки твої! Заявки: ${apps.join(', ')}\n` : '') +
    (t.reward ? `⭐ +${t.reward} (баланс: ${nb}⭐)\n` : '') +
    (t.bonusSpin ? '🎰 +1 бонусний спін щоденного колеса!\n' : '')
  ).catch(() => {});
  await ctx.reply(`✅ ${u.username ? '@' + u.username : uid}: ${t.bears ? t.bears + ' мішки (' + apps.join(', ') + ')' : t.reward + '⭐'}`);
});

bot.action(/^tproof_no_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await bot.telegram.sendMessage(ctx.match[1], '❌ Скрін не зараховано. Перевір, що видно перехід за посиланням, і надішли ще раз.').catch(() => {});
  await ctx.reply('Відхилено.');
});

app.post('/api/task-claim', async (req, res) => {
  const { initData, taskId } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const t = Object.prototype.hasOwnProperty.call(PARTNER_TASKS, taskId) ? PARTNER_TASKS[taskId] : null;
  if (!t || t.hidden) return res.status(400).json({ error: 'unknown_task' });

  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found' });

    const done = { ...(u.taskDone || {}) };
    const last = done[taskId] || 0;

    if (t.once && last) return res.status(429).json({ error: 'already_done' });
    if (!t.once && last && Date.now() - last < t.cooldownH * 3600000) {
      const left = Math.ceil((last + t.cooldownH * 3600000 - Date.now()) / 3600000);
      return res.status(429).json({ error: 'cooldown', wait: left + ' год' });
    }

    // Тільки через менеджера — застосунок нічого не приймає.
    if (t.managerOnly) {
      return res.status(403).json({ error: 'manager_only', contact: EARN_CONTACT });
    }

    // Зі скріном: нічого не нараховуємо, чекаємо фото й підтвердження.
    if (t.proof) {
      return res.json({ ok: true, needProof: true, reward: t.reward });
    }

    // На перевірку: заявка адміну, нагорода ЛИШЕ після підтвердження.
    // Раніше активність нараховувалась одразу — і її брали ті, хто нічого
    // не робив у каналі.
    if (t.review) {
      const pend = { ...(u.taskPending || {}) };
      if (pend[taskId]) return res.status(429).json({ error: 'in_review' });
      pend[taskId] = Date.now();
      db.upsertUser(uid, { taskPending: pend });

      if (ADMIN_CHAT_ID) {
        bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `💬 ${t.label} — заявка на перевірку\n${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}\n` +
          `Нагорода: +${t.reward}⭐\n\nПеревір активність у каналі.`,
          Markup.inlineKeyboard([[
            callbackBtn('Зарахувати', `tr_ok_${taskId}_${uid}`, 'success', 'check'),
            callbackBtn('Відхилити', `tr_no_${taskId}_${uid}`, 'danger', 'redCircle'),
          ]])
        ).catch(() => {});
      }
      return res.json({ ok: true, inReview: true, reward: t.reward });
    }

    // Урок не нараховує нічого одразу — лише відправляє заявку адміну.
    if (t.manual) {
      done[taskId] = Date.now();
      db.upsertUser(uid, { taskDone: done });
      if (ADMIN_CHAT_ID) {
        bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `🎓 ЗАПИС НА УРОК! ${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}\n` +
          `Звір із менеджером. Якщо записався — /lesson_ok ${uid}`
        ).catch(() => {});
      }
      return res.json({ ok: true, manual: true, reward: 0, balance: u.starBalance || 0 });
    }

    done[taskId] = Date.now();
    const acts = taskId === 'activity' ? ((u.taskActivityCount || 0) + 1) : (u.taskActivityCount || 0);
    const nb = Math.round(((u.starBalance || 0) + t.reward) * 100) / 100;
    db.upsertUser(uid, { starBalance: nb, taskDone: done, taskActivityCount: acts });

    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `📋 Завдання: ${t.label} (+${t.reward}⭐)\n${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}`
      ).catch(() => {});
    }
    res.json({ ok: true, reward: t.reward, balance: nb });
  } finally {
    balanceLocks.delete(uid);
  }
});

// Список тих, хто заявив підписку — для вибіркової перевірки вручну.
// Підтвердити запис на урок — видає Трофей + 3 спіни колеса «За зірки».
// Підтвердити завдання після перевірки менеджером:
//   /accept @username temu    або    /accept 123456789 temu
bot.command('accept', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply('Формат: /accept @username temu\n\nДоступні: ' + Object.keys(PARTNER_TASKS).join(', '));
  }

  const who = parts[0].replace('@', '').toLowerCase();
  const taskId = parts[1].toLowerCase();
  const t = PARTNER_TASKS[taskId];
  if (!t) return ctx.reply('Невідоме завдання. Доступні: ' + Object.keys(PARTNER_TASKS).join(', '));

  // Шукаємо і за юзернеймом, і за id.
  let uid = null, u = null;
  for (const [id, user] of Object.entries(db.allUsers())) {
    if (id === who || (user && user.username && user.username.toLowerCase() === who)) { uid = id; u = user; break; }
  }
  if (!u) return ctx.reply(`Не знайшов ${parts[0]}. Перевір юзернейм або дай id.`);

  const done = { ...(u.taskDone || {}) };
  if (done[taskId] && t.once) return ctx.reply(`${parts[0]} вже отримував це завдання.`);

  done[taskId] = Date.now();
  const nb = Math.round(((u.starBalance || 0) + (t.reward || 0)) * 100) / 100;
  const patch = { taskDone: done };
  if (t.reward) patch.starBalance = nb;
  // Бонусний спін — окремим лічильником. Раніше обнулявся кулдаун щоденного
  // спіну, і разом з ним ламалась серія днів поспіль.
  if (t.bonusSpin) patch.freeSpins = (u.freeSpins || 0) + 1;
  db.upsertUser(uid, patch);

  const apps = [];
  for (let i = 0; i < (t.bears || 0); i++) {
    const a = db.addApplication({ uid, tierId: 'bear', status: 'pending', createdAt: Date.now(), source: taskId });
    apps.push('#' + a.id);
  }

  await bot.telegram.sendMessage(uid,
    `✅ <b>${t.label}</b> — підтверджено!\n\n` +
    (t.bears ? `🧸 ${t.bears} мішки твої! Заявки: ${apps.join(', ')}\n` : '') +
    (t.reward ? `⭐ +${t.reward} (баланс: ${nb}⭐)\n` : '') +
    (t.bonusSpin ? '🎰 +1 бонусний спін щоденного колеса!\n' : '') +
    '\nДякую 🙌',
    { parse_mode: 'HTML' }
  ).catch(() => {});

  await ctx.reply(
    `✅ ${u.username ? '@' + u.username : uid} — ${t.label}\n` +
    (t.bears ? `🧸 ${t.bears} мішки: ${apps.join(', ')}\n` : '') +
    (t.reward ? `⭐ +${t.reward}\n` : '')
  );
});

bot.command('task_check', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = [];
  for (const [uid, u] of Object.entries(db.allUsers())) {
    const d = u && u.taskDone;
    if (d && d.sub) rows.push(`${u.username ? '@' + u.username : (u.name || uid)} · id ${uid}`);
  }
  if (!rows.length) return ctx.reply('Ще ніхто не заявляв підписку.');
  let text = `Заявили підписку: ${rows.length}\n\n` + rows.join('\n') +
    '\n\nЗвір із учасниками каналу. Хто обманув — /task_revoke <id>';
  while (text.length) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

bot.command('task_revoke', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const uid = (ctx.message.text.split(' ')[1] || '').trim();
  const u = db.getUser(uid);
  if (!u) return ctx.reply('Юзера не знайдено.');

  const done = { ...(u.taskDone || {}) };
  let back = 0;
  for (const [id, t] of Object.entries(PARTNER_TASKS)) {
    if (done[id]) { back += t.reward; delete done[id]; }
  }
  const nb = Math.max(0, Math.round(((u.starBalance || 0) - back) * 100) / 100);
  db.upsertUser(uid, { starBalance: nb, taskDone: done });
  await bot.telegram.sendMessage(uid,
    `⚠️ Нагороду за завдання скасовано (−${back}⭐).\nПеревірка показала, що умови не виконані.\n\nВиконай і забери знову.`
  ).catch(() => {});
  await ctx.reply(`Знято ${back}⭐ у ${u.username ? '@' + u.username : uid}. Баланс: ${nb}⭐`);
});

// ---------------------------------------------------------------------------
// ЩОДЕННЕ ПИТАННЯ. Одне на добу, правильна відповідь — безкоштовний спін.
// Нічого не коштує, але дає причину відкрити бота, коли спін уже витрачений.
const QUIZ = [
  { q: 'Скільки секторів на колесі удачі?', a: ['10', '12', '14'], ok: 1 },
  { q: 'Який шанс виграти в ризик-грі ×2?', a: ['45%', '50%', '60%'], ok: 0 },
  { q: 'Скільки коштує спін колеса «За зірки»?', a: ['10⭐', '15⭐', '25⭐'], ok: 1 },
  { q: 'Через скільки годин оновлюється безкоштовний спін?', a: ['12', '24', '48'], ok: 1 },
  { q: 'Скільки друзів треба запросити для виводу зірок?', a: ['1', '3', '5'], ok: 1 },
  { q: 'Яка комісія на вивід зірок?', a: ['5%', '10%', '15%'], ok: 0 },
  { q: 'Скільки білетів коштує спін колеса «За білети»?', a: ['3', '5', '10'], ok: 1 },
  { q: 'Скільки разів поспіль можна подвоїти виграш?', a: ['2', '3', '5'], ok: 1 },
  { q: 'Який приз найдорожчий у боті?', a: ['Evil Eye', 'Diamond Ring', 'Трофей'], ok: 1 },
  { q: 'Скільки білетів дають 2⭐ при обміні?', a: ['5', '10', '20'], ok: 1 },
  { q: 'Де подивитись свою статистику?', a: ['Колесо', 'Гаманець', 'Профіль'], ok: 2 },
];

function todayKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}

function todayQuiz() {
  // Питання те саме для всіх у межах доби — щоб не було «а в мене інше».
  const d = new Date();
  const idx = (d.getUTCFullYear() * 372 + d.getUTCMonth() * 31 + d.getUTCDate()) % QUIZ.length;
  return { idx, ...QUIZ[idx] };
}

app.get('/api/quiz', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const u = db.getUser(uid) || {};
  const q = todayQuiz();
  const answered = (u.quizDay === todayKey());
  res.json({
    question: q.q,
    answers: q.a,
    answered,
    wasRight: answered ? !!u.quizRight : null,
  });
});

app.post('/api/quiz-answer', (req, res) => {
  const { initData, choice } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const u = db.getUser(uid);
  if (!u) return res.status(400).json({ error: 'user not found' });
  if (u.quizDay === todayKey()) return res.status(429).json({ error: 'already_answered' });

  const q = todayQuiz();
  const right = Number(choice) === q.ok;
  const patch = { quizDay: todayKey(), quizRight: right };

  // Правильна відповідь — бонусний спін щоденного колеса. Окремим
  // лічильником, а не скиданням кулдауну: так не ламається серія днів.
  if (right) patch.freeSpins = (u.freeSpins || 0) + 1;
  db.upsertUser(uid, patch);

  res.json({ right, correctIndex: q.ok, reward: right ? 'spin' : null });
});

app.get('/api/profile', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const u = db.getUser(uid) || {};
  // Посилання для кнопки «поділитись профілем» у застосунку.
  const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;

  const best = u.bestWin || null;
  const bestName = best && best.outcomeId
    ? (String(best.outcomeId).indexOf('star') === 0
        ? best.value + '⭐'
        : CFG.getTier(best.outcomeId).name)
    : null;

  res.json({
    refLink,
    name: u.name || '—',
    username: u.username || null,
    spinsTotal: u.spinsTotal || 0,
    paidSpinsTotal: u.paidSpinsTotal || 0,
    paidSpinsGifted: u.paidSpinsGifted || 0,
    depositCount: u.depositCount || 0,
    depositBonusLeft: Math.max(0, DEPOSIT_BONUS_TIMES - (u.depositCount || 0)),
    prizesWonTotal: u.prizesWonTotal || 0,
    starsEarnedTotal: Math.round((u.starsEarnedTotal || 0) * 100) / 100,
    starsSpentTotal: u.starsSpentTotal || 0,
    balance: u.starBalance || 0,
    streak: u.dailyStreak || 0,
    bestStreak: u.bestStreak || 0,
    referrals: (u.invitedIds || []).length,
    bestWin: bestName,
    bestWinValue: best ? best.value : 0,
    firstSeenAt: u.firstSeenAt || null,
    tickets: ticketsOf(u),
    history: (u.spinHistory || []).slice().reverse().map(h => {
      if (h.id === 'risk_win' || h.id === 'risk_lose') {
        return { id: h.id, kind: 'risk', won: h.id === 'risk_win', mult: h.mult || (h.id === 'risk_win' ? 2 : 1),
                 name: historyName(h), at: h.at };
      }
      const tix = !!(h.tk || isTixId(h.id));
      return { id: h.id, kind: tix ? 'tix' : 'spin', name: historyName(h),
               special: !!h.sp, wheel: h.w, at: h.at };
    }),
  });
});

app.get('/api/shop', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const u = db.getUser(uid) || {};
  const items = SHOP_ITEMS.map(id => {
    const t = CFG.getTier(id);
    const r = reqFor(uid);
    return { id, name: t.name, base: t.priceStars, price: shopPrice(t),
             needSpins: r.need, haveSpins: r.have, unlocked: r.ok };
  }).sort((a, b) => a.price - b.price);
  const exclusive = WHEEL_ONLY.map(id => {
    const t = CFG.getTier(id);
    return { id, name: t.name, price: t.priceStars };
  });
  res.json({ items, exclusive, balance: u.starBalance || 0, feePercent: SHOP_FEE_PERCENT });
});

app.post('/api/shop-buy', async (req, res) => {
  const { initData, itemId } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  if (!SHOP_ITEMS.includes(itemId)) return res.status(400).json({ error: 'unknown_item' });

  const subscribed = await checkChannelSubscription(CFG.CHANNEL_USERNAME, uid);
  if (subscribed !== true) return res.status(403).json({ error: 'not_subscribed', channel: CFG.CHANNEL_USERNAME, channelUrl: CFG.CHANNEL_URL });

  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found' });

    const tier = CFG.getTier(itemId);

    const r = reqFor(uid);
    if (!r.ok) {
      return res.status(403).json({ error: 'need_spins', need: r.need, have: r.have, name: tier.name });
    }
    const price = shopPrice(tier);
    const balance = u.starBalance || 0;
    if (balance < price) return res.status(402).json({ error: 'not_enough', balance, price });

    const newBalance = Math.round((balance - price) * 100) / 100;
    db.upsertUser(uid, { starBalance: newBalance });
    // spentStars — щоб при відхиленні чи скасуванні повернути рівно сплачене.
    const app_ = db.addApplication({ uid, tierId: itemId, status: 'pending', createdAt: Date.now(), source: 'shop', spentStars: price });

    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🛒 Покупка в магазині! Заявка #${app_.id}\n${tier.emoji} ${tier.name} за ${price}⭐\n${u.name || '—'} (${u.username ? '@' + u.username : 'без юзернейму'}) · id ${uid}`,
        Markup.inlineKeyboard([[
          callbackBtn('Підтвердити', `admin_approve_${app_.id}`, 'success', 'check'),
          callbackBtn('Відхилити', `admin_reject_${app_.id}`, 'danger', 'redCircle'),
        ]])
      ).catch(() => {});
    }
    res.json({ ok: true, balance: newBalance, applicationId: app_.id, name: tier.name });
  } finally {
    balanceLocks.delete(uid);
  }
});

// Вивід зірок із застосунку — через ту саму функцію, що й бот.
// ==========================================================================
// СПІЛЬНИЙ БАНК — інлайн-кнопки в боті.
// Стан лежить у базі, тому перезапуск Railway не зриває подію і не крутить
// колесо двічі. Бот не бере комісії: банк — це привід зібрати людей
// в один час, а не спосіб заробити. Комісія тут дала б привід сумніватись.
// ==========================================================================
const BANK_BETS = [5, 10, 25, 50, 100];
const awaitingBankBet = new Set();

// XP у пас за дії, які не є ставками: реферали, квести, серія, промокоди.
// Раніше пас качався лише оборотом, тому людина запрошувала друзів і
// не бачила жодного руху — найкорисніша дія в боті не давала нічого.
const PASS_XP_ACTIONS = {
  referral: 150,   // приведений друг — найцінніша дія, тому найбільше
  task: 50,        // виконаний квест
  streak: 20,      // щоденний спін серії
  promo: 30,       // активований промокод
  deposit: 100,    // поповнення балансу
};

function awardPassXp(uid, kind, note) {
  const amount = PASS_XP_ACTIONS[kind];
  if (!amount) return 0;
  try {
    const u = db.getUser(uid);
    if (!u) return 0;
    const p = pass.ensure(u, Date.now());
    const before = pass.levelOf(p.xp);
    pass.addPetXp(p, amount);           // поза денною стелею обороту: це не ставки
    db.upsertUser(uid, { pass: p });
    const after = pass.levelOf(p.xp);
    if (after > before) {
      bot.telegram.sendMessage(uid,
        `🎟 <b>Новий рівень пасу: ${after}</b>\n\n+${amount} XP${note ? ' — ' + note : ''}\n` +
        `Нагороду забери у застосунку, вкладка «Пас».`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
    return amount;
  } catch (e) {
    console.error('awardPassXp failed:', e.message);
    return 0;
  }
}

// ==========================================================================
// БІЛЕТИ 🎫 — соціальна валюта замість голого лічильника рефералів.
// Білет дають за друга, промокод або пас; витрачаються на колесо білетів.
// Так людина розуміє, ЩО вона заробила, а не «у тебе 7 рефералів, і що».
// ==========================================================================
const TICKETS_PER_SPIN = 5;

// Скільки зірок повернути, якщо заявку відхилено чи скасовано: за вивід і
// покупку в магазині людина заплатила, а послугу не отримала. Виграші
// (колесо, розіграші, сходи) нічого не коштували — там повертати нічого.
function refundableStars(a) {
  if (!a || a.refunded) return 0;
  if (a.spentStars) return a.spentStars;
  if (a.source === 'shop') return shopPrice(CFG.getTier(a.tierId));   // старі покупки без spentStars
  return 0;
}
function refundApplication(a) {
  const back = refundableStars(a);
  if (back > 0) {
    const u = db.getUser(a.uid);
    if (u) {
      db.upsertUser(a.uid, { starBalance: (u.starBalance || 0) + back });
      a.refunded = back;
    }
  }
  return a.refunded === back ? back : 0;
}

function ticketsOf(u) {
  if (!u) return 0;
  // Старі акаунти: кожен реферал перетворюється на білет один до одного,
  // щоб при переході на нову систему ніхто не втратив зароблене.
  const legacy = (u.invitedIds || []).length;
  return Math.max(0, (u.tickets || 0) + legacy - (u.ticketsUsed || 0));
}

// Сповіщення в особисті — лише про нарахування і лише коли воно не видно деінде.
// Раніше бот писав при КОЖНІЙ зміні, навіть при списанні ставки («+-10 білет»),
// і гра в чаті 20 разів поспіль означала 20 повідомлень в особисті.
function addTickets(uid, n, why, opts) {
  const u = db.getUser(uid);
  if (!u || !n) return 0;
  db.upsertUser(uid, { tickets: (u.tickets || 0) + n });
  if (n < 0 || (opts && opts.silent)) return n;
  bot.telegram.sendMessage(uid,
    `🎫 <b>+${n} білет${n > 1 ? 'и' : ''}</b>${why ? ' — ' + why : ''}\n` +
    `Усього: <b>${ticketsOf(db.getUser(uid))}</b>. ${TICKETS_PER_SPIN} білетів = спін колеса білетів.`,
    { parse_mode: 'HTML' }).catch(() => {});
  return n;
}

function getBank() { return (db.getFeatureFlags() || {}).bank || null; }
function saveBank(b) { db.setFeatureFlags({ bank: b }); return b; }

// Повернення всіх ставок банку (скасування адміном). Стара схема без
// betStars/betTickets — там уся вага була зірками.
function refundBank(b, why) {
  let stars = 0, tickets = 0, players = 0;
  for (const uid of b.order || []) {
    const s = b.betStars ? ((b.betStars[uid]) || 0) : ((b.bets || {})[uid] || 0);
    const t = b.betTickets ? ((b.betTickets[uid]) || 0) : 0;
    const u = db.getUser(uid);
    if (!u || (!s && !t)) continue;
    if (s) db.upsertUser(uid, { starBalance: Math.round(((u.starBalance || 0) + s) * 100) / 100 });
    if (t) addTickets(uid, t, 'повернення за скасований банк', { silent: true });
    stars += s; tickets += t; players++;
    bot.telegram.sendMessage(uid, `🏦 ${why}\n\nСтавку повернуто: ` +
      (s ? s + '⭐' : '') + (s && t ? ' + ' : '') + (t ? t + '🎫' : '')).catch(() => {});
  }
  return { stars: Math.round(stars * 100) / 100, tickets, players };
}

function bankText(uid) {
  const b = getBank();
  if (!b) return { text: '🏦 <b>Спільний банк</b>\n\nЗараз розіграшу немає. Наступний оголосимо в каналі.', rows: [] };

  const pot = bank.totalPot(b);
  const mine = b.bets[uid] || 0;
  const u = db.getUser(uid) || {};

  if (b.status === 'drawn') {
    const win = db.getUser(b.winner) || {};
    return {
      text: `🏦 <b>Банк розіграно</b>\n\nПереможець: <b>${b.winner ? whoOf(win, 'гравець') : '—'}</b>\n` +
        `Забрав: <b>${fmtStars(b.wonStars != null ? b.wonStars : pot)}⭐${b.tickets ? ' + ' + b.tickets + '🎫' : ''}</b>\n\n` + (mine ? `Твоя ставка мала вагу ${mine}.\n\n` : '') +
        `Перевірити чесність: /bank_verify`,
      rows: [],
    };
  }

  const lines = bank.sectors(b).slice(0, 8).map((sc, i) => {
    const su = db.getUser(sc.uid) || {};
    const who = String(sc.uid) === String(uid) ? '<b>ти</b>' : (su.username ? '@' + su.username : 'гравець');
    const bet = (sc.stars ? sc.stars + '⭐' : '') + (sc.stars && sc.tickets ? ' + ' : '') + (sc.tickets ? sc.tickets + '🎫' : '');
    return `${i + 1}. ${who} — ${bet || sc.amount} (${sc.percent}%)`;
  });

  const rows = [];
  const afford = BANK_BETS.filter((x) => x <= (u.starBalance || 0));
  for (let i = 0; i < afford.length; i += 3) {
    rows.push(afford.slice(i, i + 3).map((x) => callbackBtn(`+${x}⭐`, `bank_bet_${x}`, 'success', 'starIcon')));
  }
  rows.push([callbackBtn('✏️ Своя сума', 'bank_own', 'primary', 'starIcon')]);
  rows.push([callbackBtn('🔄 Оновити', 'bank_show', undefined, 'starIcon')]);
  rows.push([callbackBtn('Назад', 'back_to_menu', undefined, 'back')]);

  return {
    text: `🏦 <b>СПІЛЬНИЙ БАНК</b>\n\nУ банку: <b>${fmtStars(b.stars != null ? b.stars : pot)}⭐</b>${b.tickets ? ` + <b>${b.tickets}🎫</b>` : ''}\nУчасників: <b>${b.order.length}</b>\n` +
      `До розіграшу: <b>${bank.humanLeft(bank.timeLeft(b))}</b>\n(${new Date(b.drawAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })})\n\n` +
      (mine ? `Твоя ставка: <b>${(b.betStars || {})[uid] || 0}⭐${(b.betTickets || {})[uid] ? ' + ' + b.betTickets[uid] + '🎫' : ''}</b> → шанс <b>${bank.chance(b, uid)}%</b>\n\n`
            : `Ти ще не в грі. Що більше поставиш — то більший твій сектор.\n\n`) +
      (lines.length ? `<b>Сектори:</b>\n${lines.join('\n')}\n\n` : '') +
      `Колесо крутиться один раз, переможець забирає <b>весь банк</b>. Бот не бере нічого.\n` +
      `Результат уже зафіксовано: <code>${b.seedHash.slice(0, 16)}…</code>`,
    rows,
  };
}

bot.action('bank_show', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  const v = bankText(uid);
  await ctx.reply(v.text, { parse_mode: 'HTML', ...(v.rows.length ? Markup.inlineKeyboard(v.rows) : {}) });
});

bot.command('bank', async (ctx) => {
  const v = bankText(String(ctx.from.id));
  await ctx.reply(v.text, { parse_mode: 'HTML', ...(v.rows.length ? Markup.inlineKeyboard(v.rows) : {}) });
});

async function placeBankBet(ctx, uid, amount) {
  const b = getBank();
  if (!b || b.status !== 'open') return ctx.reply('Зараз розіграшу немає.');
  if (balanceLocks.has(uid)) return ctx.reply('⏳ Зачекай секунду.');
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid) || {};
    const bal = u.starBalance || 0;
    const a = Math.floor(Number(amount) || 0);
    if (a < bank.MIN_BET) return ctx.reply(`Мінімальна ставка — ${bank.MIN_BET}⭐.`);
    if (a > bal) return ctx.reply(`Замало зірок: ставка ${a}⭐, у тебе ${Math.round(bal * 100) / 100}⭐.`);

    const r = bank.addBet(b, uid, a);
    if (!r.ok) {
      return ctx.reply(r.error === 'too_late' ? 'Прийом ставок закрито — колесо ось-ось крутиться.' : 'Ставку не прийнято.');
    }
    db.upsertUser(uid, { starBalance: Math.round((bal - a) * 100) / 100 });
    saveBank(b);
    await ctx.reply(
      `✅ Поставлено <b>${a}⭐</b>\n\nТвоя ставка всього: <b>${r.mine}⭐</b>\nШанс: <b>${bank.chance(b, uid)}%</b>\n` +
      `Банк виріс до <b>${r.pot}⭐</b>\n\nРозіграш через ${bank.humanLeft(bank.timeLeft(b))}.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[callbackBtn('🏦 До банку', 'bank_show', 'primary', 'starIcon')]]) }
    );
  } finally { balanceLocks.delete(uid); }
}

bot.action(/^bank_bet_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await placeBankBet(ctx, String(ctx.from.id), ctx.match[1]);
});

bot.action('bank_own', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  awaitingBankBet.add(uid);
  const u = db.getUser(uid) || {};
  await ctx.reply(`Напиши суму ставки числом. Мінімум ${bank.MIN_BET}⭐, стелі немає.\nБаланс: <b>${Math.round((u.starBalance || 0) * 100) / 100}⭐</b>`, { parse_mode: 'HTML' });
});

async function bankTick() {
  const b = getBank();
  if (!b || b.status !== 'open' || Date.now() < b.drawAt) return;
  const res = bank.draw(b);
  if (!res.ok) { if (res.error === 'empty') saveBank(Object.assign(b, { status: 'drawn', winner: null })); return; }
  saveBank(b);

  const winU = db.getUser(res.winner);
  const win = winU || {};
  // Переможець забирає вміст банку ПЛЮС бонус за пройдені віхи.
  // ТУТ БУВ БАГ: (b.stars || res.pot) — якщо в банку були лише білети,
  // b.stars = 0, і переможцю нараховувалась уся ВАГА як зірки (кожен білет
  // перетворювався на 5⭐ — у 25 разів вигідніше за обмін).
  const ms = bank.milestones(b);
  const wonStars = Math.round(((b.stars != null ? b.stars : res.pot) + ms.bonusUnlocked) * 100) / 100;
  const wonTickets = b.tickets || 0;
  b.wonStars = wonStars;
  saveBank(b);
  // Тестові учасники (/test bank) у базі не існують — їм нічого не створюємо.
  if (winU) {
    db.upsertUser(res.winner, { starBalance: Math.round(((win.starBalance || 0) + wonStars) * 100) / 100 });
    if (wonTickets) addTickets(res.winner, wonTickets, 'виграш у банку', { silent: true });
  }
  const name = winU ? whoOf(win) : 'гравець ' + esc(res.winner);
  const prize = `${wonStars}⭐` + (wonTickets ? ` + ${wonTickets}🎫` : '') +
    (ms.bonusUnlocked ? ` (з них ${ms.bonusUnlocked}⭐ бонус за віхи)` : '');

  // Утішні білети всім, хто ставив — щоб ніхто не пішов ні з чим.
  for (const pid of b.order) {
    if (String(pid) === String(res.winner)) continue;
    const cons = bank.consolationFor(b, pid);
    if (cons > 0) addTickets(pid, cons, 'утішні за банк', { silent: true });
  }
  const msg = `🏦 <b>БАНК РОЗІГРАНО</b>\n\nПереможець: <b>${name}</b>\nЗабирає: <b>${prize}</b>\n\nПеревірка чесності: /bank_verify`;
  for (const uid of b.order) {
    if (!db.getUser(uid)) continue;
    bot.telegram.sendMessage(uid,
      String(uid) === String(res.winner)
        ? `🎉 <b>ТИ ЗАБРАВ БАНК!</b>\n\n+${prize} уже на балансі.\n\nПеревірити розіграш: /bank_verify`
        : msg + (bank.consolationFor(b, uid) ? `\n\n🎫 Тобі — <b>${bank.consolationFor(b, uid)} білет(ів)</b> втішних. Ставка не пропала даремно.` : ''),
      { parse_mode: 'HTML' }).catch(() => {});
  }
  if (ADMIN_CHAT_ID) bot.telegram.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' }).catch(() => {});
  console.log('🏦 Банк розіграно:', res.winner, res.pot);
}
// Банк на 30 вересня 18:00 за Києвом створюється сам при старті,
// якщо адмін ще не створив свій.
(function autoBank() {
  if (getBank()) return;
  const draw = new Date('2026-09-30T18:00:00+03:00').getTime();
  if (Date.now() >= draw) return;
  saveBank(bank.create(draw));
  console.log('🏦 Банк створено, розіграш 30.09 18:00');
})();

setInterval(bankTick, 60000);
setTimeout(bankTick, 15000);

bot.command('bank_verify', async (ctx) => {
  const b = getBank();
  if (!b || b.status !== 'drawn') return ctx.reply('Розіграш ще не проводився.');
  const v = bank.verify(b);
  await ctx.reply(
    `🔍 <b>Перевірка розіграшу</b>\n\nSeed:\n<code>${v.seed}</code>\n\n` +
    `Його sha256 (показували ДО ставок):\n<code>${v.seedHash}</code>\nЗбігається: <b>${v.seedOk ? 'так' : 'НІ'}</b>\n\n` +
    `Ставки:\n<code>${v.betLine.slice(0, 250)}</code>\n\nHMAC: <code>${v.hmac.slice(0, 32)}…</code>`,
    { parse_mode: 'HTML' });
});

bot.command('bank_start', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
  const ts = arg ? league.parseKyiv(arg) : null;
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return ctx.reply('Формат: <code>/bank_start 2026-09-30 17:00</code> (час за Києвом)', { parse_mode: 'HTML' });
  if (d.getTime() <= Date.now()) return ctx.reply('Цей час уже минув.');
  const cur = getBank();
  if (cur && cur.status === 'open') return ctx.reply('Уже є відкритий банк. Спершу /bank_cancel — ставки повернуться людям.');
  const b = bank.create(d.getTime());
  saveBank(b);
  await ctx.reply(`🏦 Банк відкрито.\nРозіграш: ${d.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}\n\nSeed-hash для публікації:\n<code>${b.seedHash}</code>\n\nОпублікуй його в каналі ДО ставок — це і є доказ чесності.`, { parse_mode: 'HTML' });
});

bot.command('bank_cancel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const b = getBank();
  if (!b || b.status !== 'open') return ctx.reply('Активного банку немає.');
  // Повертаємо рівно те, що людина поставила: зірки — зірками, білети —
  // білетами. Раніше поверталась ВАГА ставки у зірках, і білет, поставлений
  // у банк, при скасуванні перетворювався на 5⭐.
  const r = refundBank(b, 'Розіграш банку скасовано.');
  db.setFeatureFlags({ bank: null });
  await ctx.reply(`Скасовано, повернуто ${fmtStars(r.stars)}⭐ і ${r.tickets}🎫 для ${r.players} гравців.`);
});

// ==========================================================================
// ТЕСТОВИЙ РЕЖИМ ДЛЯ АДМІНА.
//
// Сенс: готувати й перевіряти нововведення на живому боті, нічого не
// ламаючи. Перед входом у режим твої дані знімаються знімком, і /test off
// повертає все точно як було — баланс, пас, спіни.
//
// Режим НЕ чіпає інших людей: усе, що він робить, стосується лише твого
// запису в базі. Єдиний виняток — /test bank, який створює тестовий банк;
// саме тому він вимагає, щоб реального банку зараз не було.
// ==========================================================================
const TEST_SNAP_KEY = 'testSnapshot';

function testSnapshot(uid) {
  const u = db.getUser(uid) || {};
  return {
    at: Date.now(),
    starBalance: u.starBalance || 0,
    pet: u.pet || null,
    pass: u.pass || null,
    freeSpins: u.freeSpins || 0,
    paidSpinsGifted: u.paidSpinsGifted || 0,
    premiumSpinsAvailable: u.premiumSpinsAvailable || 0,
    dailyStreak: u.dailyStreak || 0,
    lastDailySpinAt: u.lastDailySpinAt || 0,
  };
}

function testIsOn() {
  const f = db.getFeatureFlags() || {};
  return !!(f[TEST_SNAP_KEY] && f[TEST_SNAP_KEY].active);
}

bot.command('test', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const uid = String(ctx.from.id);
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = parts[1];
  const flags = db.getFeatureFlags() || {};
  const snap = flags[TEST_SNAP_KEY] || null;

  const help =
    '🧪 <b>Тестовий режим</b>\n\n' +
    '<code>/test on</code> — увійти (робить знімок твоїх даних)\n' +
    '<code>/test off</code> — вийти й відновити все як було\n' +
    '<code>/test status</code> — що зараз у тебе\n\n' +
    '<b>Баланс і спіни</b>\n' +
    '<code>/test balance 1000</code>\n' +
    '<code>/test spins 5</code> — безкоштовні спіни\n' +
    '<code>/test paid 3</code> — подаровані платні спіни\n\n' +

    '<b>Пас</b>\n' +
    '<code>/test pass lvl 30</code>\n' +
    '<code>/test pass premium</code> — відкрити платну лінію\n' +
    '<code>/test pass reset</code>\n\n' +
    '<b>Події</b>\n' +
    '<code>/test bank 5</code> — тестовий банк із 5 ботами\n' +
    '<code>/test draw</code> — крутнути банк негайно\n' +
    '<code>/test season end</code> — завершити сезон зараз';

  if (!cmd) return ctx.reply(help, { parse_mode: 'HTML' });

  if (cmd === 'on') {
    if (testIsOn()) return ctx.reply('Режим уже увімкнено. Вийти: /test off');
    db.setFeatureFlags({ [TEST_SNAP_KEY]: Object.assign(testSnapshot(uid), { active: true, uid }) });
    return ctx.reply(
      '🧪 <b>Тестовий режим увімкнено</b>\n\n' +
      'Знімок твоїх даних збережено. Ламай що завгодно — <code>/test off</code> поверне все як було.\n\n' +
      'Список команд: /test',
      { parse_mode: 'HTML' }
    );
  }

  if (cmd === 'off') {
    if (!snap || !snap.active) return ctx.reply('Тестовий режим не був увімкнений.');
    db.upsertUser(snap.uid || uid, {
      starBalance: snap.starBalance, pet: snap.pet, pass: snap.pass,
      freeSpins: snap.freeSpins, paidSpinsGifted: snap.paidSpinsGifted,
      premiumSpinsAvailable: snap.premiumSpinsAvailable,
      dailyStreak: snap.dailyStreak, lastDailySpinAt: snap.lastDailySpinAt,
    });
    db.setFeatureFlags({ [TEST_SNAP_KEY]: null });
    return ctx.reply(
      `↩️ <b>Відновлено зі знімка</b>\n\nБаланс: ${snap.starBalance}⭐\n` +
      `Пас повернуто до стану на ${new Date(snap.at).toLocaleString('uk-UA')}.`,
      { parse_mode: 'HTML' }
    );
  }

  if (cmd === 'status') {
    const u = db.getUser(uid) || {};
    const ps = pass.view(pass.ensure(u, Date.now()), Date.now());
    const bk = getBank();
    return ctx.reply(
      `🧪 <b>Стан</b>\n\n` +
      `Режим: <b>${testIsOn() ? 'увімкнено' : 'вимкнено'}</b>\n` +
      `Баланс: <b>${Math.round((u.starBalance || 0) * 100) / 100}⭐</b>\n` +
      `Безкоштовних спінів: ${u.freeSpins || 0} · платних подарованих: ${u.paidSpinsGifted || 0}\n\n` +
      `Пас: рівень ${ps.level}/30, ${ps.xp} XP, платна лінія ${ps.premium ? 'є' : 'немає'}\n` +
      `Банк: ${bk ? `${bank.totalPot(bk)}⭐, ${bk.order.length} учасників, ${bk.status}` : 'немає'}\n` +
      `Техроботи: ${maintState().mode}`,
      { parse_mode: 'HTML' }
    );
  }

  if (!testIsOn()) return ctx.reply('Спочатку /test on — інакше немає куди відкочувати зміни.');

  if (cmd === 'balance') {
    const v = Math.max(0, parseFloat(arg) || 0);
    db.upsertUser(uid, { starBalance: v });
    return ctx.reply(`Баланс: ${v}⭐`);
  }
  if (cmd === 'spins') {
    db.upsertUser(uid, { freeSpins: Math.max(0, parseInt(arg, 10) || 0) });
    return ctx.reply(`Безкоштовних спінів: ${arg}`);
  }
  if (cmd === 'paid') {
    db.upsertUser(uid, { paidSpinsGifted: Math.max(0, parseInt(arg, 10) || 0) });
    return ctx.reply(`Подарованих платних спінів: ${arg}`);
  }

  if (cmd === 'pass') {
    const u = db.getUser(uid) || {};
    const pp = pass.ensure(u, Date.now());
    if (arg === 'lvl') {
      const want = Math.max(1, Math.min(pass.MAX_LEVEL, parseInt(parts[2], 10) || 1));
      pp.xp = (want - 1) * pass.LEVEL_XP;
      db.upsertUser(uid, { pass: pp });
      return ctx.reply(`Пас: рівень ${want}. Нагороди чекають у застосунку.`);
    }
    if (arg === 'premium') {
      pp.premium = true; pp.premiumMethod = 'test';
      db.upsertUser(uid, { pass: pp });
      return ctx.reply('Платну лінію відкрито (тестово).');
    }
    if (arg === 'reset') {
      db.upsertUser(uid, { pass: null });
      return ctx.reply('Пас скинуто.');
    }
    return ctx.reply('Доступно: lvl N, premium, reset');
  }

  if (cmd === 'bank') {
    if (getBank() && getBank().status === 'open') {
      return ctx.reply('Зараз є активний банк. Спочатку /bank_cancel, щоб не зачепити реальні ставки.');
    }
    const n = Math.max(1, Math.min(20, parseInt(arg, 10) || 5));
    const b = bank.create(Date.now() + 3600000);
    // Тестові учасники — неіснуючі id, тому реальним людям нічого не спишеться.
    for (let i = 1; i <= n; i++) bank.addBet(b, 'test_' + i, 10 * i);
    bank.addBet(b, uid, 50);
    b.isTest = true;
    saveBank(b);
    return ctx.reply(
      `🏦 Тестовий банк: <b>${bank.totalPot(b)}⭐</b>, учасників ${b.order.length}.\n` +
      `Твоя частка: ${bank.chance(b, uid)}%.\nКрутнути: /test draw`,
      { parse_mode: 'HTML' }
    );
  }

  if (cmd === 'draw') {
    const b = getBank();
    if (!b || b.status !== 'open') return ctx.reply('Відкритого банку немає.');
    b.drawAt = Date.now() - 1000;
    saveBank(b);
    await bankTick();
    const after = getBank();
    return ctx.reply(`Розіграно. Переможець: ${after.winner || '—'}. Перевірка: /bank_verify`);
  }

  if (cmd === 'season' && arg === 'end') {
    const u = db.getUser(uid) || {};
    const pp = pass.ensure(u, Date.now());
    pp.season = 'expired_test';
    db.upsertUser(uid, { pass: pp });
    sweepSeasons();
    return ctx.reply('Сезон для твого акаунта позначено завершеним і прибрано чисткою. Відкрий пас — має бути 1 рівень.');
  }

  return ctx.reply(help, { parse_mode: 'HTML' });
});

// ==========================================================================
// АДМІН-КОМАНДИ
// ==========================================================================

// ==========================================================================
// ПРОМОКОДИ на зірки, білети і спіни — однією командою.
// Формат: /promo НОВИЙ 10з 3б 2с 50 — код, нагороди, кількість активацій.
//   Nз — зірки, Nб — білети, Nс — спіни щоденного колеса
// ==========================================================================
function parsePromoRewards(tokens) {
  const out = { stars: 0, tickets: 0, spins: 0, uses: 0 };
  for (const t of tokens) {
    const m = String(t).toLowerCase().match(/^(\d+)(з|s|б|b|t|с|c|x)?$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (u === 'з' || u === 's') out.stars += n;
    else if (u === 'б' || u === 'b' || u === 't') out.tickets += n;
    else if (u === 'с' || u === 'c' || u === 'x') out.spins += n;
    else out.uses = n;                    // число без літери = кількість активацій
  }
  return out;
}

bot.command('promo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (!parts.length) {
    return ctx.reply(
      '🎫 <b>Створення промокоду</b>\n\n' +
      '<code>/promo КОД 10з 3б 2с 50</code>\n\n' +
      '10<b>з</b> — 10 зірок\n3<b>б</b> — 3 білети\n2<b>с</b> — 2 спіни щоденного колеса\n' +
      '50 — на скільки активацій (число без літери)\n\n' +
      'Можна комбінувати як завгодно:\n' +
      '<code>/promo ОСІНЬ 25з 100</code> — лише зірки\n' +
      '<code>/promo ДРУГ 5б 20</code> — лише білети\n' +
      '<code>/promo ВСЕ 10з 2б 1с 10</code> — усе разом\n\n' +
      'Список: /promo_list',
      { parse_mode: 'HTML' }
    );
  }
  const code = parts[0].toUpperCase();
  const r = parsePromoRewards(parts.slice(1));
  if (!r.stars && !r.tickets && !r.spins) return ctx.reply('Не вказано жодної нагороди. Приклад: /promo КОД 10з 50');
  if (db.getPromoCode(code)) return ctx.reply(`Код ${code} уже існує. Видалити: /promo_del ${code}`);

  db.setPromoCode(code, {
    amount: r.stars, tickets: r.tickets, spins: r.spins,
    usesLeft: r.uses || 1, usedBy: [], createdAt: Date.now(),
  });
  const parts2 = [];
  if (r.stars) parts2.push(`${r.stars}⭐`);
  if (r.tickets) parts2.push(`${r.tickets} 🎫`);
  if (r.spins) parts2.push(`${r.spins} спін${r.spins > 1 ? 'и' : ''}`);
  await ctx.reply(
    `✅ Промокод <code>${code}</code>\n\nДає: <b>${parts2.join(' + ')}</b>\n` +
    `Активацій: <b>${r.uses || 1}</b>\n\nЛюди вводять його кнопкою «Промокод» у боті.`,
    { parse_mode: 'HTML' }
  );
});

bot.command('promo_list', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const all = db.listPromoCodes() || {};
  const keys = Object.keys(all);
  if (!keys.length) return ctx.reply('Промокодів немає.');
  const lines = keys.slice(0, 40).map((k) => {
    const p = all[k];
    const give = [];
    if (p.amount) give.push(p.amount + '⭐');
    if (p.tickets) give.push(p.tickets + '🎫');
    if (p.spins) give.push(p.spins + ' спін');
    return `<code>${k}</code> — ${give.join(' + ')} · лишилось ${p.usesLeft}, використали ${(p.usedBy || []).length}`;
  });
  await ctx.reply('🎫 <b>Промокоди</b>\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
});

bot.command('promo_del', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = (ctx.message.text.split(/\s+/)[1] || '').toUpperCase();
  if (!code || !db.getPromoCode(code)) return ctx.reply('Формат: /promo_del КОД');
  db.setPromoCode(code, { amount: 0, tickets: 0, spins: 0, usesLeft: 0, usedBy: [], deleted: true });
  await ctx.reply(`Код ${code} вимкнено.`);
});

bot.command('help_admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(
    '<b>Адмін-команди</b>\n\n' +
    '<b>Техроботи</b>\n' +
    '/maint — поточний стан\n' +
    '/maint withdraw — заблокувати лише вивід\n' +
    '/maint full — екран техробіт на весь застосунок\n' +
    '/maint off — усе назад\n' +
    '/maint text &lt;текст&gt; — своє повідомлення людям\n\n' +
    '<b>Заявки</b>\n' +
    '/apps — зведення по чергах\n' +
    '/inactive &lt;днів&gt; — скільки заявок від неактивних (за замовчуванням 2)\n' +
    '/cancel_inactive &lt;днів&gt; — скасувати їх (спитає підтвердження)\n\n' +
    '<b>Сезон</b>\n' +
    '/season — коли закінчується поточний сезон пасу\n\n' +
    '<b>Тест</b>\n/test — тестовий режим із відкотом',
    { parse_mode: 'HTML' }
  );
});

bot.command('maint', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const arg = (parts[0] || '').toLowerCase();
  const names = { off: 'вимкнено', withdraw: 'лише вивід', full: 'весь застосунок' };

  if (!arg) {
    const m = maintState();
    return ctx.reply(
      `🛠 <b>Техроботи: ${names[m.mode]}</b>\n\n` +
      (m.since ? `Увімкнено: ${new Date(m.since).toLocaleString('uk-UA')}\n` : '') +
      (m.until ? `Лишилось: <b>${humanLeft(m.left)}</b>\n` : (m.mode !== 'off' ? 'Без таймера\n' : '')) +
      `Текст для людей:\n<i>${m.text}</i>\n\n` +
      `Керування: /maint withdraw · /maint full · /maint off`,
      { parse_mode: 'HTML' }
    );
  }

  if (arg === 'text') {
    const t = parts.slice(1).join(' ').trim();
    if (!t) return ctx.reply('Формат: /maint text Повернемось за годину');
    setMaint({ text: t });
    return ctx.reply('Текст оновлено. Люди побачать його одразу, без деплою.');
  }

  if (['off', 'withdraw', 'full'].indexOf(arg) === -1) {
    // Швидкий формат: /maint 2г30хв — одразу full на цей час.
    const ms = parseDuration(arg + (parts[1] || ''));
    if (ms > 0) {
      const until = Date.now() + ms;
      setMaint({ mode: 'full', since: Date.now(), until });
      return ctx.reply(
        `🛠 <b>Техроботи увімкнено на ${humanLeft(ms)}</b>\n\n` +
        `Завершаться автоматично: ${new Date(until).toLocaleString('uk-UA')}\n` +
        `Таймер лежить у базі, тому переживе будь-яку кількість деплоїв.\n\n` +
        `Ти як адмін заходиш у бота й застосунок як завжди.\n` +
        `Зупинити раніше: /maint off`,
        { parse_mode: 'HTML' }
      );
    }
    return ctx.reply(
      'Доступно: off, withdraw, full, text\n\n' +
      'Або одразу час: <code>/maint 2г</code>, <code>/maint 30хв</code>, <code>/maint 1д12г</code>\n' +
      'Режим із часом можна й так: <code>/maint withdraw 3г</code>',
      { parse_mode: 'HTML' }
    );
  }

  // Другим словом можна дати тривалість: /maint withdraw 3г
  const dur = parseDuration(parts.slice(1).join(''));
  const until = arg === 'off' ? 0 : (dur > 0 ? Date.now() + dur : 0);
  const m = setMaint({ mode: arg, since: arg === 'off' ? 0 : Date.now(), until });
  await ctx.reply(
    `🛠 Техроботи: <b>${names[m.mode]}</b>\n\n` +
    (arg === 'full'
      ? 'Застосунок показує екран техробіт замість інтерфейсу. Спіни й ігри заблоковані.\n'
      : arg === 'withdraw'
        ? 'Вивід заблоковано, решта бота працює як завжди.\n'
        : 'Усе знову доступно.\n') +
    (m.until
      ? `Завершаться автоматично через <b>${humanLeft(m.left)}</b> (${new Date(m.until).toLocaleString('uk-UA')}).\n`
      : (arg !== 'off' ? 'Без таймера — доки не вимкнеш вручну.\n' : '')) +
    (arg !== 'off' ? '\nТи як адмін користуєшся ботом і застосунком без обмежень.' : ''),
    { parse_mode: 'HTML' }
  );
});

// Зведення по заявках: скільки, на скільки зірок, від кого.
function appsSummary() {
  const pending = db.listApplications('pending');
  const users = db.allUsers() || {};
  let payout = 0;
  const bySource = {};
  for (const a of pending) {
    payout += a.payoutStars || 0;
    const src = a.source || 'інше';
    bySource[src] = (bySource[src] || 0) + 1;
  }
  return { pending, payout, bySource, users };
}

bot.command('apps', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { pending, payout, bySource } = appsSummary();
  const lines = Object.keys(bySource).map((k) => `• ${k}: ${bySource[k]}`);
  await ctx.reply(
    `📋 <b>Черга заявок</b>\n\n` +
    `Усього в очікуванні: <b>${pending.length}</b>\n` +
    `До видачі зірками: <b>${Math.round(payout * 100) / 100}⭐</b>\n\n` +
    (lines.length ? lines.join('\n') + '\n\n' : '') +
    `/inactive 2 — подивитись, скільки з них від неактивних`,
    { parse_mode: 'HTML' }
  );
});

// Хто не заходив N днів і має незакриті заявки.
function inactiveApps(days) {
  const cutoff = Date.now() - days * 86400000;
  const { pending, users } = appsSummary();
  const hit = [];
  let refund = 0;
  for (const a of pending) {
    const u = users[a.uid] || {};
    const seen = u.lastActiveAt || u.firstSeenAt || 0;
    if (seen && seen >= cutoff) continue;
    hit.push({ app: a, user: u, seen });
    // Вивід і магазин оплачувались зірками — при скасуванні їх треба повернути.
    refund += refundableStars(a);
  }
  return { hit, refund };
}

bot.command('inactive', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const days = Math.max(1, parseInt(ctx.message.text.split(/\s+/)[1], 10) || 2);
  const { hit, refund } = inactiveApps(days);
  if (!hit.length) return ctx.reply(`Заявок від тих, хто не заходив ${days}+ днів, немає.`);

  const sample = hit.slice(0, 12).map((h) => {
    const d = h.seen ? Math.floor((Date.now() - h.seen) / 86400000) + ' дн тому' : 'жодного разу';
    return `#${h.app.id} · ${h.user.username ? '@' + h.user.username : h.app.uid} · ${d}`;
  });

  await ctx.reply(
    `🕓 <b>Неактивні ${days}+ днів</b>\n\n` +
    `Заявок: <b>${hit.length}</b>\n` +
    `Повернеться на баланси при скасуванні: <b>${Math.round(refund * 100) / 100}⭐</b>\n\n` +
    sample.join('\n') + (hit.length > 12 ? `\n…і ще ${hit.length - 12}` : '') +
    `\n\nСкасувати: <code>/cancel_inactive ${days}</code>`,
    { parse_mode: 'HTML' }
  );
});

const pendingCancelConfirm = new Map();

bot.command('cancel_inactive', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const days = Math.max(1, parseInt(ctx.message.text.split(/\s+/)[1], 10) || 2);
  const { hit, refund } = inactiveApps(days);
  if (!hit.length) return ctx.reply('Нема чого скасовувати.');

  pendingCancelConfirm.set(String(ctx.chat.id), { days, at: Date.now() });
  await ctx.reply(
    `⚠️ Скасувати <b>${hit.length}</b> заявок від неактивних ${days}+ днів?\n` +
    `На баланси повернеться ${Math.round(refund * 100) / 100}⭐.\n\n` +
    `Дію не відкотити. Підтверди: <code>/cancel_inactive_yes ${days}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('cancel_inactive_yes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const days = Math.max(1, parseInt(ctx.message.text.split(/\s+/)[1], 10) || 2);
  const conf = pendingCancelConfirm.get(String(ctx.chat.id));
  if (!conf || conf.days !== days || Date.now() - conf.at > 300000) {
    return ctx.reply('Підтвердження застаріло. Почни з /cancel_inactive ' + days);
  }
  pendingCancelConfirm.delete(String(ctx.chat.id));

  const { hit } = inactiveApps(days);
  let cancelled = 0;
  let refunded = 0;
  for (const h of hit) {
    const a = h.app;
    a.status = 'cancelled';
    a.cancelledAt = Date.now();
    a.cancelReason = `неактивний ${days}+ днів`;
    // Зірки за вивід і магазин повертаємо: людина заплатила, а послугу не отримала.
    const back = refundApplication(a);
    if (back) {
      refunded += back;
      bot.telegram.sendMessage(a.uid,
        `Твою заявку #${a.id} скасовано, бо ти давно не заходив.\n` +
        `${fmtStars(back)}⭐ повернулись на баланс — можеш подати заново.`
      ).catch(() => {});
    }
    cancelled++;
  }
  db.save();
  await ctx.reply(
    `✅ Скасовано заявок: <b>${cancelled}</b>\n` +
    `Повернуто на баланси: <b>${Math.round(refunded * 100) / 100}⭐</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('season', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const now = Date.now();
  const end = pass.seasonEndsAt(now);
  const users = db.allUsers() || {};
  let withPass = 0;
  let premium = 0;
  for (const uid of Object.keys(users)) {
    const p = users[uid].pass;
    if (!p) continue;
    withPass++;
    if (p.premium) premium++;
  }
  await ctx.reply(
    `🎟 <b>Сезон ${pass.seasonId(now)}</b>\n\n` +
    `Закінчується: ${new Date(end).toLocaleString('uk-UA')}\n` +
    `Лишилось днів: <b>${Math.ceil((end - now) / 86400000)}</b>\n\n` +
    `Качають пас: <b>${withPass}</b>\nЗ них купили платну лінію: <b>${premium}</b>\n\n` +
    `Після завершення прогрес у всіх обнулиться автоматично.`,
    { parse_mode: 'HTML' }
  );
});

// ==========================================================================
// САМОВИДАЛЕННЯ СЕЗОНУ.
// Сезон живе 30 днів. Коли він закінчується, прогрес і незабрані нагороди
// згорають — інакше через рік у базі лежали б десятки мертвих сезонів, а
// людина з торішнім пасом забирала б нагороди нового.
//
// Чистка проходить раз на годину і зачіпає лише тих, у кого сезон старий.
// Вона НЕ чіпає зірки й заявки — тільки прогрес пасу.
// ==========================================================================
let lastSweepSeason = pass.seasonId(Date.now());

function sweepSeasons() {
  const now = Date.now();
  const cur = pass.seasonId(now);
  const users = db.allUsers() || {};
  let wiped = 0;
  let hadPremium = 0;

  for (const uid of Object.keys(users)) {
    const p = users[uid] && users[uid].pass;
    if (!p || p.season === cur) continue;
    if (p.premium) hadPremium++;
    // Прогрес обнуляється повністю, разом із купленою платною лінією:
    // вона діє один сезон, як і сам пас.
    db.upsertUser(uid, { pass: null });
    wiped++;
  }

  if (wiped) {
    console.log(`🧹 Сезон ${lastSweepSeason} завершено: очищено ${wiped} пасів (з них платних: ${hadPremium})`);
    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID,
        `🎟 <b>Сезон завершено</b>\n\nОчищено пасів: ${wiped}\nЗ них платних: ${hadPremium}\n` +
        `Новий сезон ${cur} стартував, усі починають з 1 рівня.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }
  lastSweepSeason = cur;
}

// Перша чистка через хвилину після старту, далі щогодини.
setTimeout(sweepSeasons, 60000);
setInterval(sweepSeasons, 3600000);

// ==========================================================================
// ТЕХНІЧНІ РОБОТИ.
// Режим живе у featureFlags, тобто переживає перезапуск. Три стани:
//   off      — усе працює
//   withdraw — заблокований лише вивід, решта бота жива
//   full     — застосунок показує екран техробіт замість інтерфейсу
// Вимикати руками в коді й передеплоювати заради цього — погана ідея:
// техроботи зазвичай потрібні саме тоді, коли деплоїти ніколи.
// ==========================================================================
const MAINT_DEFAULT_TEXT =
  'Вивід тимчасово зупинено на технічні роботи. Зірки на балансі нікуди не зникають — ' +
  'щойно роботи закінчаться, заявку можна буде подати знову.';

// Розбір тривалості: 2д, 3г, 30х, 1д12г, 90m, 2h30m. Повертає мілісекунди.
// Пишемо і кирилицею, і латиницею — у режимі техробіт ніхто не думає
// про розкладку клавіатури.
function parseDuration(str) {
  if (!str) return 0;
  const t = String(str).toLowerCase().replace(/\s+/g, '');
  const re = /(\d+)\s*(д|d|дн|г|h|год|хв|х|m|min|с|s)?/g;
  let ms = 0;
  let found = false;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (!m[1]) continue;
    const n = parseInt(m[1], 10);
    const unit = m[2] || 'хв';
    found = true;
    if (unit === 'д' || unit === 'd' || unit === 'дн') ms += n * 86400000;
    else if (unit === 'г' || unit === 'h' || unit === 'год') ms += n * 3600000;
    else if (unit === 'с' || unit === 's') ms += n * 1000;
    else ms += n * 60000;
  }
  return found ? ms : 0;
}

function humanLeft(ms) {
  if (ms <= 0) return 'ось-ось';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const mi = Math.floor((ms % 3600000) / 60000);
  const parts = [];
  if (d) parts.push(d + ' дн');
  if (h) parts.push(h + ' год');
  if (mi && !d) parts.push(mi + ' хв');
  return parts.join(' ') || 'менше хвилини';
}

function maintState() {
  const f = db.getFeatureFlags() || {};
  const m = f.maintenance || {};
  const mode = m.mode || 'off';
  const until = m.until || 0;

  // Дедлайн живе в базі, а не в памʼяті процесу. Тому після деплою або
  // падіння Railway відлік не починається заново і не зникає — він просто
  // рахується від тієї самої позначки часу.
  if (mode !== 'off' && until && Date.now() >= until) {
    db.setFeatureFlags({ maintenance: { mode: 'off', text: m.text || MAINT_DEFAULT_TEXT, since: 0, until: 0 } });
    console.log('🛠 Техроботи завершились за таймером');
    return { mode: 'off', text: m.text || MAINT_DEFAULT_TEXT, since: 0, until: 0, left: 0 };
  }

  return {
    mode,
    text: m.text || MAINT_DEFAULT_TEXT,
    since: m.since || 0,
    until,
    left: until ? Math.max(0, until - Date.now()) : 0,
  };
}
function setMaint(patch) {
  const cur = maintState();
  db.setFeatureFlags({ maintenance: { ...cur, ...patch } });
  return maintState();
}

app.post('/api/withdraw', async (req, res) => {
  const mt = maintState();
  if (mt.mode !== 'off') return res.status(503).json({ error: 'maintenance', message: mt.text });
  const { initData, amount } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const subscribed = await checkChannelSubscription(CFG.CHANNEL_USERNAME, uid);
  if (subscribed !== true) return res.status(403).json({ error: 'not_subscribed', channel: CFG.CHANNEL_USERNAME, channelUrl: CFG.CHANNEL_URL });

  const want = Number(amount);
  if (!isAllowedPayout(want)) {
    return res.status(400).json({ error: 'bad_amount', min: WITHDRAW_MIN_ANY, message: `Мінімум ${WITHDRAW_MIN_ANY}⭐, далі будь-яка сума.` });
  }

  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found' });

    const w = withdrawCost(want);
    const r = await createStarPayout(uid, w);
    if (r.error === 'not_enough') return res.status(402).json(r);
    if (r.error) return res.status(400).json(r);
    res.json({ ok: true, balance: r.balance, payout: w.payout, fee: w.fee, cost: w.cost, applicationId: r.app.id });
  } finally {
    balanceLocks.delete(uid);
  }
});

// РИЗИК-ГРА: щойно виграні зірки можна поставити на подвоєння.
const RISK_WIN_CHANCE = 0.45;
const RISK_MAX_STREAK = 3;
const RISK_WINDOW_MS = 5 * 60 * 1000;

app.post('/api/risk', async (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found' });

    const pr = u.pendingRisk;
    if (!pr || !pr.amount) return res.status(400).json({ error: 'nothing_to_risk' });
    if (Date.now() - pr.at > RISK_WINDOW_MS) {
      db.upsertUser(uid, { pendingRisk: null });
      return res.status(400).json({ error: 'expired' });
    }
    if (pr.streak >= RISK_MAX_STREAK) return res.status(400).json({ error: 'max_streak' });

    const balance = u.starBalance || 0;
    // Ризикувати можна лише зірками, які ще на балансі. Раніше можна було
    // витратити виграш (вивести, поставити), а тоді «ризикнути» ним: виграш
    // додавав зірки, а програш упирався в нуль — тобто грали безкоштовно.
    if (balance + 1e-9 < pr.amount) {
      db.upsertUser(uid, { pendingRisk: null });
      return res.status(400).json({ error: 'spent', balance });
    }

    const won = crypto.randomInt(1000000) < RISK_WIN_CHANCE * 1000000;

    if (won) {
      const newBalance = balance + pr.amount;
      const newAmount = pr.amount * 2;
      const newStreak = pr.streak + 1;
      // Пишемо ризик в історію окремим записом, щоб у профілі було видно
      // не лише що випало, а й що людина з тим виграшем зробила.
      const histW = (u.spinHistory || []).concat([{
        id: 'risk_win', sp: 0, am: pr.amount, w: 'risk',
        mult: Math.pow(2, newStreak), at: Date.now(),
      }]).slice(-25);

      db.upsertUser(uid, {
        starBalance: newBalance,
        pendingRisk: newStreak >= RISK_MAX_STREAK ? null : { amount: newAmount, streak: newStreak, at: Date.now(), spinAt: pr.spinAt },
        lastRiskResult: { won: true, finalAmount: newAmount, spinAt: pr.spinAt, at: Date.now() },
        spinHistory: histW,
      });
      return res.json({ won: true, amount: newAmount, balance: newBalance, streak: newStreak, canRiskAgain: newStreak < RISK_MAX_STREAK });
    }

    const newBalance = balance - pr.amount;
    const histL = (u.spinHistory || []).concat([{
      id: 'risk_lose', sp: 0, am: pr.amount, w: 'risk',
      mult: Math.pow(2, pr.streak || 0), at: Date.now(),
    }]).slice(-25);

    db.upsertUser(uid, {
      starBalance: newBalance, pendingRisk: null,
      lastRiskResult: { won: false, finalAmount: 0, spinAt: pr.spinAt, at: Date.now() },
      spinHistory: histL,
    });
    return res.json({ won: false, lost: pr.amount, balance: newBalance, canRiskAgain: false });
  } finally {
    balanceLocks.delete(uid);
  }
});

// Інвойс на ОДИН спін преміум-колеса за реальні Telegram Stars.
app.post('/api/create-spin-invoice', async (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  // Колесо вимкнене — продавати на нього спіни не можна: раніше рахунок
  // створювався, людина платила реальні зірки, а крутити було нічого.
  if (WHEEL_CONFIGS.premium.disabled) return res.status(410).json({ error: 'wheel_disabled' });

  const cost = WHEEL_CONFIGS.premium.realStarsCost;
  try {
    const link = await bot.telegram.createInvoiceLink({
      title: 'Спін преміум-колеса',
      description: `Один спін колеса з найкращими шансами на NFT і подарунки (${cost}⭐)`,
      payload: JSON.stringify({ uid, type: 'premium_spin', ts: Date.now() }),
      currency: 'XTR',
      prices: [{ label: 'Спін', amount: cost }],
    });
    res.json({ link });
  } catch (e) {
    console.error('spin invoice failed', e.message);
    res.status(500).json({ error: 'invoice creation failed' });
  }
});

// Інвойс на платну лінію пасу за реальні Telegram Stars.
app.post('/api/create-pass-invoice', async (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const u = db.getUser(uid) || {};
  const p = pass.ensure(u, Date.now());
  if (p.premium) return res.status(400).json({ error: 'already_premium' });

  try {
    const link = await bot.telegram.createInvoiceLink({
      title: 'Платна лінія сезонного пасу',
      description: 'Нагороди на кожному рівні, фінал — Мішка, спін платного колеса і 30⭐. ' +
        'Плюс 2 рівні одразу за оплату зірками.',
      payload: JSON.stringify({ uid, type: 'pass_premium', ts: Date.now() }),
      currency: 'XTR',
      prices: [{ label: 'Платна лінія пасу', amount: pass.PREMIUM_PRICE_XTR }],
    });
    res.json({ link, price: pass.PREMIUM_PRICE_XTR });
  } catch (e) {
    console.error('pass invoice failed:', e.message);
    res.status(500).json({ error: 'invoice_failed', reason: e.message });
  }
});

app.post('/api/create-invoice', async (req, res) => {
  const { initData, amount } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const p = parseTopUpAmount(amount);
  if (p.error) return res.status(400).json({ error: 'invalid amount', message: p.error, max: TOPUP_MAX });
  const starsAmount = p.amount;

  try {
    const link = await bot.telegram.createInvoiceLink({
      title: 'Поповнення балансу StarForge',
      description: `Поповнення внутрішнього балансу на ${starsAmount}⭐`,
      payload: JSON.stringify({ uid, starsAmount, ts: Date.now() }),
      // provider_token для XTR НЕ передається взагалі — порожній рядок
      // частина версій Bot API відхиляє, і рахунок просто не створюється.
      currency: 'XTR',
      prices: [{ label: `${starsAmount}⭐`, amount: starsAmount }],
    });
    res.json({ link });
  } catch (e) {
    // Причину показуємо клієнту: мовчазне «не вдалось» не дає ні людині,
    // ні адміну жодного шансу зрозуміти, що саме зламалось.
    console.error('createInvoiceLink failed:', e.message);
    res.status(500).json({ error: 'invoice_failed', reason: e.message });
  }
});

// ==========================================================================
// УЛЮБЛЕНЕЦЬ
// Уся логіка в pet.js. Тут — лише транспорт і застосування нагород.
// Правило: будь-яка нагорода (зірки, бонусні спіни) записується ОДНИМ

// Хто НЕ бере участі в лізі: адмін і акаунти, приховані командою /league_hide.
function leagueExcluded(uid) {
  if (isAdminUid(uid)) return true;
  const hid = (db.getFeatureFlags() || {}).leagueHidden || [];
  return hid.includes(String(uid));
}
// Стартовий бонус: перші троє, хто перетнув поріг XP, одразу отримують мішку.
// Гонка, а не жеребкування — тому рух починається з першої хвилини.
function checkLaunchBonus(uid, xp) {
  try {
    const f = db.getFeatureFlags() || {};
    const lb = f.leagueLaunchBonus;
    if (!lb || !lb.race) return;
    const winners = lb.winners || [];
    if (winners.length >= lb.count) return;
    if (xp < lb.minXp) return;
    if (winners.some(w => String(w.uid) === String(uid))) return;
    if (leagueExcluded(uid)) return;

    const u = db.getUser(uid) || {};
    const place = winners.length + 1;
    const app_ = db.addApplication({ uid, tierId: lb.tier, status: 'pending', createdAt: Date.now(), source: 'league_launch' });
    winners.push({ uid, place, at: Date.now(), xp, appId: app_.id });
    db.setFeatureFlags({ leagueLaunchBonus: { ...lb, winners } });

    const left = lb.count - winners.length;
    chat.announce('🧸 <b>' + whoOf(u) + '</b> першим набрав ' + lb.minXp +
      ' XP і забрав стартову мішку! ' + (left > 0 ? 'Лишилось ' + left + ' 🔥' : 'Мішки закінчились 🏁')).catch(() => {});
    bot.telegram.sendMessage(uid,
      `🧸 <b>МІШКА ТВОЯ!</b>\n\nТи ${place}-й, хто набрав ${lb.minXp} XP у лізі.\n` +
      `Заявка #${app_.id} створена — видамо найближчим часом.\n\n` +
      (left > 0 ? `<i>Лишилось ще ${left} мішок для інших — гонка триває.</i>` : '<i>Це була остання мішка!</i>'),
      { parse_mode: 'HTML' }).catch(() => {});

    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID,
        `🧸 Стартова мішка #${place}/${lb.count}\n${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}\n` +
        `${xp} XP · заявка #${app_.id}` + (left === 0 ? '\n\n🏁 Усі мішки роздано — можна публікувати переможців.' : '')
      ).catch(() => {});
    }
  } catch (e) { console.error('checkLaunchBonus:', e.message); }
}

// ⚡ «Тебе обігнали» — найсильніший мотиватор повернутися. Пишемо тим, кого
// щойно обігнали в топ-15, не частіше разу на 90 хв і не більше 5 на день.
// І коли хтось вривається в топ-3 — коротко оголошуємо в чаті.
const OVERTAKE_GAP = 90 * 60000;
const OVERTAKE_DAY_CAP = 5;
function leagueRankEvents(uid, oldXp, newXp) {
  try {
    if (!(newXp > oldXp)) return;
    const rows = league.standings(leagueUsers(), Date.now());
    const me = rows.find(r => String(r.uid) === String(uid));
    if (!me) return;
    const oldRank = 1 + rows.filter(r => String(r.uid) !== String(uid) && r.xp > oldXp).length;
    const myName = whoOf(me.u, 'хтось');

    if (oldRank > 3 && me.rank <= 3) {
      chat.announce('🔥 <b>' + myName + '</b> увірвався в топ-3 ліги тижня — тепер #' + me.rank + '!').catch(() => {});
    }
    if (me.rank > 15) return;

    const passed = rows.filter(r => String(r.uid) !== String(uid) && r.xp >= oldXp && r.xp < newXp).slice(0, 3);
    const today = league.dayKey(Date.now());
    for (const p of passed) {
      const pu = db.getUser(p.uid) || {};
      const cnt = pu.otDay === today ? (pu.otCount || 0) : 0;
      if (cnt >= OVERTAKE_DAY_CAP || Date.now() - (pu.otAt || 0) < OVERTAKE_GAP) continue;
      db.upsertUser(p.uid, { otAt: Date.now(), otDay: today, otCount: cnt + 1 });
      const above = rows[p.rank - 2];
      const gap = above ? Math.ceil((above.xp - p.xp + 0.01) * 100) / 100 : 0;
      const url = WEBAPP_URL ? WEBAPP_URL + (WEBAPP_URL.includes('?') ? '&' : '?') + 'tab=league' : null;
      bot.telegram.sendMessage(p.uid,
        '⚡ <b>' + myName + '</b> щойно обігнав тебе в лізі тижня!\n\n' +
        'Ти тепер <b>#' + p.rank + '</b>' + (above ? ' · до #' + (p.rank - 1) + ' лишилось <b>' + gap + ' XP</b>' : '') +
        '\n\n<i>Спін, квест чи кілька повідомлень у чаті — і ти знову попереду 🔥</i>',
        { parse_mode: 'HTML', ...(url ? { reply_markup: { inline_keyboard: [[{ text: '🏆 Відкрити лігу', web_app: { url } }]] } } : {}) }
      ).catch(() => {});
    }
  } catch (e) { console.error('leagueRankEvents:', e.message); }
}

function leagueUsers() {
  return Object.entries(db.allUsers()).filter(([uid]) => !leagueExcluded(uid));
}

// 🧸 Стартові мішки: перші троє, хто перетне поріг XP, одразу отримують
// мішку. Не жеребкування — гонка: хто швидший, той і взяв.
function checkLaunchBears(uid, before, after) {
  try {
    const flags = db.getFeatureFlags() || {};
    const lb = flags.leagueLaunchBonus;
    if (!lb || lb.done) return;
    if (lb.until && Date.now() > lb.until) return;
    const winners = lb.winners || [];
    if (winners.length >= lb.count) return;
    if (winners.some(w => String(w.uid) === String(uid))) return;
    if (before >= lb.minXp || after < lb.minXp) return;      // саме момент перетину

    const u = db.getUser(uid) || {};
    const place = winners.length + 1;
    const a = db.addApplication({ uid, tierId: lb.tier, status: 'pending', createdAt: Date.now(), source: 'league_launch' });
    winners.push({ uid, place, at: Date.now(), appId: a.id, name: leagueName(u, uid), xp: after });
    db.setFeatureFlags({ leagueLaunchBonus: { ...lb, winners, done: winners.length >= lb.count } });

    const left = lb.count - winners.length;
    bot.telegram.sendMessage(uid,
      `🧸 <b>ТИ ВЗЯВ МІШКУ!</b>\n\nТи ${place}-й, хто набрав ${lb.minXp} XP у лізі.\n` +
      `Заявку #${a.id} створено — видамо найближчим часом.\n\n` +
      (left ? `Лишилось мішок: ${left}` : 'Це була остання мішка 🔥'),
      { parse_mode: 'HTML' }).catch(() => {});

    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID,
        `🧸 Мішка #${place}: ${leagueName(u, uid)} (${after} XP), заявка #${a.id}. Лишилось: ${left}`
      ).catch(() => {});
    }
  } catch (e) { console.error('checkLaunchBears:', e.message); }
}

// Нарахування XP ліги тижня. Одна точка — усі дії йдуть через неї.
function leagueXp(uid, src, units) {
  try {
    if (!LEAGUE_ENABLED) return 0;
    if (leagueExcluded(uid)) return 0;
    // Ліга на паузі або ще не стартувала — XP не нараховуємо.
    const lf = db.getFeatureFlags() || {};
    if (lf.leaguePaused) return 0;
    if (lf.leagueStartsAt && Date.now() < lf.leagueStartsAt) return 0;
    const u = db.getUser(uid);
    if (!u) return 0;
    const xpBefore = (u.league && u.league.xp) || 0;
    const oldXp = (u.league && u.league.week === league.weekKey(Date.now())) ? (u.league.xp || 0) : 0;
    const r = league.add(u, src, units, Date.now());
    if (r.gained > 0) {
      setImmediate(() => leagueRankEvents(uid, oldXp, u.league.xp));
      const patch = { league: u.league };
      if (u.leaguePrev) patch.leaguePrev = u.leaguePrev;
      db.upsertUser(uid, patch);
      checkLaunchBears(uid, xpBefore, u.league.xp);
    }
    return r.gained;
  } catch (e) { console.error('leagueXp failed:', e.message); return 0; }
}





// Міні-ігри. Результат камінь-ножиці рахує сервер; у стрибках клієнт шле
// очки, але pet.js обрізає їх стелею — накрутити друкарський верстат не вийде.
const petGameAt = new Map();

// Одноразово підчищаємо баланси, які вже зіпсувались дробовими нарахуваннями.
{
  const fixed = db.fixAllBalances();
  if (fixed) console.log(`Виправлено зіпсованих балансів: ${fixed}`);
}

// Стартовий промокод на 3⭐ — створюється один раз, якщо ще не існує.
if (!db.getPromoCode('STAR3')) {
  db.setPromoCode('STAR3', { amount: 3, usesLeft: null, usedBy: [], createdAt: Date.now() });
  console.log('Промокод STAR3 (+3⭐) створено');
}
// Компенсаційний промокод за скидання черги — рівно 33 активації.
if (!db.getPromoCode('КОМПЕНСАЦІЯ')) {
  db.setPromoCode('КОМПЕНСАЦІЯ', { amount: 3, usesLeft: 33, usedBy: [], createdAt: Date.now() });
  console.log('Промокод КОМПЕНСАЦІЯ (+3⭐, 33 активації) створено');
}

// ---------------------------------------------------------------------------
// Нагадування «безкоштовний спін готовий» — головний механізм утримання.
// Обережно: максимум ОДНЕ повідомлення на добу на людину, і лише тим, хто
// заходив за останні 14 днів (щоб не спамити мертвим акаунтам і не збирати
// скарги на бота).
// Якщо задати змінну оточення WEBAPP_URL (напр. https://xxx.up.railway.app/wheel.html),
// у нагадуванні буде кнопка, що одразу відкриває колесо. Без неї — просто текст.
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const REMINDER_CHECK_INTERVAL_MS = 30 * 60 * 1000; // перевіряємо раз на 30 хв
const REMINDER_ACTIVE_WINDOW_MS = 14 * 24 * 3600 * 1000;

async function sendSpinReminders() {
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const users = db.allUsers();
  let sent = 0;

  for (const [uid, u] of Object.entries(users)) {
    if (!u || u.remindersOff) continue;
    if (u.reminderLastDate === todayStr) continue;               // вже нагадували сьогодні
    if (!u.lastActiveAt || now - u.lastActiveAt > REMINDER_ACTIVE_WINDOW_MS) continue; // давно не заходив
    if (!u.lastDailySpinAt) continue;                            // ще жодного разу не крутив — не чіпаємо
    if (now - u.lastDailySpinAt < 86400000) continue;            // спін ще не готовий

    const streak = u.dailyStreak || 0;
    const streakLine = streak > 1
      ? `\n\n🔥 Твоя серія: ${streak} дн. поспіль — не втрать її!`
      : '';

    try {
      // Кнопку web_app показуємо ЛИШЕ якщо заданий WEBAPP_URL — інакше
      // Telegram відхилить кнопку і повідомлення взагалі не дійде.
      const opts = WEBAPP_URL
        ? Markup.inlineKeyboard([[{ text: '🎰 Крутити', web_app: { url: WEBAPP_URL } }]])
        : {};
      await bot.telegram.sendMessage(
        uid,
        `⭐ Твій безкоштовний спін готовий!${streakLine}` + (WEBAPP_URL ? '' : '\n\nВідкрий колесо кнопкою меню внизу.'),
        opts
      );
      db.upsertUser(uid, { reminderLastDate: todayStr });
      sent++;
      await new Promise(r => setTimeout(r, 120)); // не впираємось у ліміти Telegram
    } catch (e) {
      // Заблокував бота — більше не турбуємо.
      if (String(e.message).includes('blocked') || String(e.message).includes('deactivated')) {
        db.upsertUser(uid, { remindersOff: true });
      }
    }
  }
  if (sent) console.log(`Нагадувань надіслано: ${sent}`);
}

setInterval(() => { sendSpinReminders().catch(e => console.error('reminders failed', e.message)); }, REMINDER_CHECK_INTERVAL_MS);

// Адмін може вручну запустити розсилку нагадувань.
// Скидання черги заявок: повертає списані зірки й просить подати наново.
// Робимо саме з поверненням — інакше людина втратить і заявку, і баланс.
// Компенсація за скидання. Свідомо помірна: 10% від застряглої суми,
// але не менше 10⭐ і не більше 30⭐ на людину. Цього достатньо, щоб
// сприймалось як вибачення, і мало, щоб не поглибити дірку в балансі.
const RESET_BONUS_PERCENT = 10;
const RESET_BONUS_MIN = 10;
const RESET_BONUS_MAX = 30;

function resetBonusFor(refunded) {
  const pct = Math.ceil(refunded * RESET_BONUS_PERCENT / 100);
  return Math.max(RESET_BONUS_MIN, Math.min(RESET_BONUS_MAX, pct));
}

bot.command('reset_requests', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();

  const pending = db.listApplications('pending');
  if (!pending.length) return ctx.reply('Заявок в очікуванні немає.');

  if (arg !== 'так') {
    let sum = 0;
    for (const a of pending) sum += refundableStars(a);
    const uidsPreview = [...new Set(pending.map(a => a.uid))];
    let bonusTotal = 0;
    for (const uid of uidsPreview) {
      let back = 0;
      for (const a of pending.filter(x => x.uid === uid)) back += refundableStars(a);
      bonusTotal += resetBonusFor(back);
    }
    return ctx.reply(
      `Знайдено ${pending.length} заявок від ${uidsPreview.length} людей.\n\n` +
      `Повернення зірок: ~${sum}⭐\n` +
      `Бонус-компенсація: ~${bonusTotal}⭐ (${RESET_BONUS_PERCENT}%, від ${RESET_BONUS_MIN} до ${RESET_BONUS_MAX}⭐ на людину)\n` +
      `РАЗОМ з балансу: ~${sum + bonusTotal}⭐\n\n` +
      `Заявки-виграші з колеса скасуються без повернення (за них зірки не списувались), але бонус отримають усі.\n\n` +
      `Для підтвердження: /reset_requests так`
    );
  }

  let refunded = 0, refundedStars = 0, cancelled = 0, notified = 0, bonusPaid = 0;
  const backByUid = {};
  for (const a of pending) {
    // Раніше покупки з магазину поверталися як ціна +10% — хоча комісії в
    // магазині давно немає, тобто скидання черги ще й доплачувало людям.
    const back = refundApplication(a);
    if (back > 0) {
      refunded++; refundedStars += back;
      backByUid[a.uid] = (backByUid[a.uid] || 0) + back;
    } else cancelled++;

    a.status = 'rejected';
    a.decidedAt = Date.now();
    a.reason = 'Скидання черги через технічні роботи';
  }
  db.save();

  // Повідомляємо людей — спокійно, без вибачень-самобичування.
  const uids = [...new Set(pending.map(a => a.uid))];
  for (const uid of uids) {
    const mine = pending.filter(a => a.uid === uid);
    const back = backByUid[uid] || 0;
    const bonus = resetBonusFor(back);
    const uu = db.getUser(uid);
    if (uu) db.upsertUser(uid, { starBalance: (uu.starBalance || 0) + bonus });
    bonusPaid += bonus;

    const txt = '🔧 Технічні роботи — чергу заявок скинуто\n\n' +
      `Твої заявки (${mine.length}) скасовано.` +
      (back > 0 ? `\n✅ Зірки повернуто: +${back}⭐` : '') +
      `\n🎁 Бонус за незручність: +${bonus}⭐` +
      '\n\nПодай заявку заново — тепер обробка йде швидко.';
    // Кнопка "подати заново" — щоб не змушувати шукати шлях самому.
    const canRestore = mine.some(a => a.source === 'app_withdrawal');
    const opts = canRestore
      ? Markup.inlineKeyboard([[callbackBtn('↩️ Подати заявку на вивід заново', `restore_withdraw_${uid}`, 'success', 'starIcon')]])
      : {};
    await safeSend(uid, () => bot.telegram.sendMessage(uid, txt, opts));
    notified++;
    await new Promise(r => setTimeout(r, 120));
  }

  await ctx.reply(
    `✅ Черга скинута.\n` +
    `Скасовано заявок: ${pending.length}\n` +
    `Повернено зірок: ${refundedStars}⭐ (${refunded} заявок)\n` +
    `Бонус-компенсація: ${bonusPaid}⭐\n` +
    `РАЗОМ списано з балансу проєкту: ${refundedStars + bonusPaid}⭐\n` +
    `Без повернення (виграші з колеса): ${cancelled}\n` +
    `Сповіщено людей: ${notified}`
  );
});

// Повторна подача виводу після скидання черги — одним натисканням,
// на ту саму суму, що була (якщо балансу вистачає).
// Повторна подача виводу після скидання черги — через той самий гаманець
// у застосунку, що й звичайний вивід (одні умови й одна комісія). Раніше
// тут була окрема логіка з іншою формулою комісії.
bot.action(/^restore_withdraw_(\d+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  if (ctx.match[1] !== uid) return ctx.answerCbQuery('Ця кнопка не для тебе.');
  return redirectWithdraw(ctx);
});

// Діагностика: показує, що саме лишилось у черзі й чому воно могло
// не скинутись минулого разу.
// Показати АБСОЛЮТНО всі заявки — усі статуси, з деталями.
// Підтвердити заявку(и) за номером: /approve 142  або  /approve 142 143 144
bot.command('approve', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const ids = ctx.message.text.split(/[\s,#]+/).slice(1).map(x => parseInt(x, 10)).filter(n => !isNaN(n));
  if (!ids.length) return ctx.reply('Вкажи номер: /approve 142\nМожна кілька: /approve 142 143 144');

  const done = [], skip = [];
  for (const id of ids) {
    const app_ = db.getApplication(id);
    if (!app_) { skip.push(`#${id} — немає`); continue; }
    if (app_.status !== 'pending') { skip.push(`#${id} — вже ${app_.status}`); continue; }

    app_.status = 'approved';
    app_.decidedAt = Date.now();
    db.save();

    const t = CFG.getTier(app_.tierId);
    const label = app_.payoutStars ? `${app_.payoutStars}⭐` : `${t.emoji} ${t.name}`;
    await bot.telegram.sendMessage(app_.uid,
      `✅ Заявку #${id} виконано!\n${label} вже в дорозі.\n\nДякую за терпіння 🙌`
    ).catch(() => {});
    done.push(`#${id} ${label}`);
    await new Promise(r => setTimeout(r, 120));
  }

  let msg = done.length ? `✅ Підтверджено:\n${done.join('\n')}` : '';
  if (skip.length) msg += `${msg ? '\n\n' : ''}⏭ Пропущено:\n${skip.join('\n')}`;
  await ctx.reply(msg || 'Нічого не змінено.');
});

// Відхилити заявку(и): /reject 142  або  /reject 142 143
bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const ids = ctx.message.text.split(/[\s,#]+/).slice(1).map(x => parseInt(x, 10)).filter(n => !isNaN(n));
  if (!ids.length) return ctx.reply('Вкажи номер: /reject 142\nМожна кілька: /reject 142 143');

  const done = [], skip = [];
  for (const id of ids) {
    const app_ = db.getApplication(id);
    if (!app_) { skip.push(`#${id} — немає`); continue; }
    if (app_.status !== 'pending') { skip.push(`#${id} — вже ${app_.status}`); continue; }
    app_.status = 'rejected';
    app_.decidedAt = Date.now();
    const back = refundApplication(app_);
    db.save();
    if (back) {
      // Про повернення зірок людині варто знати — інакше це виглядає як зникнення.
      bot.telegram.sendMessage(app_.uid, `❌ Заявку #${id} відхилено.\n↩️ ${fmtStars(back)}⭐ повернуто на баланс.`).catch(() => {});
    }
    done.push(`#${id}` + (back ? ` (↩️ ${fmtStars(back)}⭐)` : ''));
  }
  await ctx.reply(`❌ Відхилено: ${done.join(', ') || '—'}${skip.length ? '\n⏭ ' + skip.join(', ') : ''}\n\n(писали лише тим, кому повернули зірки)`);
});

// Прибрати ВСІ власні заявки адміна — тестові сміття.
bot.command('clear_my', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const uid = String(ctx.from.id);
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();

  const mine = db.listApplications().filter(a => a.uid === uid);
  if (!mine.length) return ctx.reply('Твоїх заявок немає.');

  if (arg !== 'так') {
    const p = mine.filter(a => a.status === 'pending').length;
    return ctx.reply(
      `Твоїх заявок: ${mine.length} (з них у черзі: ${p})\n\n` +
      `Видалю ВСІ твої заявки з бази. Чужих не чіпаю.\n\nПідтвердити: /clear_my так`
    );
  }

  const n = db.removeApplicationsByUid(uid);
  await ctx.reply(`🗑 Видалено твоїх заявок: ${n}. Чужі на місці.`);
});

bot.command('all_requests', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const all = db.listApplications();
  if (!all.length) return ctx.reply('Заявок немає взагалі.');

  const byStatus = {};
  for (const a of all) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

  let text = `📋 УСІ ЗАЯВКИ: ${all.length}\n`;
  for (const [s, n] of Object.entries(byStatus)) text += `  ${s}: ${n}\n`;
  text += '\n';

  const sorted = all.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const a of sorted) {
    const u = db.getUser(a.uid) || {};
    const t = CFG.getTier(a.tierId);
    const d = new Date(a.createdAt || 0).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
    const mark = a.status === 'pending' ? '⏳' : a.status === 'approved' ? '✅' : '❌';
    const extra = a.payoutStars ? ` (${a.payoutStars}⭐)` : '';
    text += `${mark} #${a.id} ${t.name}${extra} · ${a.source || '—'} · ${u.username ? '@' + u.username : (u.name || a.uid)} · ${d}\n`;
  }

  while (text.length) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

// Видалити ВСІ заявки назавжди. Зірки не повертаються — це саме очищення.
bot.command('wipe_requests', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  const all = db.listApplications();

  if (arg !== 'так') {
    const byStatus = {};
    for (const a of all) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    let msg = `⚠️ ВИДАЛЕННЯ ВСІХ ЗАЯВОК\n\nЗараз у базі: ${all.length}\n`;
    for (const [s, n] of Object.entries(byStatus)) msg += `  ${s}: ${n}\n`;
    msg += '\nЗірки НЕ повертаються — це просто очищення історії.\n';
    msg += 'Люди сповіщень не отримають.\n\nПідтвердити: /wipe_requests так';
    return ctx.reply(msg);
  }

  const n = db.wipeApplications();
  await ctx.reply(`🗑 Видалено заявок: ${n}. База заявок порожня.`);
});

bot.command('requests_debug', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const pending = db.listApplications('pending');
  if (!pending.length) return ctx.reply('Черга порожня — усе скинулось коректно.');

  const bySource = {};
  for (const a of pending) bySource[a.source || 'без джерела'] = (bySource[a.source || 'без джерела'] || 0) + 1;

  let text = `В черзі лишилось ${pending.length} заявок:\n\n`;
  for (const [src, n] of Object.entries(bySource)) text += `  ${src}: ${n}\n`;
  text += '\nПерші 15:\n';
  for (const a of pending.slice(0, 15)) {
    const u = db.getUser(a.uid);
    const t = CFG.getTier(a.tierId);
    text += `#${a.id} · ${t.name} · ${a.source || '—'} · ${u ? (u.username ? '@' + u.username : u.name) : a.uid}\n`;
  }
  text += '\nЩоб скинути все, що лишилось: /reset_requests так';
  while (text.length) { await ctx.reply(text.slice(0, 4000)); text = text.slice(4000); }
});

// Повернення тих, хто давно не заходив: разова акція «ми за тобою скучили».
// Дає безкоштовний спін преміум-колеса — він затягує в застосунок, і при
// цьому коштує дешевше за роздачу зірок.
bot.command('winback', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();

  const DAYS = 2;
  const WINBACK_STARS = 3;
  const cutoff = Date.now() - DAYS * 86400000;
  const targets = Object.entries(db.allUsers()).filter(([, u]) =>
    u && u.lang && !u.remindersOff && (!u.lastActiveAt || u.lastActiveAt < cutoff)
  );

  if (arg !== 'так') {
    return ctx.reply(
      `Повернення сплячих\n\n` +
      `Не заходили понад ${DAYS} дн.: ${targets.length}\n` +
      `Кожному: бонусний спін + ${WINBACK_STARS}⭐\n` +
      `Орієнтовна вартість: ~${Math.round(targets.length * (1.72 + WINBACK_STARS))}⭐\n\n` +
      `Запустити: /winback так`
    );
  }

  await ctx.reply(`Розсилаю ${targets.length} сплячим...`);
  let sent = 0, failed = 0;
  for (const [uid, u] of targets) {
    try {
      // Скидаємо кулдаун щоденного спіна + невеликий бонус зірками.
      // Коштує ~5⭐ на людину замість ~21⭐ за преміум-спін, а привід
      // повернутись такий самий.
      db.upsertUser(uid, {
        freeSpins: (u.freeSpins || 0) + 1,
        starBalance: (u.starBalance || 0) + WINBACK_STARS,
      });
      const opts = { parse_mode: 'HTML' };
      if (WEBAPP_URL) opts.reply_markup = { inline_keyboard: [[{ text: '🎰 Крутити', web_app: { url: WEBAPP_URL } }]] };
      await bot.telegram.sendMessage(uid,
        '🎁 <b>Твій спін знову доступний</b>\n\n' +
        `Давно не бачились — даруємо бонусний спін і <b>+${WINBACK_STARS}⭐</b> на баланс.\n\n` +
        'Поки тебе не було, у боті зʼявились: подвоєння ×2, магазин без рандому і спільна ціль.\n\n' +
        '<i>Заходь, крути 🎰</i>', opts);
      sent++;
    } catch (e) {
      failed++;
      if (String(e.message).includes('blocked') || String(e.message).includes('deactivated')) {
        db.upsertUser(uid, { remindersOff: true });
      }
    }
    await new Promise(r => setTimeout(r, 120));
  }
  await ctx.reply(`✅ Готово.\nНадіслано: ${sent}\nНе дійшло: ${failed}`);
});

// Скинути позначку «бачив вікно» — для перевірки або повторного показу всім.
// Розсилка пропозиції заробітку. Кнопка веде одразу в лічку з готовим
// текстом — людині лишається тільки натиснути «надіслати».
bot.command('earn_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();

  const targets = Object.entries(db.allUsers()).filter(([, u]) => u && u.lang && !u.remindersOff);

  if (arg !== 'так') {
    return ctx.reply(
      `Розсилка «Заробити»\n\n` +
      `Отримають: ${targets.length}\n` +
      `Кнопка веде в лічку до ${EARN_CONTACT} з готовим текстом.\n\n` +
      `Запустити: /earn_announce так`
    );
  }

  await ctx.reply(`Розсилаю ${targets.length}...`);

  const contact = EARN_CONTACT.replace('@', '');
  const dmLink = 'https://t.me/' + contact + '?text=' + encodeURIComponent('Привіт! Хочу заробити');

  const text =
    '💰 <b>Хочеш заробляти на цьому?</b>\n\n' +
    'Ти вже тут — то чому б і ні.\n' +
    'Приводиш людей, отримуєш виплати. <b>Гривнями або зірками</b> — як тобі зручніше.\n\n' +
    '📈 Що більше приведеш — то вища ставка\n' +
    '⚡ Виплати без затримок\n' +
    '🤝 Умови обговорюємо особисто, під тебе\n\n' +
    '<i>Пропозиція діє обмежений час — у застосунку є розділ «Заробити» з таймером.</i>\n\n' +
    'Тисни кнопку — відкриється чат, повідомлення вже буде готове 👇';

  let sent = 0, failed = 0;
  for (const [uid] of targets) {
    try {
      await bot.telegram.sendMessage(uid, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '💬 Звʼязатись і дізнатись деталі', url: dmLink }],
          ...(WEBAPP_URL ? [[{ text: '📱 Відкрити застосунок', web_app: { url: WEBAPP_URL } }]] : []),
        ] },
      });
      sent++;
    } catch (e) {
      failed++;
      if (String(e.message).includes('blocked') || String(e.message).includes('deactivated')) {
        db.upsertUser(uid, { remindersOff: true });
      }
    }
    await new Promise(r => setTimeout(r, 120));
  }
  await ctx.reply(`✅ Готово.\nНадіслано: ${sent}\nНе дійшло: ${failed}`);
});

// Розсилка про квести. Кнопки ведуть одразу в канал партнера й у застосунок.
// Разова роздача зірок усім. Позначка не дасть видати двічі.
bot.command('gift_all', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/);
  const amount = parseFloat(parts[1]) || 1;
  const tag = (parts[2] || 'gift1').toLowerCase();   // мітка роздачі
  const go = (parts[3] || '').toLowerCase() === 'так';

  const all = Object.entries(db.allUsers()).filter(([, u]) => u && u.lang);
  const targets = all.filter(([, u]) => !((u.giftsGot || {})[tag]));

  if (!go) {
    return ctx.reply(
      `Роздача ${amount}⭐ усім\n\n` +
      `Усього в базі: ${all.length}\n` +
      `Ще не отримували (мітка «${tag}»): ${targets.length}\n` +
      `Разом віддаси: ${Math.round(targets.length * amount)}⭐\n\n` +
      `Запустити: /gift_all ${amount} ${tag} так`
    );
  }

  await ctx.reply(`Роздаю ${amount}⭐ для ${targets.length}...`);
  let sent = 0, failed = 0;
  for (const [uid, u] of targets) {
    const gifts = { ...(u.giftsGot || {}) };
    gifts[tag] = Date.now();
    const nb = Math.round(((u.starBalance || 0) + amount) * 100) / 100;
    db.upsertUser(uid, { starBalance: nb, giftsGot: gifts });
    try {
      await bot.telegram.sendMessage(uid,
        `🎁 <b>Тримай ${amount}⭐ просто так</b>\n\n` +
        `Без завдань і умов — просто дякую, що ти тут.\n` +
        `Баланс: <b>${nb}⭐</b>`,
        { parse_mode: 'HTML' }
      );
      sent++;
    } catch (e) {
      failed++;
      if (String(e.message).includes('blocked')) db.upsertUser(uid, { remindersOff: true });
    }
    await new Promise(r => setTimeout(r, 110));
  }
  await ctx.reply(`✅ Нараховано всім: ${targets.length}\nПовідомлень дійшло: ${sent}, не дійшло: ${failed}`);
});

bot.command('quests_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  const targets = Object.entries(db.allUsers()).filter(([, u]) => u && u.lang && !u.remindersOff);

  if (arg !== 'так') {
    const notSub = targets.filter(([, u]) => !(u.taskDone || {}).sub).length;
    return ctx.reply(
      `Розсилка про квести\n\n` +
      `Отримають: ${targets.length}\n` +
      `З них ще не підписані на SmartCode: ${notSub}\n\n` +
      `Запустити: /quests_announce так`
    );
  }

  await ctx.reply(`Розсилаю ${targets.length}...`);

  const text =
    '\ud83e\uddf8 <b>3 мішки за одне завдання</b>\n\n' +
    'У застосунку зʼявилось нове завдання — і нагорода там найбільша за весь час.\n\n' +
    '\ud83d\uded2 <b>Temu</b> — скачай додаток, зареєструй новий акаунт, напиши менеджеру.\n' +
    'За це <b>3 мішки</b> \ud83e\uddf8\ud83e\uddf8\ud83e\uddf8\n\n' +
    '<i>Temu працює лише для тих, хто НІКОЛИ не мав додаток. Умови — у вкладці «Квести».</i>';

  let sent = 0, failed = 0;
  for (const [uid] of targets) {
    try {
      const rows = [];
      if (PARTNER_TASK_LINK) rows.push([{ text: '🛒 Скачати Temu', url: PARTNER_TASK_LINK }]);
      if (WEBAPP_URL) rows.push([{ text: '🎯 Відкрити квести', web_app: { url: WEBAPP_URL } }]);
      await bot.telegram.sendMessage(uid, text, {
        parse_mode: 'HTML',
        ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
      });
      sent++;
    } catch (e) {
      failed++;
      if (String(e.message).includes('blocked') || String(e.message).includes('deactivated')) {
        db.upsertUser(uid, { remindersOff: true });
      }
    }
    await new Promise(r => setTimeout(r, 120));
  }
  await ctx.reply(`✅ Готово.\nНадіслано: ${sent}\nНе дійшло: ${failed}`);
});

// Нагадування тим, хто ще не підписався на SmartCode.
bot.command('earn_popup_reset', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').toLowerCase();
  if (arg === 'all') {
    let n = 0;
    for (const [uid, u] of Object.entries(db.allUsers())) {
      if (u && u.earnPopupSeen) { db.upsertUser(uid, { earnPopupSeen: false }); n++; }
    }
    return ctx.reply(`Скинуто для ${n} користувачів — вікно побачать знову.`);
  }
  db.upsertUser(String(ctx.from.id), { earnPopupSeen: false });
  await ctx.reply('Скинуто для тебе. Відкрий застосунок — вікно зʼявиться.\n\nДля всіх: /earn_popup_reset all');
});

// Перезапустити 14-денний таймер вкладки «Заробити».
bot.command('earn_tab_restart', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.setFeatureFlags({ earnTabStartedAt: Date.now() });
  const t = earnTabState();
  await ctx.reply(`Вкладку «Заробити» перезапущено.\nЗникне: ${new Date(t.endsAt).toLocaleString('uk-UA')}`);
});

// ---------------------------------------------------------------------------
// ЕМОДЗІ-ІГРИ. Telegram сам кидає кубик і повертає результат — підробити
// неможливо, і це видно гравцю. RTP 87-93%, тобто маржа 7-13%.
const DICE_GAMES = {
  even:   { emoji: '🎲', label: 'Парне',        win: [2, 4, 6],    k: 1.85 },
  odd:    { emoji: '🎲', label: 'Непарне',      win: [1, 3, 5],    k: 1.85 },
  high:   { emoji: '🎲', label: 'Більше 3',     win: [4, 5, 6],    k: 1.85 },
  goal:   { emoji: '⚽', label: 'Гол',           win: [3, 4, 5],    k: 1.55 },
  hoop:   { emoji: '🏀', label: 'Влучив',       win: [4, 5],       k: 2.30 },
  bulls:  { emoji: '🎯', label: 'В яблучко',    win: [6],          k: 5.20 },
  strike: { emoji: '🎳', label: 'Страйк',       win: [6],          k: 5.20 },
  // Нові ігри. Коефіцієнти підібрані під ту саму маржу 7-13%.
  low:    { emoji: '🎲', label: 'Менше 4',      win: [1, 2, 3],    k: 1.85 },
  six:    { emoji: '🎲', label: 'Рівно 6',      win: [6],          k: 5.20 },
  // Футбольний кубик має 5 значень, промах — це 1 і 2, тобто 40%.
  // Коефіцієнт 2.7 давав RTP 108%: бот платив би більше, ніж збирає.
  miss:   { emoji: '⚽', label: 'Повз ворота',  win: [1, 2],       k: 2.30 },
  // Слот 🎰: значення 1..64, три однакових випадає на 1, 22, 43, 64.
  // Це 4/64 = 6.25%, тому коефіцієнт 14x дає RTP 87.5%.
  slots:  { emoji: '🎰', label: 'Слоти 777',    win: [1, 22, 43, 64], k: 14 },
};
// Що насправді означає число з Telegram. Без цього бот писав «у футболі
// випало 4», хоча у футбольному кубику 5 результатів і «4 голи» не буває.
const DICE_FMT = {
  '\u{1F3B2}': (v) => `випало ${v}`,
  '\u26BD': (v) => (v >= 3 ? 'ГОЛ' : 'повз ворота'),
  '\u{1F3C0}': (v) => (v >= 4 ? 'влучив у кільце' : 'мимо кільця'),
  '\u{1F3AF}': (v) => (v === 6 ? 'у яблучко' : `сектор ${v} з 6`),
  '\u{1F3B3}': (v) => (v === 6 ? 'СТРАЙК' : `збито ${v - 1} з 5 кегл`),
  '\u{1F3B0}': (v) => ([1, 22, 43, 64].indexOf(v) !== -1 ? 'ТРИ В РЯД' : 'комбінація не зійшлась'),
};
function diceResultText(emoji, value) {
  const f = DICE_FMT[emoji];
  return f ? f(value) : `випало ${value}`;
}

const DICE_BETS = [1, 3, 5, 10, 25];
// Стелі ставки немає — обмежує лише баланс гравця.
const DICE_BET_MAX = Number.MAX_SAFE_INTEGER;
const awaitingDiceBet = new Map();   // uid -> game
const diceState = new Map();   // uid -> { game, bet }

function diceMenu(uid) {
  const u = db.getUser(uid) || {};
  const bal = Math.round((u.starBalance || 0) * 100) / 100;
  return {
    text:
      `🎲 <b>Ігри</b>\n\nБаланс: <b>${bal}⭐</b>\n\n` +
      `Telegram сам кидає кубик — результат чесний, підробити неможливо.\n\n` +
      `⚡ <b>Кожна ставка качає сезонний пас:</b> ${pass.XP_PER_STAR_BET} XP за кожну ⭐ ставки.\n` +
      `Ставка 5⭐ = ${5 * pass.XP_PER_STAR_BET} XP, навіть якщо програв.\n\n` +
      `Обери гру:`,
    keyboard: Markup.inlineKeyboard([
      [callbackBtn('🎲 Парне (1.85x)', 'dice_g_even', 'primary', 'starIcon'),
       callbackBtn('🎲 Непарне (1.85x)', 'dice_g_odd', 'primary', 'starIcon')],
      [callbackBtn('🎲 Більше 3 (1.85x)', 'dice_g_high', 'primary', 'starIcon')],
      [callbackBtn('⚽ Гол (1.55x)', 'dice_g_goal', 'success', 'starIcon'),
       callbackBtn('🏀 Влучив (2.3x)', 'dice_g_hoop', 'success', 'starIcon')],
      [callbackBtn('🎲 Менше 4 (1.85x)', 'dice_g_low', 'primary', 'starIcon'),
       callbackBtn('⚽ Повз (2.3x)', 'dice_g_miss', 'success', 'starIcon')],
      [callbackBtn('🎯 Яблучко (5.2x)', 'dice_g_bulls', 'danger', 'starIcon'),
       callbackBtn('🎳 Страйк (5.2x)', 'dice_g_strike', 'danger', 'starIcon')],
      [callbackBtn('🏦 Спільний банк', 'bank_show', 'danger', 'starIcon')],
      [callbackBtn('🎲 Рівно 6 (5.2x)', 'dice_g_six', 'danger', 'starIcon'),
       callbackBtn('🎰 Слоти 777 (14x)', 'dice_g_slots', 'danger', 'starIcon')],
      [callbackBtn('Назад', 'back_to_menu', undefined, 'back')],
    ]),
  };
}

bot.action('dice_menu', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  const m = diceMenu(uid);
  await ctx.reply(m.text, { parse_mode: 'HTML', ...m.keyboard });
});

bot.action(/^dice_g_(\w+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  const g = DICE_GAMES[ctx.match[1]];
  if (!g) return;
  diceState.set(uid, { game: ctx.match[1] });

  const u = db.getUser(uid) || {};
  const bal = u.starBalance || 0;
  const gid = ctx.match[1];
  const rows = DICE_BETS.filter(b => b <= bal).map(b =>
    [callbackBtn(`${b}⭐ → виграш ${Math.round(b * g.k * 100) / 100}⭐`, `dice_b_${gid}_${b}`, 'success', 'starIcon')]
  );
  if (!rows.length) {
    return ctx.reply(`Замало зірок. Мінімальна ставка — ${DICE_BETS[0]}⭐, у тебе ${Math.round(bal * 100) / 100}⭐.`);
  }
  rows.push([callbackBtn('✏️ Своя ставка', `dice_own_${ctx.match[1]}`, 'primary', 'starIcon')]);
  rows.push([callbackBtn('Назад', 'dice_menu', undefined, 'back')]);

  await ctx.reply(
    `${g.emoji} <b>${g.label}</b> · коефіцієнт <b>${g.k}x</b>\n\n` +
    `Кожна ⭐ ставки = <b>${pass.XP_PER_STAR_BET} XP</b> у сезонний пас, незалежно від результату.\n\n` +
    `Обери ставку:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
  );
});

// Формат dice_b_<гра>_<ставка>. Раніше гра бралась із diceState — мапи
// в памʼяті процесу. Після деплою Railway вона порожня, і кнопка «Ще раз»
// або кидала кубик не тієї гри, або лишала g === undefined у тексті.
bot.action(/^dice_b_(\w+)_(\d+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery().catch(() => {});

  const gameId = ctx.match[1];
  const g = Object.prototype.hasOwnProperty.call(DICE_GAMES, gameId) ? DICE_GAMES[gameId] : null;
  if (!g) return ctx.reply('Ця гра недоступна. Обери іншу в меню ігор.');
  if (!(await requireSubscribed(ctx, uid))) return;
  diceState.set(uid, { game: gameId });
  const bet = Math.min(DICE_BET_MAX, Math.max(1, parseInt(ctx.match[2], 10) || 0));

  if (balanceLocks.has(uid)) return ctx.reply('⏳ Зачекай, попередня гра ще йде.');
  balanceLocks.add(uid);
  let result = null;
  try {
    const u = db.getUser(uid);
    if (!u) return ctx.reply('Спершу натисни /start.');
    const bal = u.starBalance || 0;
    if (bal < bet) return ctx.reply(`Замало зірок: ставка ${bet}⭐, у тебе ${fmtStars(bal)}⭐.`);

    // Списуємо одразу, щоб не можна було грати «в кредит» паралельно.
    db.upsertUser(uid, { starBalance: Math.round((bal - bet) * 100) / 100 });

    let msg = null;
    try { msg = await ctx.replyWithDice({ emoji: g.emoji }); } catch (e) { msg = null; }
    if (!msg || !msg.dice) {
      // Кубик не надіслався (мережа, ліміт Telegram) — ставка не має згоріти.
      const ur = db.getUser(uid) || {};
      db.upsertUser(uid, { starBalance: Math.round(((ur.starBalance || 0) + bet) * 100) / 100 });
      return ctx.reply('⚠️ Telegram не прийняв кидок. Ставку повернуто — спробуй ще раз.').catch(() => {});
    }
    const value = msg.dice.value;
    const won = g.win.includes(value);
    const payout = won ? Math.round(bet * g.k * 100) / 100 : 0;

    // Виграш зараховуємо ОДРАЗУ. Раніше він нараховувався в setTimeout через
    // ~4 с — і перезапуск сервера в цей момент з'їдав виграш повністю.
    const u2 = db.getUser(uid) || {};
    const nb = Math.round(((u2.starBalance || 0) + payout) * 100) / 100;
    if (payout) db.upsertUser(uid, { starBalance: nb });
    db.upsertUser(uid, {
      diceGames: ((db.getUser(uid) || {}).diceGames || 0) + 1,
      diceWagered: Math.round((((db.getUser(uid) || {}).diceWagered || 0) + bet) * 100) / 100,
    });

    // Оборот качає сезонний пас: XP за саму ставку, а не за виграш.
    try {
      const up = db.getUser(uid) || {};
      const pp = pass.ensure(up, Date.now());
      pass.addWagerXp(pp, bet, 'bet', Date.now());
      db.upsertUser(uid, { pass: pp });
    } catch (e) { console.error('dice pass xp:', e.message); }
    leagueXp(uid, 'dice_star', bet);
    result = { won, value, payout, nb };
  } finally {
    balanceLocks.delete(uid);
  }
  if (!result) return;

  // Показуємо результат, коли анімація кубика догра́є. Гроші вже на балансі.
  await sleep(({ '🎰': 3600, '🎲': 4300, '🎯': 4300, '🎳': 4600, '🏀': 4900, '⚽': 4900 })[g.emoji] || 4500);
  const rows = [
    [callbackBtn('Ще раз', `dice_b_${gameId}_${bet}`, 'success', 'starIcon')],
    [callbackBtn('✏️ Змінити ставку', `dice_own_${gameId}`, 'primary', 'starIcon')],
    [callbackBtn('Інша гра', 'dice_menu', 'primary', 'starIcon')],
  ];
  await ctx.reply(
    result.won
      ? `🎉 <b>Виграш!</b> ${g.emoji} ${diceResultText(g.emoji, result.value)}\n\n+${fmtStars(result.payout)}⭐ (ставка ${bet}⭐ × ${g.k})\nБаланс: <b>${fmtStars(result.nb)}⭐</b>`
      : `😔 Не пощастило. ${g.emoji} ${diceResultText(g.emoji, result.value)}\n\nСтавка ${bet}⭐ згоріла.\nБаланс: <b>${fmtStars(result.nb)}⭐</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
  ).catch(() => {});
});

// ==========================================================================
// СЕЗОННИЙ ПАС: видача нагород.
// Одна функція на бота і на WebApp — щоб нагорода не могла видатись двічі
// різними шляхами.
// ==========================================================================
async function grantPassReward(uid, level, track) {
  const u = db.getUser(uid);
  if (!u) return { ok: false, error: 'no_user' };

  const p = pass.ensure(u, Date.now());
  const r = pass.claim(p, level, track);
  if (!r.ok) { db.upsertUser(uid, { pass: p }); return r; }

  const rw = r.reward;
  const patch = { pass: p };
  const out = { ok: true, level, track: r.track, label: rw.label, type: rw.type, lines: [] };

  if (rw.type === 'stars') {
    patch.starBalance = Math.round(((u.starBalance || 0) + rw.amount) * 100) / 100;
    out.lines.push(`+${rw.amount}⭐`);
  } else if (rw.type === 'dailySpin') {
    patch.freeSpins = (u.freeSpins || 0) + rw.amount;
    out.lines.push(`+${rw.amount} безкоштовний спін щоденного колеса`);
  } else if (rw.type === 'paidSpin') {
    patch.paidSpinsGifted = (u.paidSpinsGifted || 0) + rw.amount;
    out.lines.push(`+${rw.amount} спін платного колеса (без списання балансу)`);
  } else if (rw.type === 'tickets') {
    addTickets(uid, rw.amount, 'нагорода пасу');
    out.lines.push(`+${rw.amount} 🎫`);
  } else if (rw.type === 'item') {
    // Предметні нагороди більше не використовуються — видаємо білети замість них.
    addTickets(uid, 3, 'нагорода пасу');
    out.lines.push('+3 🎫');
  } else if (rw.type === 'final') {
    patch.starBalance = Math.round(((u.starBalance || 0) + rw.stars) * 100) / 100;
    patch.paidSpinsGifted = (u.paidSpinsGifted || 0) + rw.paidSpin;
    const app_ = db.addApplication({
      uid, tierId: rw.prize, status: 'pending',
      createdAt: Date.now(), source: 'season_pass',
    });
    out.appId = app_.id;
    out.final = true;
    out.lines.push(`+${rw.stars}⭐`);
    out.lines.push(`+${rw.paidSpin} спін платного колеса`);
    out.lines.push('🧸 Мішка — заявка створена, адмін видасть подарунок');
    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID,
        `🎟 ПАС ПРОЙДЕНО ПОВНІСТЮ\nЮзер: ${uid} ${u.username ? '@' + u.username : ''}\nЗаявка #${app_.id} на Мішку.`
      ).catch(() => {});
    }
  }
  db.upsertUser(uid, patch);
  return out;
}



function passText(uid) {
  const u = db.getUser(uid) || {};
  const v = pass.view(pass.ensure(u, Date.now()), Date.now());
  const filled = Math.round(v.xpInLevel / v.levelXp * 10);
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);

  let next = null;
  for (let i = v.level + 1; i <= v.maxLevel; i++) {
    if (pass.REWARDS[i]) { next = { level: i, label: pass.REWARDS[i].label }; break; }
  }

  return `🎟 <b>Сезонний пас</b> · рівень <b>${v.level}</b> з ${v.maxLevel}\n\n` +
    `${bar}  ${v.xpInLevel}/${v.levelXp} XP\n` +
    `До наступного рівня: <b>${v.toNext} XP</b>\n` +
    `Днів до кінця сезону: <b>${v.daysLeft}</b>\n\n` +
    `<b>Як качати:</b>\n` +
    `• ставка в іграх — ${pass.XP_PER_STAR_BET} XP за кожну ⭐\n` +
    `• спін платного колеса — ${pass.XP_PER_STAR_SPIN} XP за ⭐ (спін 15⭐ = 45 XP)\n` +
    `Сьогодні з обороту: ${v.wagerXpDay}/${v.wagerXpCap} XP\n\n` +
    (next ? `Наступна нагорода — рівень ${next.level}: <b>${next.label}</b>\n` : '') +
    (v.premium
      ? `💎 <b>Платна лінія відкрита</b>\n`
      : `🔒 Платна лінія: ${v.price}⭐\n` +
        (v.pendingPremium
          ? `   На ній уже чекає <b>${v.pendingPremium} нагород</b> за пройдені рівні\n`
          : '')) +
    `<b>Фінал платної лінії (рівень 30): Мішка 🧸 + платний спін + 30⭐</b>\n\n` +
    (v.claimable.length
      ? `✅ Готово забрати: ${v.claimable.length} нагород`
      : 'Незабраних нагород немає.');
}

bot.action('pass_show', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (!(await requireSubscribed(ctx, uid))) return;
  const u = db.getUser(uid) || {};
  const v = pass.view(pass.ensure(u, Date.now()), Date.now());
  const rows = [];
  if (v.claimable.length) rows.push([callbackBtn('🎁 Забрати все відкрите', 'pass_claim_all', 'success', 'starIcon')]);
  if (!v.premium) {
    rows.push([callbackBtn(`💎 Telegram Stars — ${v.priceXtr}⭐ (+2 рівні)`, 'pass_buy_xtr', 'danger', 'starIcon')]);
    rows.push([callbackBtn(`💰 З балансу — ${v.price}⭐`, 'pass_buy', 'primary', 'starIcon')]);
  }
  rows.push([callbackBtn('🎲 До ігор', 'dice_menu', 'primary', 'starIcon')]);
  rows.push([callbackBtn('Назад', 'back_to_menu', undefined, 'back')]);

  // Фото мішки показуємо завжди: людина має бачити, заради чого качає пас.
  try {
    await ctx.replyWithPhoto(media.photo('bear'), {
      caption: passText(uid), parse_mode: 'HTML', ...Markup.inlineKeyboard(rows),
    });
  } catch (e) {
    await ctx.reply(passText(uid), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  }
});

bot.command('pass', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!(await requireSubscribed(ctx, uid))) return;
  try {
    await ctx.replyWithPhoto(media.photo('bear'), {
      caption: passText(uid), parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[callbackBtn('🎁 Забрати нагороди', 'pass_claim_all', 'success', 'starIcon')]]),
    });
  } catch (e) {
    await ctx.reply(passText(uid), { parse_mode: 'HTML' });
  }
});

bot.action('pass_claim_all', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (balanceLocks.has(uid)) return ctx.reply('⏳ Зачекай секунду.');
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid) || {};
    const list = pass.claimable(pass.ensure(u, Date.now()));
    if (!list.length) return ctx.reply('Поки нема чого забирати. Качай пас ставками й спінами.');

    const lines = [];
    let final = false;
    for (const c of list) {
      const r = await grantPassReward(uid, c.level, c.track);
      if (r.ok) {
        lines.push(`Рівень ${c.level} (${c.track === 'prem' ? 'платна' : 'безкоштовна'}): ${r.lines.join(', ')}`);
        if (r.final) final = true;
      }
    }
    const bal = Math.round(((db.getUser(uid) || {}).starBalance || 0) * 100) / 100;
    await ctx.reply(
      `🎁 <b>Нагороди забрані</b>\n\n${lines.join('\n')}\n\nБаланс: <b>${bal}⭐</b>`,
      { parse_mode: 'HTML' }
    );
    if (final) {
      await ctx.replyWithPhoto(media.photo('bear'), {
        caption: '🧸 <b>Пас пройдено повністю!</b>\n\nЗаявку на Мішку створено — адмін видасть подарунок найближчим часом.',
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  } finally {
    balanceLocks.delete(uid);
  }
});

bot.action('pass_buy', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  if (balanceLocks.has(uid)) return ctx.reply('⏳ Зачекай секунду.');
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid) || {};
    const p = pass.ensure(u, Date.now());
    const bal = u.starBalance || 0;
    const r = pass.buy(p, bal, 'balance');
    if (!r.ok) {
      if (r.error === 'already_premium') return ctx.reply('Платна лінія вже відкрита.');
      return ctx.reply(
        `Для платної лінії треба ${pass.PREMIUM_PRICE}⭐, у тебе ${Math.round(bal * 100) / 100}⭐.\n\n` +
        'Поповнити можна кнопкою «+» біля балансу в застосунку.'
      );
    }
    db.upsertUser(uid, { pass: p, starBalance: Math.round((bal - r.price) * 100) / 100 });
    await ctx.replyWithPhoto(media.photo('bear'), {
      caption: `💎 <b>Платну лінію відкрито</b>\n\nСписано ${r.price}⭐.\n` +
        (r.unlocked ? `Одразу доступно нагород: <b>${r.unlocked}</b>.\n` : '') +
        'Фінал на 30 рівні — Мішка, спін платного колеса і 30⭐.',
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[callbackBtn('🎁 Забрати нагороди', 'pass_claim_all', 'success', 'starIcon')]]),
    }).catch(() => {});
  } finally {
    balanceLocks.delete(uid);
  }
});

bot.action('pass_buy_xtr', async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  const u = db.getUser(uid) || {};
  const p = pass.ensure(u, Date.now());
  if (p.premium) return ctx.reply('Платна лінія вже відкрита.');
  try {
    await ctx.replyWithInvoice({
      title: 'Платна лінія сезонного пасу',
      description: 'Нагороди на кожному рівні, фінал — Мішка, спін платного колеса і 30⭐. Плюс 2 рівні одразу.',
      payload: JSON.stringify({ uid, type: 'pass_premium', ts: Date.now() }),
      currency: 'XTR',
      prices: [{ label: 'Платна лінія пасу', amount: pass.PREMIUM_PRICE_XTR }],
    });
  } catch (e) {
    console.error('pass invoice (bot) failed:', e.message);
    await ctx.reply('Не вдалось створити рахунок. Спробуй ще раз або купи з балансу.');
  }
});

app.post('/api/pass/buy', (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid) || {};
    const p = pass.ensure(u, Date.now());
    const bal = u.starBalance || 0;
    const r = pass.buy(p, bal, 'balance');
    if (!r.ok) return res.json({ ok: false, error: r.error, price: pass.PREMIUM_PRICE, balance: bal });
    const nb = Math.round((bal - r.price) * 100) / 100;
    db.upsertUser(uid, { pass: p, starBalance: nb });
    res.json({ ok: true, price: r.price, unlocked: r.unlocked, balance: nb, state: pass.view(p, Date.now()) });
  } finally {
    balanceLocks.delete(uid);
  }
});



// ---------------------------------------------------------------------------
// «ЩО РОБИТИ ЗАРАЗ» — головний екран. Замість пʼяти вкладок людина бачить
// три конкретні дії на сьогодні. Це лікує і незрозумілість, і залучення:
// не треба розбиратись у системах, достатньо зробити те, що згори.
// Жива стрічка: що виграють інші просто зараз. Найсильніше, що можна
// додати безкоштовно — людина бачить, що бот живий і тут справді дають.
app.get('/api/live', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  // Беремо не лише колесо: призи видаються з магазину, сходів, паса,
  // подій і банку. Раніше стрічка бачила тільки колесо, де приз 1 із 150 —
  // тому здавалось, що хорошого ніхто не виграє.
  const SRC = {
    shop: 'купив', ladder: 'за друзів', season_pass: 'із паса',
    goal: 'за спільну ціль', giveaway: 'у розіграші', event: 'у події',
    password_challenge: 'за виклик', external_ref: 'за реферала',
    temu: 'за завдання', lesson: 'за урок', bank: 'забрав банк',
  };

  const apps = (db.listApplications() || [])
    .filter(a => a.tierId && a.tierId !== 'stars_payout' && SRC[a.source])
    .slice(-60)
    .map(a => {
      const au = db.getUser(a.uid) || {};
      return {
        uid: a.uid, ts: a.createdAt || 0,
        name: au.username ? '@' + au.username : (au.name || 'гравець'),
        tier: a.tierId, how: SRC[a.source],
      };
    });

  const log = (db.getWheelLog() || []).slice(-120).reverse();
  const out = [];
  const seen = {};

  // Спершу призи з інших джерел — вони найцікавіші.
  for (const a of apps.sort((x, y) => y.ts - x.ts)) {
    if (out.length >= 6) break;
    seen[a.uid] = (seen[a.uid] || 0) + 1;
    if (seen[a.uid] > 2) continue;
    out.push({
      name: a.name, what: CFG.getTier(a.tier).name, kind: 'prize',
      how: a.how, at: a.ts, me: String(a.uid) === String(uid),
    });
  }

  for (const e of log) {
    if (out.length >= 14) break;
    if (!e || !e.extra || !e.extra.outcomeId) continue;
    const o = e.extra.outcomeId;

    // Дрібні зірки не показуємо — стрічка має бути про приємне.
    const isSpec = SPECIAL_OUTCOME_IDS.includes(o);
    const isTix = String(o).indexOf('tix') === 0;
    const amt = isSpec || isTix ? 0 : parseInt(String(o).replace('star', ''), 10) || 0;
    if (!isSpec && !isTix && amt < 5) continue;

    // Не більше двох записів на людину, щоб один гравець не забив стрічку.
    seen[e.uid] = (seen[e.uid] || 0) + 1;
    if (seen[e.uid] > 2) continue;

    const nm = e.username ? '@' + e.username : (e.name || 'гравець');
    let what, kind;
    if (isSpec) { what = CFG.getTier(o).name; kind = 'prize'; }
    else if (isTix) { what = '+' + String(o).replace('tix', '') + ' білет'; kind = 'tix'; }
    else { what = '+' + amt + '⭐'; kind = 'star'; }

    out.push({
      name: nm, what, kind, at: e.ts || 0,
      me: String(e.uid) === String(uid),
    });
  }

  res.json({ items: out });
});


// ---------------------------------------------------------------------------
// 🏆 ЛІГА ТИЖНЯ — API й підбиття підсумків.
function leagueName(u, uid) {
  return u && u.username ? '@' + u.username : ((u && u.name) || 'гравець');
}

function rewardText(items) {
  return items.map(function (it) {
    if (it.type === 'tier') { const t = CFG.getTier(it.id); return t.emoji + ' ' + t.name; }
    if (it.type === 'stars') return it.n + '⭐';
    if (it.type === 'tickets') return it.n + '🎫';
    return '';
  }).join(' + ');
}


// ---------------------------------------------------------------------------
// 🖼 АВАТАРКИ. Сервер бере фото профілю через бота й віддає застосунку сам.
// Посилання на файл містить токен бота, тому клієнту його не показуємо —
// лише байти картинки. Кешуємо в пам'яті, щоб не смикати Telegram щоразу.
const AVATAR_TTL = 6 * 3600 * 1000;
const AVATAR_MISS_TTL = 3600 * 1000;
const avatarCache = new Map();   // uid -> { at, buf, type } або { at, miss: true }
const avatarInflight = new Map();

async function fetchAvatar(uid) {
  const ph = await bot.telegram.getUserProfilePhotos(Number(uid), 0, 1);
  if (!ph || !ph.total_count || !ph.photos || !ph.photos[0] || !ph.photos[0].length) return null;
  const sizes = ph.photos[0];
  const pick = sizes.find(s => s.width >= 160) || sizes[sizes.length - 1];
  const link = await bot.telegram.getFileLink(pick.file_id);
  const r = await fetch(String(link));
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, type: r.headers.get('content-type') || 'image/jpeg' };
}

app.get('/api/avatar/:uid', async (req, res) => {
  const uid = String(req.params.uid || '').replace(/\D/g, '');
  if (!uid || !db.getUser(uid) || leagueExcluded(uid)) return res.status(404).end();

  const hit = avatarCache.get(uid);
  if (hit && Date.now() - hit.at < (hit.miss ? AVATAR_MISS_TTL : AVATAR_TTL)) {
    if (hit.miss) return res.status(404).end();
    res.set('Content-Type', hit.type);
    res.set('Cache-Control', 'public, max-age=21600');
    return res.send(hit.buf);
  }

  try {
    if (!avatarInflight.has(uid)) avatarInflight.set(uid, fetchAvatar(uid).finally(() => avatarInflight.delete(uid)));
    const got = await avatarInflight.get(uid);
    if (!got) { avatarCache.set(uid, { at: Date.now(), miss: true }); return res.status(404).end(); }
    avatarCache.set(uid, { at: Date.now(), buf: got.buf, type: got.type });
    if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
    res.set('Content-Type', got.type);
    res.set('Cache-Control', 'public, max-age=21600');
    res.send(got.buf);
  } catch (e) {
    avatarCache.set(uid, { at: Date.now(), miss: true });
    res.status(404).end();
  }
});

app.get('/api/league', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  if (!LEAGUE_ENABLED) return res.json({ disabled: true });
  const now = Date.now();
  const rows = league.standings(leagueUsers(), now);
  const meRow = rows.find(r => String(r.uid) === String(uid));
  const me = db.getUser(uid) || {};
  const myL = (me.league && me.league.week === league.weekKey(now)) ? me.league : { xp: 0, bySrc: {} };

  let gap = null;
  if (meRow && meRow.rank > 1) gap = Math.ceil((rows[meRow.rank - 2].xp - meRow.xp + 0.01) * 100) / 100;
  else if (!meRow && rows.length) gap = Math.ceil((rows[Math.min(9, rows.length - 1)].xp + 0.01) * 100) / 100;

  const lflags = db.getFeatureFlags() || {};
  const paused = !!lflags.leaguePaused;
  res.json({
    paused,
    startsAt: lflags.leagueStartsAt && lflags.leagueStartsAt > now ? lflags.leagueStartsAt : null,
    launchBonus: (function () {
      const lb = lflags.leagueLaunchBonus;
      if (!lb || !lb.race) return null;
      const w = lb.winners || [];
      if (w.length >= lb.count) return null;
      return {
        count: lb.count, minXp: lb.minXp, left: lb.count - w.length,
        taken: w.map(x => {
          const wu = db.getUser(x.uid) || {};
          return { name: wu.username ? '@' + wu.username : (wu.name || 'гравець'), me: String(x.uid) === String(uid) };
        }),
      };
    })(),
    week: league.weekKey(now),
    endsAt: league.weekEnd(now),
    serverNow: now,
    players: rows.length,
    top: rows.slice(0, 10).map(r => {
      // Приз показуємо всім у призовій зоні, але тим, хто не добрав мінімум,
      // позначаємо як заблокований — інакше незрозуміло, чому в сусіда є
      // іконка, а в тебе ні.
      const it = league.rewardFor(r.rank);
      const locked = r.xp < league.MIN_XP_FOR_PRIZE;
      return {
        rank: r.rank, name: leagueName(r.u, r.uid), xp: r.xp,
        photo: '/api/avatar/' + r.uid,
        me: String(r.uid) === String(uid),
        prize: it && !locked ? rewardText(it) : null,
        prizeItems: it || null,
        prizeLocked: !!(it && locked),
        needXp: locked ? Math.ceil((league.MIN_XP_FOR_PRIZE - r.xp) * 100) / 100 : 0,
      };
    }),
    me: {
      rank: meRow ? meRow.rank : null,
      xp: myL.xp || 0,
      bySrc: myL.bySrc || {},
      gapToNext: gap,
      prize: meRow && meRow.xp >= league.MIN_XP_FOR_PRIZE && league.rewardFor(meRow.rank)
        ? rewardText(league.rewardFor(meRow.rank)) : null,
      prizeItems: meRow ? league.rewardFor(meRow.rank) : null,
      prizeLocked: !!(meRow && league.rewardFor(meRow.rank) && meRow.xp < league.MIN_XP_FOR_PRIZE),
      needXp: meRow && meRow.xp < league.MIN_XP_FOR_PRIZE
        ? Math.ceil((league.MIN_XP_FOR_PRIZE - meRow.xp) * 100) / 100 : 0,
      photo: leagueExcluded(uid) ? null : '/api/avatar/' + uid,
      name: leagueName(me, uid),
    },
    rewards: league.REWARDS.map(r => ({
      place: r.from === r.to ? String(r.from) : r.from + '–' + r.to,
      text: rewardText(r.items),
      items: r.items,
    })),
    xpTable: league.XP,
    minXp: league.MIN_XP_FOR_PRIZE,
    participationXp: league.PARTICIPATION_XP,
    participationTickets: league.PARTICIPATION_TICKETS,
  });
});

// Видача призів за завершений тиждень. Позначка в прапорцях не дасть видати двічі.
async function finalizeLeague(wk) {
  const flags = db.getFeatureFlags() || {};
  const done = flags.leagueDone || {};
  if (done[wk]) return { ok: false, error: 'already' };
  done[wk] = Date.now();
  db.setFeatureFlags({ leagueDone: done });

  const rows = league.standingsFor(leagueUsers(), wk);
  const winners = [];

  for (const r of rows) {
    const items = r.xp >= league.MIN_XP_FOR_PRIZE ? league.rewardFor(r.rank) : null;
    const lines = [];
    if (items) {
      for (const it of items) {
        if (it.type === 'tier') {
          const a = db.addApplication({ uid: r.uid, tierId: it.id, status: 'pending', createdAt: Date.now(), source: 'league' });
          lines.push(CFG.getTier(it.id).name + ' (заявка #' + a.id + ')');
        } else if (it.type === 'stars') {
          const uu = db.getUser(r.uid) || {};
          db.upsertUser(r.uid, { starBalance: Math.round(((uu.starBalance || 0) + it.n) * 100) / 100 });
          lines.push(it.n + '⭐');
        } else if (it.type === 'tickets') {
          addTickets(r.uid, it.n, 'ліга тижня');
          lines.push(it.n + '🎫');
        }
      }
      winners.push('#' + r.rank + ' ' + leagueName(r.u, r.uid) + ' — ' + r.xp + ' XP → ' + rewardText(items));
    } else if (r.xp >= league.PARTICIPATION_XP) {
      addTickets(r.uid, league.PARTICIPATION_TICKETS, 'участь у лізі');
      lines.push(league.PARTICIPATION_TICKETS + '🎫 за участь');
    }

    if (lines.length) {
      bot.telegram.sendMessage(r.uid,
        (items ? '🏆 <b>Ліга тижня: ти #' + r.rank + '!</b>' : '🏆 <b>Ліга тижня завершилась</b>') +
        '\n\nТвої XP: <b>' + r.xp + '</b>\nНагорода: <b>' + lines.join(' + ') + '</b>' +
        '\n\nНова ліга вже почалась — удачі! 🚀',
        { parse_mode: 'HTML' }).catch(() => {});
      await new Promise(x => setTimeout(x, 80));
    }
  }

  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID,
      '🏆 Ліга ' + wk + ' завершена\nУчасників: ' + rows.length + '\n\n' +
      (winners.length ? winners.join('\n') : 'Ніхто не набрав мінімум ' + league.MIN_XP_FOR_PRIZE + ' XP')
    ).catch(() => {});
  }
  return { ok: true, players: rows.length, winners: winners.length };
}

// Раз на хвилину перевіряємо, чи не почався новий тиждень.
function leagueTick() {
  if (!LEAGUE_ENABLED) return;
  try {
    const cur = league.weekKey(Date.now());
    const flags = db.getFeatureFlags() || {};
    if (!flags.leagueWeek) { db.setFeatureFlags({ leagueWeek: cur }); return; }
    if (flags.leaguePaused || (flags.leagueStartsAt && Date.now() < flags.leagueStartsAt)) {
      db.setFeatureFlags({ leagueWeek: cur }); return;
    }
    if (flags.leagueWeek !== cur) {
      const prev = flags.leagueWeek;
      db.setFeatureFlags({ leagueWeek: cur });
      finalizeLeague(prev).catch(e => console.error('finalizeLeague:', e.message));
    }
  } catch (e) { console.error('leagueTick:', e.message); }
}
setInterval(leagueTick, 60000);
setTimeout(leagueTick, 5000);


// ---------------------------------------------------------------------------
// 🛑 КЕРУВАННЯ ІВЕНТАМИ. /event_status показує, що зараз іде, /event_stop
// зупиняє. Раніше зупинки не було зовсім — запустив і жди кінця.
function activeEvents() {
  const out = [];
  const now = Date.now();

  const ev = db.getEvent();
  if (ev && ev.active) {
    out.push({ key: 'event', label: '🎉 Подія (' + (ev.name || 'без назви') + ')',
      info: ev.endsAt ? 'до ' + new Date(ev.endsAt).toLocaleString('uk-UA') : 'без терміну' });
  }

  const pc = db.getPasswordChallenge();
  if (pc && pc.active) out.push({ key: 'password', label: '🔑 Виклик з паролем', info: 'слово: ' + (pc.password || '—') });

  const b = getBank();
  if (b && b.status === 'open') {
    out.push({ key: 'bank', label: '🏦 Спільний банк',
      info: 'банк ' + bank.totalPot(b) + ', учасників ' + b.order.length +
            ', розіграш ' + new Date(b.drawAt).toLocaleString('uk-UA') });
  }

  const f = db.getFeatureFlags() || {};
  if (f.goalActive || (f.goalCount != null && !f.goalDone)) {
    out.push({ key: 'goal', label: '🎯 Спільна ціль', info: 'прогрес ' + (f.goalCount || 0) });
  }

  if (LEAGUE_ENABLED && !f.leaguePaused) {
    const rowsE = league.standings(leagueUsers(), now);
    out.push({ key: 'league', label: '🏆 Ліга тижня',
      info: 'учасників ' + rowsE.length + ', підсумки ' + new Date(league.weekEnd(now)).toLocaleString('uk-UA') });
  }

  const gs = (db.allGiveaways ? db.allGiveaways() : {}) || {};
  for (const [gid, g] of Object.entries(gs)) {
    if (g && g.active && (!g.endsAt || g.endsAt > now)) {
      out.push({ key: 'giveaway:' + gid, label: '🎁 Розіграш #' + gid,
        info: 'учасників ' + Object.keys(g.participants || {}).length });
    }
  }
  return out;
}

bot.command('event_status', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const list = activeEvents();
  if (!list.length) return ctx.reply('Зараз нічого не запущено.');
  let t = '🟢 Зараз іде:\n\n';
  list.forEach((e, i) => { t += (i + 1) + '. ' + e.label + '\n   ' + e.info + '\n   зупинити: /event_stop ' + e.key + '\n\n'; });
  t += 'Зупинити все: /event_stop all так';
  await ctx.reply(t);
});

bot.command('event_stop', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const key = (parts[0] || '').trim();
  const yes = (parts[1] || '').toLowerCase() === 'так';

  if (!key) {
    const list = activeEvents();
    return ctx.reply(list.length
      ? 'Що зупинити?\n\n' + list.map(e => '• ' + e.label + ' → /event_stop ' + e.key).join('\n') +
        '\n\nУсе одразу: /event_stop all так'
      : 'Зараз нічого не запущено.');
  }

  const stopped = [];

  async function stopOne(k) {
    if (k === 'event') {
      const ev = db.getEvent();
      if (ev) { ev.active = false; ev.endsAt = Date.now(); db.setEvent(ev); stopped.push('подію'); }
    } else if (k === 'password') {
      const pc = db.getPasswordChallenge();
      if (pc) { pc.active = false; db.setPasswordChallenge(pc); stopped.push('виклик з паролем'); }
    } else if (k === 'goal') {
      db.setFeatureFlags({ goalActive: false, goalDone: true });
      stopped.push('спільну ціль');
    } else if (k === 'bank') {
      // Банк зупиняємо з поверненням ставок — інакше люди втратять вкладене.
      const b = getBank();
      if (b && b.status === 'open') {
        const r = refundBank(b, 'Банк скасовано адміністратором.');
        b.status = 'cancelled';
        saveBank(b);
        stopped.push('банк (повернуто ' + r.players + ' ставок)');
      }
    } else if (k === 'league') {
      db.setFeatureFlags({ leaguePaused: true });
      stopped.push('лігу тижня (XP більше не нараховується)');
    } else if (k.indexOf('giveaway:') === 0) {
      const gid = k.split(':')[1];
      const g = db.getGiveaway(gid);
      if (g) { g.active = false; db.setGiveaway(gid, g); stopped.push('розіграш #' + gid); }
    }
  }

  if (key === 'all') {
    if (!yes) return ctx.reply('⚠️ Зупинити ВСІ івенти?\n\nПідтвердь: /event_stop all так');
    for (const e of activeEvents()) await stopOne(e.key);
  } else {
    await stopOne(key);
  }

  await ctx.reply(stopped.length ? '🛑 Зупинено: ' + stopped.join(', ') : 'Нічого не знайшов за ключем «' + key + '».');
});

bot.command('event_start', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(
    'Запуск івентів:\n\n' +
    '🏦 /bank_start 2026-09-30 18:00 — спільний банк\n' +
    '🎯 /goal_reset — спільна ціль\n' +
    '🎁 /giveaway_start — розіграш\n' +
    '🔑 /password_challenge_start — виклик з паролем\n' +
    '🎉 /unlock_event — подія\n\n' +
    'Подивитись, що йде: /event_status\n' +
    'Зупинити: /event_stop'
  );
});

// Прибрати акаунт із ліги: /league_hide @username або /league_hide 123456
bot.command('league_hide', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const who = (ctx.message.text.split(/\s+/)[1] || '').replace('@', '').toLowerCase();
  if (!who) {
    const hid = (db.getFeatureFlags() || {}).leagueHidden || [];
    return ctx.reply('Формат: /league_hide @username\n\nЗараз приховано: ' + (hid.length ? hid.join(', ') : 'нікого') +
      '\nАдмін прихований завжди.\nПовернути: /league_unhide @username');
  }
  let uid = null;
  for (const [id, u] of Object.entries(db.allUsers())) {
    if (id === who || (u && u.username && u.username.toLowerCase() === who)) { uid = id; break; }
  }
  if (!uid) return ctx.reply('Не знайшов ' + who);
  const hid = new Set((db.getFeatureFlags() || {}).leagueHidden || []);
  hid.add(String(uid));
  db.setFeatureFlags({ leagueHidden: [...hid] });
  await ctx.reply('🙈 ' + who + ' прибрано з ліги. XP не нараховується, у таблиці не показується.');
});

bot.command('league_unhide', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const who = (ctx.message.text.split(/\s+/)[1] || '').replace('@', '').toLowerCase();
  let uid = null;
  for (const [id, u] of Object.entries(db.allUsers())) {
    if (id === who || (u && u.username && u.username.toLowerCase() === who)) { uid = id; break; }
  }
  const hid = ((db.getFeatureFlags() || {}).leagueHidden || []).filter(x => x !== String(uid));
  db.setFeatureFlags({ leagueHidden: hid });
  await ctx.reply('✅ ' + who + ' повернуто в лігу.');
});


// 🚀 Запуск ліги за розкладом: /league_start_at 2026-09-28 18:00
// До цього часу вкладка показує відлік і призи (прогрів), XP не рахується.
// Разом зі стартом вмикається бонус: 3 мішки серед тих, хто набере
// мінімум XP за перші 48 годин.
bot.command('league_start_at', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.replace(/^\/league_start_at(@\w+)?\s*/, '');
  const t = league.parseKyiv(arg);
  if (!t) return ctx.reply('Формат: /league_start_at 2026-09-28 18:00\n(час за Києвом)');
  if (t <= Date.now()) return ctx.reply('Цей час уже минув.');
  db.setFeatureFlags({
    leagueStartsAt: t,
    leaguePaused: false,
    leagueLaunchBonus: { count: 3, tier: 'bear', minXp: 100, until: t + 7 * 86400000, winners: [], done: false },
  });
  await ctx.reply(
    '🚀 Старт ліги: ' + new Date(t).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) + '\n\n' +
    'До старту у вкладці «Ліга» — відлік і призи.\n' +
    '🧸 Бонус: 3 мішки ПЕРШИМ ТРЬОМ, хто набере 100 XP.\n' +
    'Видаються автоматично, щойно хтось перетне поріг.\n' +
    'Стан гонки: /league_bears\n\n' +
    'Розсилка про старт: /league_announce так'
  );
});

// 🧸 Стан гонки за стартові мішки.
bot.command('league_bears', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const lb = (db.getFeatureFlags() || {}).leagueLaunchBonus;
  if (!lb) return ctx.reply('Стартовий бонус не налаштовано. Спершу /league_start_at');
  const w = lb.winners || [];
  let t = '🧸 Гонка за мішки (перші ' + lb.count + ', хто набере ' + lb.minXp + ' XP)\n\n';
  if (!w.length) t += 'Поки ніхто не дійшов.\n';
  w.forEach(function (x) {
    const u = db.getUser(x.uid) || {};
    t += x.place + '. ' + (u.username ? '@' + u.username : (u.name || x.uid)) +
         ' — ' + x.xp + ' XP · заявка #' + x.appId + '\n   ' +
         new Date(x.at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) + '\n';
  });
  const rows = league.standings(leagueUsers(), Date.now())
    .filter(function (r) { return !w.some(function (x) { return String(x.uid) === String(r.uid); }); })
    .slice(0, 5);
  if (w.length < lb.count && rows.length) {
    t += '\nНайближчі:\n' + rows.map(function (r) { return '  ' + leagueName(r.u, r.uid) + ' — ' + r.xp + ' XP'; }).join('\n');
  }
  await ctx.reply(t);
});

bot.command('league_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const targets = Object.entries(db.allUsers()).filter(([uid, u]) => u && u.lang && !u.remindersOff && !isAdminUid(uid));
  if ((ctx.message.text.split(' ')[1] || '').toLowerCase() !== 'так') {
    return ctx.reply('Розсилка про лігу\nОтримають: ' + targets.length + '\n\nЗапустити: /league_announce так');
  }
  const flags = db.getFeatureFlags() || {};
  const st = flags.leagueStartsAt && flags.leagueStartsAt > Date.now() ? flags.leagueStartsAt : null;
  const when = st ? new Date(st).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;

  const text =
    '🏆 <b>ЛІГА ТИЖНЯ ' + (st ? 'СТАРТУЄ ' + when.toUpperCase() : 'ВЖЕ ЙДЕ') + '</b>\n\n' +
    'Кожна дія в боті — це XP. Спін, друг, ставка, чат.\n' +
    'Щопонеділка топ забирає призи:\n\n' +
    '🥇 Трофей + 50🎫\n🥈 Ракета + 30🎫\n🥉 Подарунок + 20🎫\n' +
    '4–5 місце — Мішка + 10🎫\n6–10 місце — 10⭐ + 5🎫\n\n' +
    '🧸 <b>В честь старту — 3 мішки</b> серед тих, хто набере 30 XP за перші 2 дні.\n\n' +
    '<i>Навіть без грошей — щоденна активність веде в топ-10.</i>';

  const url = WEBAPP_URL ? WEBAPP_URL + (WEBAPP_URL.includes('?') ? '&' : '?') + 'tab=league' : null;
  await ctx.reply('Розсилаю ' + targets.length + '...');
  let sent = 0, failed = 0;
  for (const [uid] of targets) {
    try {
      await bot.telegram.sendMessage(uid, text, {
        parse_mode: 'HTML',
        ...(url ? { reply_markup: { inline_keyboard: [[{ text: '🏆 Відкрити лігу', web_app: { url } }]] } } : {}),
      });
      sent++;
    } catch (e) {
      failed++;
      if (String(e.message).includes('blocked') || String(e.message).includes('deactivated')) db.upsertUser(uid, { remindersOff: true });
    }
    await new Promise(r => setTimeout(r, 110));
  }
  await ctx.reply('✅ Надіслано: ' + sent + ', не дійшло: ' + failed);
});

bot.command('league_pause', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.setFeatureFlags({ leaguePaused: true });
  await ctx.reply('⏸ Лігу зупинено.\n\nXP більше не нараховується, підсумки не підбиваються.\nНабране лишається збереженим.\n\nВідновити: /league_resume');
});

bot.command('league_resume', async (ctx) => {
  if (!isAdmin(ctx)) return;
  db.setFeatureFlags({ leaguePaused: false, leagueWeek: league.weekKey(Date.now()) });
  await ctx.reply('▶️ Лігу відновлено. XP нараховується з цієї миті.');
});

bot.command('league_reset', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if ((ctx.message.text.split(' ')[1] || '').toLowerCase() !== 'так') {
    return ctx.reply('⚠️ Обнулити XP усім за поточний тиждень?\nПризи НЕ видаються.\n\nПідтвердь: /league_reset так');
  }
  let n = 0;
  for (const [uid, u] of Object.entries(db.allUsers())) {
    if (u && u.league && u.league.xp > 0) { db.upsertUser(uid, { league: null }); n++; }
  }
  await ctx.reply('🧹 Обнулено гравців: ' + n);
});


// ---------------------------------------------------------------------------
// 💬 Керування чатом.
bot.command('chat_status', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const s = chat.status();
  const f = (t) => t ? new Date(t).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) : '—';
  await ctx.reply(
    '💬 Чат ' + s.chatRef + (s.chatId ? ' (' + s.chatId + ')' : ' — ❌ НЕ ПІДКЛЮЧЕНО, додай бота адміном') + '\n' +
    'Стан: ' + (s.paused ? '⏸ на паузі' : '▶️ працює') + '\n\n' +
    '🎁 Наступний дроп: ' + f(s.nextDropAt) + '\n' +
    '🧠 Наступна вікторина: ' + f(s.nextQuizAt) + '\n' +
    '📣 Оголошень сьогодні: ' + (s.annCount || 0) + '\n\n' +
    'Зараз: /chat_drop · /chat_quiz · /chat_top\nПауза: /chat_pause · /chat_resume'
  );
});
bot.command('chat_drop', async (ctx) => { if (!isAdmin(ctx)) return; await ctx.reply((await chat.postDrop()) ? '🎁 Дроп у чаті' : '❌ Не вдалось — чат не підключено або на паузі'); });

// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ РОЗСИЛКИ Й ДІАГНОСТИКА ЧАТУ ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// Розсилка «відповіддю»: адмін пише боту в особисті будь-яке повідомлення (текст,
// фото, відео, з кнопками), відповідає на нього командою — бот копіює його куди треба.
function adminSource(ctx) {
  const r = ctx.message && ctx.message.reply_to_message;
  return r ? { from: ctx.chat.id, id: r.message_id } : null;
}
const pendingBroadcast = new Map();   // адмін -> { from, id, at }

// /chat_say текст — написати в чат від імені бота (HTML можна)
bot.command('chat_say', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = ctx.message.text.replace(/^\/chat_say(@\w+)?\s*/, '');
  if (!text) return ctx.reply('Формат: /chat_say текст\n\nАбо відповідь на повідомлення командою /chat_post — щоб переслати фото, відео чи кнопки.');
  if (!chat.chatId) return ctx.reply('❌ Чат не підключено — /chat_status');
  try { await bot.telegram.sendMessage(chat.chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }); await ctx.reply('✅ Надіслано в чат'); }
  catch (e) { await ctx.reply('❌ ' + e.message); }
});

// /chat_post [pin] — відповіддю на повідомлення: скопіювати його в чат (і закріпити)
bot.command('chat_post', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const src = adminSource(ctx);
  if (!src) return ctx.reply('Надішли боту повідомлення (текст, фото, відео…) і відповідай на нього:\n/chat_post — у чат\n/chat_post pin — у чат і закріпити');
  if (!chat.chatId) return ctx.reply('❌ Чат не підключено — /chat_status');
  try {
    const m = await bot.telegram.copyMessage(chat.chatId, src.from, src.id);
    if (/\bpin\b/i.test(ctx.message.text)) await bot.telegram.pinChatMessage(chat.chatId, m.message_id, { disable_notification: false }).catch(e => ctx.reply('⚠️ Не закріпив: ' + e.message));
    await ctx.reply('✅ Опубліковано в чаті' + (/\bpin\b/i.test(ctx.message.text) ? ' і закріплено 📌' : ''));
  } catch (e) { await ctx.reply('❌ ' + e.message); }
});

// /chats — усі групи, де є бот
bot.command('chats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const list = chat.listChats();
  if (!list.length) return ctx.reply('Бот поки не бачив жодної групи. Додай його в групу й напиши там щось.');
  await ctx.reply('💬 Групи з ботом (' + list.length + '):\n\n' +
    list.map((c, i) => (i + 1) + '. ' + (c.title || '—') + (c.username ? ' @' + c.username : '') + ' · ' + c.id).join('\n') +
    '\n\nРозіслати в усі: відповідай на повідомлення командою /post_all');
});

// /post_all — відповіддю на повідомлення: скопіювати в УСІ групи з ботом
bot.command('post_all', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const src = adminSource(ctx);
  if (!src) return ctx.reply('Відповідай командою /post_all на повідомлення, яке треба розіслати по всіх групах.');
  const list = chat.listChats();
  let ok = 0; const bad = [];
  for (const c of list) {
    try { await bot.telegram.copyMessage(c.id, src.from, src.id); ok++; }
    catch (e) { bad.push((c.title || c.id) + ': ' + e.message.slice(0, 60)); }
    await new Promise(r => setTimeout(r, 120));
  }
  await ctx.reply('✅ Розіслано по групах: ' + ok + ' з ' + list.length + (bad.length ? '\n\n⚠️ Не вдалось:\n' + bad.join('\n') : ''));
});

// /broadcast — відповіддю на повідомлення: розіслати ВСІМ гравцям в особисті
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const targets = Object.entries(db.allUsers()).filter(([id, u]) => u && u.lang && !u.remindersOff && !isAdminUid(id));
  const src = adminSource(ctx);
  // \b у JS працює лише з латиницею, тому «так» перевіряємо пробілами/межами рядка.
  const yes = /(^|\s)так(\s|$)/i.test(ctx.message.text);
  if (src) {
    pendingBroadcast.set(String(ctx.from.id), { ...src, at: Date.now() });
    try { await bot.telegram.copyMessage(ctx.chat.id, src.from, src.id); } catch (e) {}
    return ctx.reply('👆 Так побачать гравці.\nОтримають: ' + targets.length + '\n\nЗапустити: /broadcast так\nСкасувати — просто нічого не роби.');
  }
  const p = pendingBroadcast.get(String(ctx.from.id));
  if (!yes || !p || Date.now() - p.at > 30 * 60000) {
    return ctx.reply('Як розіслати всім в особисті:\n1. Надішли боту повідомлення (текст, фото, відео, з кнопками)\n2. Відповідай на нього командою /broadcast\n3. Підтверди: /broadcast так');
  }
  pendingBroadcast.delete(String(ctx.from.id));
  await ctx.reply('🚀 Розсилаю ' + targets.length + '… Прийде звіт.');
  let sent = 0, blocked = 0, failed = 0;
  for (const [id] of targets) {
    try { await bot.telegram.copyMessage(id, p.from, p.id); sent++; }
    catch (e) {
      const m = String(e.message);
      if (m.includes('blocked') || m.includes('deactivated') || m.includes('not found')) { blocked++; db.upsertUser(id, { remindersOff: true }); }
      else failed++;
    }
    await new Promise(r => setTimeout(r, 60));
  }
  await ctx.reply('✅ Розсилка завершена\n\nДоставлено: ' + sent + '\nЗаблокували бота: ' + blocked + '\nІнші помилки: ' + failed);
});

// /chat_debug — чому повідомлення можуть не рахуватись
bot.command('chat_debug', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const lines = ['🩺 Діагностика чату\n'];
  if (!chat.chatId) { lines.push('❌ Чат не підключено. Напиши в самому чаті /chat_here зі свого акаунта.'); return ctx.reply(lines.join('\n')); }
  lines.push('Чат: ' + chat.chatId);
  try {
    const me = await bot.telegram.getMe();
    const mem = await bot.telegram.getChatMember(chat.chatId, me.id);
    const isAdm = ['administrator', 'creator'].includes(mem.status);
    lines.push(isAdm ? '✅ Бот — адміністратор чату' : '❌ Бот НЕ адміністратор (' + mem.status + ') — Telegram не пересилає йому звичайні повідомлення. Зроби його адміном!');
    if (!isAdm) lines.push(me.can_read_all_group_messages ? '   (режим приватності вимкнено — повідомлення все одно мають доходити)' : '   Режим приватності ввімкнено — бот бачить лише команди.');
    if (isAdm && mem.can_delete_messages === false) lines.push('ℹ️ Без права видаляти повідомлення — для рахунку не потрібно.');
  } catch (e) { lines.push('⚠️ Не вдалось перевірити права: ' + e.message); }
  const d = chat.debugStats();
  lines.push('\n📊 Сьогодні бот отримав з чату:');
  lines.push('усього повідомлень: ' + (d.recv || 0) + ' (текст ' + (d.text || 0) + ', медіа ' + (d.media || 0) + ')');
  lines.push('від тих, хто не запускав бота: ' + (d.guests || 0) + ' — тепер теж рахуються');
  lines.push('зараховано як активність: ' + (d.counted || 0));
  lines.push('\nℹ️ Не рахуються: повідомлення частіше ніж раз на 5 с від однієї людини й короткі «ок», «+» (до 3 символів).');
  if (!d.recv) lines.push('\n⚠️ Сьогодні бот не отримав ЖОДНОГО повідомлення — майже напевно він не адмін або не в тому чаті.');
  await ctx.reply(lines.join('\n'));
});
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ РОЗСИЛКИ Й ДІАГНОСТИКА ЧАТУ ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲


// 🔒 Секретна /autowithdraw. Гравці бачать відсоток готовності автовиводу.
// Адмін в особистих: /autowithdraw 73 — задати відсоток, можна з підписом:
// /autowithdraw 73 Тестуємо перші виплати
bot.command('autowithdraw', async (ctx) => {
  const args = ctx.message.text.replace(/^\/autowithdraw(@\w+)?\s*/, '');
  if (isAdmin(ctx) && args) {
    const m = args.match(/^(\d{1,3})\s*%?\s*(.*)$/s);
    if (!m) return ctx.reply('Формат: /autowithdraw 73\nАбо з підписом: /autowithdraw 73 Тестуємо перші виплати');
    const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    const note = (m[2] || '').trim() === '-' ? '' : (m[2] || '').trim();
    db.setFeatureFlags({ autowd: { pct, note: note || null, at: Date.now() } });
    await ctx.reply(chat.autowdCard(), { parse_mode: 'HTML' }).catch(() => {});
    return ctx.reply('✅ Готовність: ' + pct + '%' + (note ? '\nПідпис: ' + note : '') + '\n\nЦе вже видно гравцям у команді й у вкладці застосунку.',
      Markup.inlineKeyboard([[callbackBtn('📣 Оголосити в чаті', 'aw_post', 'success')]]));
  }
  await ctx.reply(chat.autowdCard(), { parse_mode: 'HTML' }).catch(() => {});
  if (isAdmin(ctx)) await ctx.reply('Змінити: /autowithdraw 73\nЗ підписом: /autowithdraw 73 Тестуємо перші виплати\nПрибрати підпис: /autowithdraw 73 -');
});
bot.action('aw_post', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  if (!chat.chatId) return ctx.reply('❌ Чат не підключено');
  try { await bot.telegram.sendMessage(chat.chatId, chat.autowdCard(), { parse_mode: 'HTML' }); await ctx.reply('📣 Оголошено в чаті'); }
  catch (e) { await ctx.reply('❌ ' + e.message); }
});
// /version — перевірити, що на сервері справді остання версія
bot.command('version', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const up = Math.round((Date.now() - BOOT_AT) / 60000);
  await ctx.reply('📦 Версія застосунку: ' + (APP_BUILD || '—') +
    '\n⏱ Сервер працює: ' + (up < 60 ? up + ' хв' : Math.floor(up / 60) + ' год ' + (up % 60) + ' хв') +
    '\n💬 Чат: ' + (chat.chatId ? 'підключено' : '❌ не підключено') +
    '\n🧩 Лічба гостей і медіа: ✅ · обробка без черги: ✅ · час відправлення: ✅' +
    '\n\nЯкщо цих рядків немає — на сервері стара версія, перезалий файли.');
});
bot.command('chat_word', async (ctx) => { if (!isAdmin(ctx)) return; await ctx.reply((await chat.postRace()) ? '⚡ «Хто швидший» у чаті' : '❌ Не вдалось'); });
bot.command('chat_quiz', async (ctx) => { if (!isAdmin(ctx)) return; await ctx.reply((await chat.postQuiz()) ? '🧠 Вікторина в чаті' : '❌ Не вдалось'); });
bot.command('chat_top', async (ctx) => { if (!isAdmin(ctx)) return; await chat.postLeagueTop(); await ctx.reply('🏆 Таблицю надіслано в чат'); });
// 🏅 Змагання активності: /chat_contest 21:30 [кількість мішок]
bot.command('chat_contest', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const a = ctx.message.text.split(/\s+/).slice(1);
  const hm = (a[0] || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!hm) {
    return ctx.reply('Формат: /chat_contest 21:30 [мішок]\nНаприклад: /chat_contest 21:30 3\n\n' +
      'Змагання почнеться одразу й закінчиться сьогодні в цей час за Києвом.\n' +
      'Завершити раніше: /chat_contest_end');
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const endsAt = league.parseKyiv(today + ' ' + hm[1].padStart(2, '0') + ':' + hm[2]);
  if (!endsAt || endsAt <= Date.now()) return ctx.reply('Цей час сьогодні вже минув.');
  const count = Math.max(1, Math.min(10, parseInt(a[1], 10) || 3));
  if (!chat.chatId) return ctx.reply('❌ Чат не підключено — додай бота в @starforge_chat адміном.');
  await chat.startContest(endsAt, count, 'bear');
  await ctx.reply('🏅 Змагання запущено до ' + hm[1] + ':' + hm[2] + ', ' + count + ' мішки.\n' +
    'Оголошення вже в чаті. Підсумки — автоматично.\nЗараз: /chat_contest_status');
});

bot.command('chat_contest_status', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = chat.contestRows();
  if (!rows.length) return ctx.reply('Поки ніхто не набрав балів (або змагання не запущено).');
  let t = '🏅 Змагання — топ:\n\n';
  rows.slice(0, 10).forEach((r, i) => {
    const u = db.getUser(r.uid) || {};
    t += (i + 1) + '. ' + (u.username ? '@' + u.username : (u.name || r.uid)) + ' — ' + r.pts +
      ' (💬' + r.msg + ' ⚔️' + r.duel + '/' + r.win + ' 🎁' + r.drop + ' 🧠' + r.quiz + ')\n';
  });
  await ctx.reply(t);
});

bot.command('chat_contest_end', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const r = await chat.finishContest();
  await ctx.reply(r ? '🏁 Завершено. Учасників: ' + r.players + '\n\n' + (r.winners.join('\n') || 'Ніхто не набрав мінімум.') : 'Активного змагання немає.');
});

bot.command('chat_pause', async (ctx) => { if (!isAdmin(ctx)) return; chat.pause(); await ctx.reply('⏸ Чат-активності на паузі'); });
bot.command('chat_resume', async (ctx) => { if (!isAdmin(ctx)) return; chat.resume(); await ctx.reply('▶️ Чат-активності увімкнено'); });

chat.refundStaleDuels();                       // одразу, до перших апдейтів
setTimeout(() => { chat.resolveChat(); }, 8000);
setInterval(() => { if (!chat.chatId) chat.resolveChat(); }, 3600000);
setInterval(() => { chat.tick().catch(e => console.error('chat tick:', e.message)); }, 60000);

bot.command('league_stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const now = Date.now();
  const rows = league.standings(leagueUsers(), now);
  const left = league.weekEnd(now) - now;
  let t = '🏆 Ліга ' + league.weekKey(now) + '\nДо кінця: ' + Math.floor(left / 86400000) + ' дн ' +
          Math.floor((left % 86400000) / 3600000) + ' год\nУчасників: ' + rows.length + '\n\n';
  rows.slice(0, 15).forEach(r => {
    const it = r.xp >= league.MIN_XP_FOR_PRIZE ? league.rewardFor(r.rank) : null;
    t += '#' + r.rank + ' ' + leagueName(r.u, r.uid) + ' — ' + r.xp + ' XP' + (it ? ' → ' + rewardText(it) : '') + '\n';
  });
  await ctx.reply(t);
});

bot.command('league_finalize', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = (ctx.message.text.split(' ')[1] || '').trim();
  if (!arg) return ctx.reply('Формат: /league_finalize W2026-09-21\n(тиждень, який треба закрити вручну)');
  const r = await finalizeLeague(arg);
  await ctx.reply(r.ok ? '✅ Закрито: учасників ' + r.players + ', призерів ' + r.winners : '⚠️ ' + r.error);
});

// ---------------------------------------------------------------------------
// 🔄 ОБМІН БІЛЕТІВ НА ЗІРКИ — фіксований курс 10🎫 = 2⭐.
// Білет отримує зрозумілу ціну (0,2⭐), але курс нижчий за середню віддачу
// колеса за білети — тож обмін завжди «безпечний вихід», а не вигідніший шлях.
const TICKET_RATE_TICKETS = 10;
const TICKET_RATE_STARS = 2;

app.post('/api/tickets-convert', (req, res) => {
  const { initData, tickets } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const n = Math.floor(Number(tickets) || 0);
  if (n < TICKET_RATE_TICKETS || n % TICKET_RATE_TICKETS !== 0) {
    return res.status(400).json({ error: 'bad_amount', step: TICKET_RATE_TICKETS });
  }

  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found' });
    const have = ticketsOf(u);
    if (n > have) return res.status(402).json({ error: 'not_enough_tickets', have });

    const stars = n / TICKET_RATE_TICKETS * TICKET_RATE_STARS;
    addTickets(uid, -n, 'обмін на зірки');
    const u2 = db.getUser(uid) || {};
    const nb = Math.round(((u2.starBalance || 0) + stars) * 100) / 100;
    db.upsertUser(uid, { starBalance: nb });

    res.json({ ok: true, tickets: n, stars, balance: nb, ticketsLeft: ticketsOf(db.getUser(uid)) });
  } finally {
    balanceLocks.delete(uid);
  }
});



// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ ПАРТНЕРСЬКЕ ЗАВДАННЯ ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// Людина заходить у бот партнера за нашим посиланням і підписується на всіх
// його спонсорів. Перевірку робить адмін за списком рефералів у самого
// партнера — лише він знає, чи зарахувалось. Нагорода — після підтвердження.

const PARTNER = {
  on: true,
  name: 'GramTon Drop',
  link: process.env.PARTNER_LINK || 'https://t.me/gramtondropbot?start=ref_6280327267',
  stars: 3, tickets: 15, chatPts: 50,     // очки чату — великий стрибок рівня
  earlyCount: 20,                          // перші 20 — ×2
};

function partnerFlags() { return (db.getFeatureFlags() || {}).partner || {}; }
function partnerState(uid) {
  const f = partnerFlags();
  const u = db.getUser(uid) || {};
  const approved = f.approved || 0;
  return {
    on: PARTNER.on && f.off !== true,
    name: PARTNER.name, link: PARTNER.link,
    reward: { stars: PARTNER.stars, tickets: PARTNER.tickets, chatPts: PARTNER.chatPts },
    earlyLeft: Math.max(0, PARTNER.earlyCount - approved), earlyCount: PARTNER.earlyCount,
    done: approved,
    status: u.partnerStatus || null,
  };
}

app.get('/api/partner', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  res.json(partnerState(uid));
});

app.post('/api/partner-claim', (req, res) => {
  const uid = verifyInitData((req.body || {}).initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const s = partnerState(uid);
  if (!s.on) return res.status(403).json({ error: 'off' });
  if (s.status === 'done') return res.status(429).json({ error: 'already_done' });
  if (s.status === 'pending') return res.status(429).json({ error: 'pending' });
  if (isAdminUid(uid)) return res.status(403).json({ error: 'admin' });
  const u = db.getUser(uid) || {};
  db.upsertUser(uid, { partnerStatus: 'pending', partnerAt: Date.now() });
  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID,
      '🔐 Секретне завдання (' + PARTNER.name + ') — на перевірку\n' +
      (u.name || '—') + ' ' + (u.username ? '@' + u.username : '') + ' · id ' + uid + '\n\n' +
      'Перевір у ' + PARTNER.name + ', чи зарахувався реферал.',
      Markup.inlineKeyboard([[
        callbackBtn('Зарахувався', 'pk_ok_' + uid, 'success', 'check'),
        callbackBtn('Ні', 'pk_no_' + uid, 'danger', 'redCircle'),
      ]])).catch(() => {});
  }
  res.json({ ok: true, status: 'pending' });
});

bot.action(/^pk_ok_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const uid = ctx.match[1];
  const u = db.getUser(uid);
  if (!u) return ctx.reply('Не знайдено.');
  if (u.partnerStatus === 'done') return ctx.reply('Вже нараховано раніше.');
  const f = partnerFlags();
  const approved = f.approved || 0;
  const mult = approved < PARTNER.earlyCount ? 2 : 1;
  const stars = PARTNER.stars * mult, tickets = PARTNER.tickets * mult, pts = PARTNER.chatPts * mult;
  db.setFeatureFlags({ partner: { ...f, approved: approved + 1 } });
  db.upsertUser(uid, { partnerStatus: 'done', starBalance: Math.round(((u.starBalance || 0) + stars) * 100) / 100 });
  addTickets(uid, tickets, 'секретне завдання');
  const before = (db.getUser(uid) || {}).chatPts || 0;
  chat.addChatPts(uid, pts);
  const L = chat.levelOf(before + pts);
  await bot.telegram.sendMessage(uid,
    '🔓 <b>Секретне завдання виконано!</b>\n\n' + (mult > 1 ? '🔥 Ти серед перших — усе <b>×2</b>!\n\n' : '') +
    '⭐ +' + stars + ' зірок\n🎫 +' + tickets + ' білетів\n👑 +' + pts + ' очок чату — ти тепер <b>' + L.e + ' ' + L.t + '</b>', { parse_mode: 'HTML' }).catch(() => {});
  const nm = whoOf(u);
  chat.announce('🔓 <b>' + nm + '</b> розгадав секретне завдання: <b>+' + stars + '⭐ +' + tickets + '🎫 +' + pts + ' очок</b>' +
    (mult > 1 ? ' (×2 для перших!)' : '')).catch(() => {});
  await ctx.reply('✅ ' + nm + ': +' + stars + '⭐ +' + tickets + '🎫 +' + pts + ' очок' + (mult > 1 ? ' (×2)' : '') +
    '\nВиконань: ' + (approved + 1));
});

bot.action(/^pk_no_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const uid = ctx.match[1];
  db.upsertUser(uid, { partnerStatus: 'rejected' });
  await bot.telegram.sendMessage(uid,
    '🔒 <b>Секретне завдання поки не зараховано.</b>\n\nНайчастіше причина — підписка не на всіх спонсорів, або ти вже був у цьому боті раніше.\n' +
    'Перевір, підпишись на всіх — і подай ще раз.', { parse_mode: 'HTML' }).catch(() => {});
  await ctx.reply('Відхилено.');
});


bot.command('partner_stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  let pend = 0, done = 0, rej = 0;
  for (const u of Object.values(db.allUsers())) {
    if (!u) continue;
    if (u.partnerStatus === 'pending') pend++; else if (u.partnerStatus === 'done') done++; else if (u.partnerStatus === 'rejected') rej++;
  }
  const f = partnerFlags();
  await ctx.reply('🔐 ' + PARTNER.name + '\n\nЗараховано: ' + done + '\nНа перевірці: ' + pend + '\nВідхилено: ' + rej +
    '\n\n×2 лишилось: ' + Math.max(0, PARTNER.earlyCount - (f.approved || 0)) +
    '\n\n/partner_off — сховати завдання · /partner_on — показати');
});
bot.command('partner_off', async (ctx) => { if (!isAdmin(ctx)) return; db.setFeatureFlags({ partner: { ...partnerFlags(), off: true } }); await ctx.reply('Секретне завдання сховано.'); });
bot.command('partner_on', async (ctx) => { if (!isAdmin(ctx)) return; db.setFeatureFlags({ partner: { ...partnerFlags(), off: false } }); await ctx.reply('Секретне завдання знову видно.'); });

bot.command('partner_announce', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const targets = Object.entries(db.allUsers()).filter(([id, u]) => u && u.lang && !u.remindersOff && !isAdminUid(id) && !u.partnerStatus);
  if ((ctx.message.text.split(' ')[1] || '').toLowerCase() !== 'так') {
    return ctx.reply('Розсилка про секретне завдання\nОтримають: ' + targets.length + '\n\nЗапустити: /partner_announce так');
  }
  const url = WEBAPP_URL || null;
  await ctx.reply('Розсилаю ' + targets.length + '...');
  let sent = 0;
  for (const [id] of targets) {
    try {
      await bot.telegram.sendMessage(id,
        '🔐 <b>У боті відкрилось СЕКРЕТНЕ ЗАВДАННЯ</b>\n\n' +
        'Кілька хвилин — і забираєш:\n' +
        '⭐ <b>+' + PARTNER.stars + ' зірок</b>\n🎫 <b>+' + PARTNER.tickets + ' білетів</b>\n👑 <b>+' + PARTNER.chatPts + ' очок чату</b> — одразу стрибок рівня\n\n' +
        '🔥 <b>Перші ' + PARTNER.earlyCount + ' отримують усе ×2</b>',
        { parse_mode: 'HTML', ...(url ? { reply_markup: { inline_keyboard: [[{ text: '🔓 Відкрити завдання', web_app: { url } }]] } } : {}) });
      sent++;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 110));
  }
  await ctx.reply('✅ Надіслано: ' + sent);
});
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ ПАРТНЕРСЬКЕ ЗАВДАННЯ ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

app.get('/api/today', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const u = db.getUser(uid) || {};
  const acts = [];

  // 1. Безкоштовний спін — найпростіше й завжди перше.
  const canFree = !u.lastDailySpinAt || (Date.now() - u.lastDailySpinAt >= 86400000);
  if (!canFree && (u.freeSpins || 0) > 0) {
    acts.push({
      id: 'bonus', icon: '🎁', title: 'Бонусних спінів: ' + u.freeSpins,
      sub: 'Крути щоденне колесо без очікування', go: 'screenSpin', tab: 'daily', priority: 100,
    });
  } else if (canFree) {
    acts.push({
      id: 'daily', icon: '🎰', title: 'Крутни безкоштовний спін',
      sub: 'Від 2⭐, білети або NFT', go: 'screenSpin', tab: 'daily', priority: 100,
    });
  } else {
    const left = u.lastDailySpinAt + 86400000 - Date.now();
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
    acts.push({
      id: 'daily_wait', icon: '⏳', title: 'Спін буде через ' + h + ' год ' + m + ' хв',
      sub: 'Повернись — він безкоштовний', go: 'screenSpin', tab: 'daily', done: true, priority: 10,
    });
  }

  // 2. Банк — головна подія, тому високо, поки триває.
  const b = getBank();
  if (b && b.status === 'open') {
    const mine = b.bets[uid] || 0;
    const ms = bank.milestones(b);
    acts.push({
      id: 'bank', icon: '🏦',
      title: mine ? 'Твоя ставка в банку: ' + mine : 'Постав у спільний банк',
      sub: mine
        ? 'Шанс ' + bank.chance(b, uid) + '% · банк ' + bank.totalPot(b)
        : 'Банк ' + bank.totalPot(b) + ' · до віхи ' + (ms.next ? ms.toNext : 0),
      go: 'screenSpin', scroll: 'bankBlock', done: mine > 0, priority: 95,
    });
  }

  // 3. Білети: вистачає на спін колеса «За білети».
  const tk = ticketsOf(u);
  if (tk >= TICKETS_PER_SPIN) {
    acts.push({
      id: 'tix', icon: '🎫', title: 'Білетів: ' + tk + ' — вистачає на ' + Math.floor(tk / TICKETS_PER_SPIN) + ' спін.',
      sub: TICKETS_PER_SPIN + '🎫 за спін колеса «За білети»', go: 'screenSpin', tab: 'referral', priority: 70,
    });
  }

  // 4. Питання дня — ще один бонусний спін.
  if (u.quizDay !== todayKey()) {
    acts.push({
      id: 'quiz', icon: '🧠', title: 'Питання дня',
      sub: 'Правильна відповідь — бонусний спін', go: 'screenSpin', tab: 'daily', scroll: 'quizBlock', priority: 60,
    });
  }

  // 5. Реферали — найдорожчий квест, тому окремо.
  if ((u.invitedIds || []).length === 0) {
    acts.push({
      id: 'invite', icon: '👥', title: 'Запроси друга',
      sub: '+1🎫 за кожного друга · 5🎫 = спін', go: 'screenProfile', priority: 55,
    });
  }

  acts.sort((x, y) => (y.priority || 0) - (x.priority || 0));

  res.json({
    name: u.name || '',
    balance: Math.round((u.starBalance || 0) * 100) / 100,
    tickets: ticketsOf(u),
    streak: u.dailyStreak || 0,
    actions: acts.slice(0, 4),
  });
});



app.get('/api/bank', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const b = getBank();
  if (!b) return res.json({ active: false });

  const u = db.getUser(uid) || {};
  const secs = bank.sectors(b).slice(0, 40).map((s) => {
    const su = db.getUser(s.uid) || {};
    return {
      uid: s.uid,
      name: su.username ? '@' + su.username : (su.name || 'гравець'),
      amount: s.amount, stars: s.stars, tickets: s.tickets, percent: s.percent,
      me: String(s.uid) === String(uid),
    };
  });

  res.json({
    active: true,
    status: b.status,
    pot: bank.totalPot(b),
    stars: b.stars || 0,
    tickets: b.tickets || 0,
    drawAt: b.drawAt,
    msLeft: bank.timeLeft(b),
    players: b.order.length,
    seedHash: b.seedHash,
    ticketWeight: bank.TICKET_WEIGHT,
    minBet: bank.MIN_BET,
    sectors: secs,
    milestones: bank.milestones(b),
    consolation: bank.consolationFor(b, uid),
    consolePer: bank.CONSOLE_PER,
    feed: (b.feed || []).slice(-8).reverse().map(function (f) {
      const fu = db.getUser(f.uid) || {};
      return {
        name: fu.username ? '@' + fu.username : (fu.name || 'гравець'),
        stars: f.s, tickets: f.t, weight: f.weight, at: f.at,
        me: String(f.uid) === String(uid),
      };
    }),
    mine: {
      weight: b.bets[uid] || 0,
      stars: (b.betStars || {})[uid] || 0,
      tickets: (b.betTickets || {})[uid] || 0,
      chance: bank.chance(b, uid),
    },
    balance: Math.round((u.starBalance || 0) * 100) / 100,
    myTickets: ticketsOf(u),
    winner: b.winner ? (function () {
      const w = db.getUser(b.winner) || {};
      return { uid: b.winner, name: w.username ? '@' + w.username : (w.name || 'гравець'), me: String(b.winner) === String(uid) };
    })() : null,
  });
});

app.post('/api/bank-bet', async (req, res) => {
  const { initData, stars, tickets } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });

  const b = getBank();
  if (!b || b.status !== 'open') return res.status(400).json({ error: 'no_bank' });
  if (Date.now() >= b.drawAt) return res.status(400).json({ error: 'too_late' });

  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const u = db.getUser(uid);
    if (!u) return res.status(400).json({ error: 'user not found' });

    const s = Math.floor(Number(stars) || 0);
    const t = Math.floor(Number(tickets) || 0);
    const haveStars = Math.round((u.starBalance || 0) * 100) / 100;
    const haveTickets = ticketsOf(u);

    if (s > haveStars) return res.status(402).json({ error: 'not_enough_stars', have: haveStars });
    if (t > haveTickets) return res.status(402).json({ error: 'not_enough_tickets', have: haveTickets });

    const r = bank.addBet(b, uid, s, t);
    if (!r.ok) return res.status(400).json({ error: r.error, min: r.min });

    if (s) db.upsertUser(uid, { starBalance: Math.round((haveStars - s) * 100) / 100 });
    if (t) addTickets(uid, -t, 'ставка в банк');
    if (s) leagueXp(uid, 'bank_star', s);
    if (t) leagueXp(uid, 'bank_ticket', t);
    try {
      const ub = db.getUser(uid) || {};
      const pb = pass.ensure(ub, Date.now());
      if (pb.bankXpFor !== b.id) {          // один раз на банк, не на кожну ставку
        pass.addFreeXp(pb, pass.XP_BANK_BET, 'bank', Date.now());
        pb.bankXpFor = b.id;
        db.upsertUser(uid, { pass: pb });
      }
    } catch (e) {}
    saveBank(b);

    res.json({
      ok: true, stars: s, tickets: t,
      pot: bank.totalPot(b), chance: bank.chance(b, uid),
      mine: r.mine, mineStars: r.mineStars, mineTickets: r.mineTickets,
    });
  } finally {
    balanceLocks.delete(uid);
  }
});

app.get('/api/pass', (req, res) => {
  const uid = verifyInitData(req.query.initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  const u = db.getUser(uid);
  if (!u) return res.status(400).json({ error: 'no_user' });
  const p = pass.ensure(u, Date.now());
  db.upsertUser(uid, { pass: p });
  res.json({ ok: true, state: pass.view(p, Date.now()), balance: u.starBalance || 0 });
});

app.post('/api/pass/claim', async (req, res) => {
  const { initData, level } = req.body || {};
  const uid = verifyInitData(initData);
  if (!uid) return res.status(401).json({ error: 'invalid initData' });
  if (balanceLocks.has(uid)) return res.status(429).json({ error: 'busy' });
  balanceLocks.add(uid);
  try {
    const { track } = req.body || {};
    const list = level === 'all'
      ? pass.claimable(pass.ensure(db.getUser(uid) || {}, Date.now()))
      : [{ level: parseInt(level, 10), track: track === 'prem' ? 'prem' : 'free' }];
    const results = [];
    for (const c of list) {
      const r = await grantPassReward(uid, c.level, c.track);
      if (r.ok) results.push(r);
    }
    const u2 = db.getUser(uid) || {};
    res.json({
      ok: true, results,
      state: pass.view(pass.ensure(u2, Date.now()), Date.now()),
      balance: u2.starBalance || 0,
    });
  } finally {
    balanceLocks.delete(uid);
  }
});

// Своя ставка. Людина вводить число текстом — це єдиний спосіб дати
// довільну суму, не засіваючи меню двадцятьма кнопками.
bot.action(/^dice_own_(\w+)$/, async (ctx) => {
  const uid = String(ctx.from.id);
  await ctx.answerCbQuery();
  const g = DICE_GAMES[ctx.match[1]];
  if (!g) return;
  diceState.set(uid, { game: ctx.match[1] });
  awaitingDiceBet.set(uid, ctx.match[1]);
  const u = db.getUser(uid) || {};
  const bal = Math.round((u.starBalance || 0) * 100) / 100;
  await ctx.reply(
    `${g.emoji} <b>${g.label}</b> · ${g.k}x\n\n` +
    `Напиши суму ставки числом.\n` +
    `Мінімум 1⭐, стелі немає. Твій баланс: <b>${bal}⭐</b>\n\n` +
    `Наприклад: <code>7</code> → виграш ${Math.round(7 * g.k * 100) / 100}⭐, +${7 * pass.XP_PER_STAR_BET} XP`,
    { parse_mode: 'HTML' }
  );
});

bot.command('send_reminders', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply('Запускаю розсилку нагадувань...');
  await sendSpinReminders();
  await ctx.reply('Готово.');
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log('✅ WebApp сервер запущено на порту ' + (process.env.PORT || 3000));
});

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
// Меню команд і кнопка застосунку. Раніше в особистих не було ні підказок
// команд, ні кнопки «Відкрити колеса» біля поля вводу.
async function setupBotUi() {
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 Головне меню' },
    { command: 'topup', description: '⭐ Поповнити баланс' },
    { command: 'bank', description: '🏦 Спільний банк' },
    { command: 'pass', description: '🎟 Сезонний пас' },
  ], { scope: { type: 'all_private_chats' } }).catch(e => console.error('setMyCommands:', e.message));
  if (ADMIN_CHAT_ID) {
    await bot.telegram.setMyCommands([
      { command: 'help_admin', description: 'Адмін-команди' },
      { command: 'apps', description: 'Черга заявок' },
      { command: 'requests', description: 'Список заявок' },
      { command: 'event_status', description: 'Що зараз запущено' },
      { command: 'maint', description: 'Техроботи' },
      { command: 'spin_notify', description: 'Сповіщення про спіни' },
      { command: 'chat_status', description: 'Стан чату' },
      { command: 'dbstats', description: 'Зріз бази' },
      { command: 'broadcast', description: 'Розсилка (відповіддю на повідомлення)' },
      { command: 'test', description: 'Тестовий режим' },
    ], { scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) } }).catch(e => console.error('setMyCommands(admin):', e.message));
  }
  if (WEBAPP_URL) {
    await bot.telegram.setChatMenuButton({
      menuButton: { type: 'web_app', text: '🎰 Колеса', web_app: { url: WEBAPP_URL } },
    }).catch(e => console.error('setChatMenuButton:', e.message));
  }
}

if (CFG.ADVANCED_UNLOCK_PASSWORD_IS_DEFAULT) {
  console.warn('⚠️ ADVANCED_UNLOCK_PASSWORD не задано — використовується стандартний пароль. Задай свій у змінних оточення.');
}
if (!WEBAPP_URL) console.warn('ℹ️ WEBAPP_URL не задано — кнопок відкриття застосунку в боті не буде.');

let launching = false;
async function startBot(attempt) {
  if (launching) return;
  launching = true;
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log('✅ Бот запущено як @' + BOT_USERNAME);

    // Відновлення таймерів не повинно блокувати старт бота.
    try { scheduleAllGiveawayChecks(); } catch (e) { console.error('⚠️ scheduleAllGiveawayChecks:', e.message); }
    try { scheduleEventCheck(); } catch (e) { console.error('⚠️ scheduleEventCheck:', e.message); }
    setupBotUi().catch(() => {});

    // У Telegraf 4.16+ launch() завершується лише ПІСЛЯ зупинки бота, тому
    // не чекаємо його: про старт повідомляє колбек, а про падіння — catch.
    bot.launch({}, () => console.log('✅ Long polling активний'))
      .then(() => { launching = false; })
      .catch((e) => {
        launching = false;
        // 409 — зазвичай старий інстанс ще не зупинився після деплою.
        console.error('❌ Polling зупинився:', e.message, '— перезапуск через 30с');
        setTimeout(() => startBot((attempt || 0) + 1), 30000);
      });
  } catch (err) {
    launching = false;
    // НЕ вбиваємо процес: express уже слухає порт, і застосунок (колесо)
    // має лишатись доступним, навіть якщо Telegram тимчасово не відповідає.
    const wait = Math.min(120000, 30000 * ((attempt || 0) + 1));
    console.error('❌ Не вдалось запустити бота:', err.message, `— повтор через ${Math.round(wait / 1000)}с`);
    setTimeout(() => startBot((attempt || 0) + 1), wait);
  }
}
startBot(0);

function shutdown(sig) {
  console.log(`Отримано ${sig} — коректно зупиняюсь.`);
  try { bot.stop(sig); } catch (e) {}
  try { server.close(); } catch (e) {}
  try { db.flush(); } catch (e) { console.error('db flush:', e.message); }
  setTimeout(() => process.exit(0), 300).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
