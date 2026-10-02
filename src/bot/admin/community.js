// ==========================================================================
// РОЗСИЛКИ, ЧАТ І ДЖЕКПОТ.
//   /broadcast — відповіддю на повідомлення: усім гравцям в особисті
//   /chat_say, /chat_post [pin], /post_all, /chats — публікації в групи
//   /chat_status, /chat_debug, /chat_drop, /chat_quiz, /chat_word, /chat_top,
//   /chat_contest HH:MM [N], /chat_contest_status, /chat_contest_end,
//   /chat_pause, /chat_resume
//   Посилання на повідомлення з чату → «ДЖЕКПОТ» з реальним призом.
// ==========================================================================
const config = require('../../config');
const store = require('../../store');
const users = require('../../core/users');
const progress = require('../../core/progress');
const notify = require('../../core/notify');
const applications = require('../../features/applications');
const tggifts = require('../../features/tggifts');
const usergifts = require('../../features/usergifts');
const E = require('../../economy');
const time = require('../../lib/time');
const ui = require('../ui');
const { isAdminCtx, broadcast, audience, argsOf, yes } = require('./shared');
const { sleep, esc } = require('../../lib/util');
const { withEmoji } = require('../../emoji');

const pendingBroadcast = new Map();   // адмін -> { from, id, at }
const jpPending = new Map();          // msgId -> uid, коли автора вказано вручну
const jpDone = new Set();             // msgId, за які приз уже видано (подвійне натискання — не вдруге)
const JP_GIFT_TEXT = '👑 Джекпот за активність у чаті StarForge! Дякуємо, що ти з нами 🔥';

const JP_PRIZES = {
  heart:     { label: '💝 Сердечко', kind: 'tier', id: 'heart' },
  bear:      { label: '🧸 Мішку', kind: 'tier', id: 'bear' },
  rose:      { label: '🌹 Троянду', kind: 'tier', id: 'rose' },
  gift:      { label: '🎁 Подарунок', kind: 'tier', id: 'gift' },
  cake:      { label: '🎂 Торт', kind: 'tier', id: 'cake' },
  bouquet:   { label: '💐 Букет', kind: 'tier', id: 'bouquet' },
  champagne: { label: '🍾 Шампанське', kind: 'tier', id: 'champagne' },
  ring:      { label: '💍 Кільце', kind: 'tier', id: 'ring' },
  diamond:   { label: '💎 Діамант', kind: 'tier', id: 'diamond' },
  s5:   { label: '5 ⭐', kind: 'stars', n: 5 },
  t20:  { label: '20 🎫', kind: 'tickets', n: 20 },
  x100: { label: '✨ +100 XP', kind: 'xp', n: 100 },
  // Реальні зірки на канал переможця (платна реакція від акаунта, анонімно).
  rs1: { label: '1⭐ на канал', kind: 'realstars', n: 1 }, rs2: { label: '2⭐ на канал', kind: 'realstars', n: 2 },
  rs3: { label: '3⭐ на канал', kind: 'realstars', n: 3 }, rs4: { label: '4⭐ на канал', kind: 'realstars', n: 4 },
};

const chat = () => notify.tg.chat;
function sourceOf(ctx) {
  const r = ctx.message && ctx.message.reply_to_message;
  return r ? { from: ctx.chat.id, id: r.message_id } : null;
}
function jpParseLink(text) {
  const m = String(text || '').match(/t\.me\/(?:c\/\d+|[A-Za-z0-9_]+)\/(?:\d+\/)?(\d+)/);
  return m ? Number(m[1]) : null;
}

function register(bot, hooks) {
  // ─── Розсилка всім в особисті ─────────────────────────────────────────
  bot.command('broadcast', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const targets = audience();
    const src = sourceOf(ctx);
    if (src) {
      pendingBroadcast.set(String(ctx.from.id), { ...src, at: Date.now() });
      await notify.tg.telegram.copyMessage(ctx.chat.id, src.from, src.id).catch(() => {});
      return ctx.reply(`👆 Так побачать гравці.\nОтримають: ${targets.length}\n\nЗапустити: /broadcast так\nСкасувати — просто нічого не роби.`);
    }
    const p = pendingBroadcast.get(String(ctx.from.id));
    if (!yes(ctx) || !p || Date.now() - p.at > 30 * 60000) {
      return ctx.reply('Як розіслати всім в особисті:\n1. Надішли боту повідомлення (текст, фото, відео, з кнопками)\n2. Відповідай на нього командою /broadcast\n3. Підтверди: /broadcast так');
    }
    pendingBroadcast.delete(String(ctx.from.id));
    await broadcast(ctx, targets, (uid) => notify.tg.telegram.copyMessage(uid, p.from, p.id), 'Розсилка');
  });

  // ─── Публікації в групи ───────────────────────────────────────────────
  // /say — пост у чат від імені бота:
  //   /say текст            — текст (HTML і преміум-емодзі {:starIcon})
  //   /say pin текст        — і закріпити
  //   відповіддю /say [pin] — переслати від бота будь-яке повідомлення (фото, відео, кнопки)
  // Рядки в кінці виду [Текст кнопки](https://посилання) стають кнопками під постом.
  bot.command('say', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    if (!chat() || !chat().chatId) return ctx.reply('❌ Чат не підключено — /chat_status');
    let body = ctx.message.text.replace(/^\/say(@\w+)?\s*/, '');
    const pin = /^pin(\s|$)/i.test(body);
    if (pin) body = body.replace(/^pin\s*/i, '');
    const src = sourceOf(ctx);
    const tg = notify.tg.telegram;
    const pinIt = async (m) => {
      if (!pin || !m) return '';
      try { await tg.pinChatMessage(chat().chatId, m.message_id, { disable_notification: false }); return ' і закріплено 📌'; }
      catch (e) { return '\n⚠️ Не закріпив: ' + e.message; }
    };
    if (src && !body) {
      try { const m = await tg.copyMessage(chat().chatId, src.from, src.id); return ctx.reply('✅ Опубліковано в чаті від імені бота' + (await pinIt(m))); }
      catch (e) { return ctx.reply('❌ ' + e.message); }
    }
    if (!body) {
      return ctx.reply('📣 Пост у чат від імені бота:\n\n' +
        '/say Привіт, чат! — текст\n/say pin Важливо! — і закріпити\n' +
        'Відповідай /say на будь-яке повідомлення (фото, відео, з кнопками) — бот перешле його від себе.\n\n' +
        'Можна <b>жирний</b>, <i>курсив</i>, посилання й преміум-емодзі {:starIcon} {:giftBox} {:almost}.\n' +
        'Кнопки — окремими рядками в кінці:\n[🎰 Грати](https://t.me/' + (notify.tg.botUsername || 'bot') + ')');
    }
    // Кнопки з останніх рядків «[Текст](https://…)».
    const lines = body.split('\n');
    const rows = [];
    while (lines.length) {
      const m = lines[lines.length - 1].trim().match(/^\[(.+?)\]\((https?:\/\/\S+)\)$/);
      if (!m) break;
      rows.unshift([{ text: m[1], url: m[2] }]);
      lines.pop();
    }
    const text = withEmoji(lines.join('\n').trim());
    if (!text) return ctx.reply('❌ Потрібен текст поста.');
    try {
      const m = await tg.sendMessage(chat().chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
      await ctx.reply('✅ Опубліковано в чаті від імені бота' + (await pinIt(m)));
    } catch (e) {
      await ctx.reply('❌ ' + e.message + (/parse|entit/i.test(e.message) ? '\nПеревір HTML: кожен <b> має закриватись </b>, а знаки < > пиши як &lt; &gt;.' : ''));
    }
  });

  bot.command('chat_say', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const text = ctx.message.text.replace(/^\/chat_say(@\w+)?\s*/, '');
    if (!text) return ctx.reply('Формат: /chat_say текст\n\nФото, відео чи кнопки — відповіддю на повідомлення командою /chat_post.');
    if (!chat() || !chat().chatId) return ctx.reply('❌ Чат не підключено — /chat_status');
    try { await notify.tg.telegram.sendMessage(chat().chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }); await ctx.reply('✅ Надіслано в чат'); }
    catch (e) { await ctx.reply('❌ ' + e.message); }
  });
  bot.command('chat_post', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const src = sourceOf(ctx);
    if (!src) return ctx.reply('Надішли боту повідомлення й відповідай на нього:\n/chat_post — у чат\n/chat_post pin — у чат і закріпити');
    if (!chat() || !chat().chatId) return ctx.reply('❌ Чат не підключено — /chat_status');
    const pin = /\bpin\b/i.test(ctx.message.text);
    try {
      const m = await notify.tg.telegram.copyMessage(chat().chatId, src.from, src.id);
      if (pin) await notify.tg.telegram.pinChatMessage(chat().chatId, m.message_id, { disable_notification: false }).catch(e => ctx.reply('⚠️ Не закріпив: ' + e.message));
      await ctx.reply('✅ Опубліковано в чаті' + (pin ? ' і закріплено 📌' : ''));
    } catch (e) { await ctx.reply('❌ ' + e.message); }
  });
  bot.command('chats', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const list = chat() ? chat().listChats() : [];
    if (!list.length) return ctx.reply('Бот поки не бачив жодної групи. Додай його в групу й напиши там щось.');
    await ctx.reply('💬 Групи з ботом (' + list.length + '):\n\n' +
      list.map((c, i) => `${i + 1}. ${c.title || '—'}${c.username ? ' @' + c.username : ''} · ${c.id}`).join('\n') +
      '\n\nРозіслати в усі: відповідай на повідомлення командою /post_all');
  });
  bot.command('post_all', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const src = sourceOf(ctx);
    if (!src) return ctx.reply('Відповідай командою /post_all на повідомлення, яке треба розіслати по всіх групах.');
    const list = chat() ? chat().listChats() : [];
    let ok = 0; const bad = [];
    for (const c of list) {
      try { await notify.tg.telegram.copyMessage(c.id, src.from, src.id); ok++; }
      catch (e) { bad.push((c.title || c.id) + ': ' + String(e.message).slice(0, 60)); }
      await sleep(120);
    }
    await ctx.reply(`✅ Розіслано по групах: ${ok} з ${list.length}` + (bad.length ? '\n\n⚠️ Не вдалось:\n' + bad.join('\n') : ''));
  });

  // ─── Керування чатом ──────────────────────────────────────────────────
  const needChat = (ctx) => { if (chat()) return true; ctx.reply('❌ Модуль чату не запущено.').catch(() => {}); return false; };
  bot.command('chat_status', async (ctx) => {
    if (!isAdminCtx(ctx) || !needChat(ctx)) return;
    const s = chat().status();
    const f = (t) => t ? time.fmtKyiv(t) : '—';
    await ctx.reply(`💬 Чат ${s.chatRef}` + (s.chatId ? ` (${s.chatId})` : ' — ❌ НЕ ПІДКЛЮЧЕНО: додай бота адміном або напиши в чаті /chat_here') + '\n' +
      'Стан: ' + (s.paused ? '⏸ на паузі' : '▶️ працює') + '\n\n' +
      `🎁 Наступний дроп: ${f(s.nextDropAt)}\n🧠 Наступна вікторина: ${f(s.nextQuizAt)}\n📣 Оголошень сьогодні: ${s.annCount || 0}\n\n` +
      'Зараз: /chat_drop · /chat_boxes · /chat_quiz · /chat_word · /chat_top\nПауза: /chat_pause · /chat_resume\nДіагностика: /chat_debug');
  });
  bot.command('chat_debug', async (ctx) => {
    if (!isAdminCtx(ctx) || !needChat(ctx)) return;
    const c = chat();
    const lines = ['🩺 Діагностика чату\n'];
    if (!c.chatId) { lines.push('❌ Чат не підключено. Напиши в самому чаті /chat_here зі свого акаунта.'); return ctx.reply(lines.join('\n')); }
    lines.push('Чат: ' + c.chatId);
    try {
      const me = await notify.tg.telegram.getMe();
      const mem = await notify.tg.telegram.getChatMember(c.chatId, me.id);
      const isAdm = ['administrator', 'creator'].includes(mem.status);
      lines.push(isAdm ? '✅ Бот — адміністратор чату' : `❌ Бот НЕ адміністратор (${mem.status}) — Telegram не пересилає йому звичайні повідомлення.`);
    } catch (e) { lines.push('⚠️ Не вдалось перевірити права: ' + e.message); }
    const d = c.debugStats();
    lines.push('\n📊 Сьогодні бот отримав з чату:');
    lines.push(`усього: ${d.recv || 0} (текст ${d.text || 0}, медіа ${d.media || 0})`);
    lines.push(`від тих, хто не запускав бота: ${d.guests || 0}`);
    lines.push(`зараховано як активність: ${d.counted || 0}`);
    if (!d.recv) lines.push('\n⚠️ Сьогодні бот не отримав ЖОДНОГО повідомлення — майже напевно він не адмін або не в тому чаті.');
    await ctx.reply(lines.join('\n'));
  });
  bot.command('chat_drop', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; await ctx.reply((await chat().postDrop(true)) ? '🎁 Дроп у чаті' : '❌ Не вдалось — чат не підключено або на паузі'); });
  bot.command('chat_quiz', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; await ctx.reply((await chat().postQuiz()) ? '🧠 Вікторина в чаті' : '❌ Не вдалось'); });
  bot.command('chat_boxes', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; await ctx.reply((await chat().postBoxes()) ? '🎁 Скриньки в чаті' : '❌ Не вдалось — чат не підключено або на паузі'); });
  bot.command('chat_word', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; await ctx.reply((await chat().postRace()) ? '⚡ «Хто швидший» у чаті' : '❌ Не вдалось'); });
  bot.command('chat_top', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; await chat().postLeagueTop(); await ctx.reply('🏆 Таблицю надіслано в чат'); });
  bot.command('chat_pause', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; chat().pause(); await ctx.reply('⏸ Чат-активності на паузі'); });
  bot.command('chat_resume', async (ctx) => { if (!isAdminCtx(ctx) || !needChat(ctx)) return; chat().resume(); await ctx.reply('▶️ Чат-активності увімкнено'); });
  bot.action('aw_post', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    if (!chat() || !chat().chatId) return ctx.reply('❌ Чат не підключено');
    try { await notify.tg.telegram.sendMessage(chat().chatId, chat().autowdCard(), { parse_mode: 'HTML' }); await ctx.reply('📣 Оголошено в чаті'); }
    catch (e) { await ctx.reply('❌ ' + e.message); }
  });

  bot.command('chat_contest', async (ctx) => {
    if (!isAdminCtx(ctx) || !needChat(ctx)) return;
    const a = argsOf(ctx);
    const hm = (a[0] || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!hm) return ctx.reply('Формат: /chat_contest 21:30 [мішок]\nНаприклад: /chat_contest 21:30 3\n\nПочнеться одразу, закінчиться сьогодні в цей час (Київ). Раніше: /chat_contest_end');
    const endsAt = time.todayAt(+hm[1], +hm[2]);
    if (!endsAt || endsAt <= Date.now()) return ctx.reply('Цей час сьогодні вже минув.');
    const count = Math.max(1, Math.min(10, parseInt(a[1], 10) || 3));
    if (!chat().chatId) return ctx.reply('❌ Чат не підключено.');
    await chat().startContest(endsAt, count, 'bear');
    await ctx.reply(`🏅 Змагання до ${hm[1]}:${hm[2]}, ${count} мішки. Оголошення вже в чаті, підсумки — автоматично.\nЗараз: /chat_contest_status`);
  });
  bot.command('chat_contest_status', async (ctx) => {
    if (!isAdminCtx(ctx) || !needChat(ctx)) return;
    const rows = chat().contestRows();
    if (!rows.length) return ctx.reply('Поки ніхто не набрав балів (або змагання не запущено).');
    await ctx.reply('🏅 Змагання — топ:\n\n' + rows.slice(0, 10).map((r, i) => {
      const u = users.get(r.uid) || {};
      return `${i + 1}. ${u.username ? '@' + u.username : (u.name || r.uid)} — ${r.pts} (💬${r.msg} ⚔️${r.duel}/${r.win} 🎁${r.drop} 🧠${r.quiz})`;
    }).join('\n'));
  });
  bot.command('chat_contest_end', async (ctx) => {
    if (!isAdminCtx(ctx) || !needChat(ctx)) return;
    const r = await chat().finishContest();
    await ctx.reply(r ? `🏁 Завершено. Учасників: ${r.players}\n\n` + (r.winners.join('\n') || 'Ніхто не набрав мінімум.') : 'Активного змагання немає.');
  });

  // ─── Джекпот: адмін вставляє посилання на повідомлення з чату ─────────
  async function jackpotAsk(ctx, text) {
    const msgId = jpParseLink(text);
    if (!msgId) return ctx.reply('Формат: встав посилання на повідомлення з чату, напр. https://t.me/starforge_chat/12345\nМожна додати @username, якщо бот не знає автора.');
    const um = text.match(/@([A-Za-z0-9_]{4,})/);
    let who = chat() ? chat().authorOf(msgId) : null;
    if (um) {
      const u = users.findByUsernameOrId(um[1]);
      if (!u) return ctx.reply('Не знайшов @' + um[1] + ' серед гравців бота.');
      who = { uid: u.id, name: '@' + u.username, plain: '@' + u.username };
      jpPending.set(msgId, u.id);
    }
    if (!who) return ctx.reply('🤔 Не знаю, хто автор — бот пам\'ятає лише свіжі повідомлення.\nНадішли те саме посилання й через пробіл @username автора.');
    if (users.isAdmin(who.uid)) return ctx.reply('Це твоє повідомлення 🙂');
    const inBot = !!(users.get(who.uid) || {}).lang;
    jpDone.delete(msgId);
    return ctx.reply(`👑 Джекпот за активність для ${who.plain}` + (inBot ? '' : '\n⚠️ Ця людина ще не запускала бота — приз чекатиме її') +
      '\n\nЯкий приз?\nПодарунок переможець забере сам у боті — сам обере підпис і від кого.', { parse_mode: 'HTML', ...jpPrizeKb(msgId) });
  }
  function jpPrizeKb(msgId) {
    return ui.kb([
      [ui.cb('💝 Сердечко · 15⭐', `jp_${msgId}_heart`, 'danger'), ui.cb('🧸 Мішка · 15⭐', `jp_${msgId}_bear`, 'danger')],
      [ui.cb('🌹 Троянда · 25⭐', `jp_${msgId}_rose`, 'danger'), ui.cb('🎁 Подарунок · 25⭐', `jp_${msgId}_gift`, 'danger')],
      [ui.cb('🎂 Торт · 50⭐', `jp_${msgId}_cake`, 'danger'), ui.cb('💐 Букет · 50⭐', `jp_${msgId}_bouquet`, 'danger')],
      [ui.cb('🍾 Шампанське · 50⭐', `jp_${msgId}_champagne`, 'danger')],
      [ui.cb('💍 Кільце · 100⭐', `jp_${msgId}_ring`, 'danger'), ui.cb('💎 Діамант · 100⭐', `jp_${msgId}_diamond`, 'danger')],
      [ui.cb('20 🎫', `jp_${msgId}_t20`, 'primary'), ui.cb('5 ⭐', `jp_${msgId}_s5`, 'primary')],
      [ui.cb('✨ +100 XP (безкоштовно)', `jp_${msgId}_x100`, 'success')],
      E.JACKPOT.realStars.map(n => ui.cb('⭐' + n + ' на канал', `jp_${msgId}_rs${n}`, 'primary')),
    ]);
  }
  // Джекпоти, які чекають, поки переможець забере.
  bot.command('jackpots', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [q, mode] = argsOf(ctx);
    const rows = [];
    for (const u of Object.values(users.all())) {
      for (const [id, c] of Object.entries((u && u.jpClaims) || {})) if (c.status === 'pending' && !isExpired(c)) rows.push({ u, id, c });
    }
    if (q && mode === 'cancel') {
      const t = users.findByUsernameOrId(q);
      const mine = t ? rows.filter(r => String(r.u.id) === String(t.id)) : [];
      if (!mine.length) return ctx.reply('У ' + q + ' немає джекпотів, що чекають.').catch(() => {});
      for (const r of mine) setClaim(String(r.u.id), r.id, { status: 'cancelled' });
      return ctx.reply('🚫 Скасовано: ' + mine.map(r => r.c.label).join(', ')).catch(() => {});
    }
    await ctx.reply('👑 <b>Джекпоти, що чекають на переможця</b> (згорають за ' + Math.round(E.JACKPOT.claimTtlMs / 60000) + ' хв)\n\n' +
      (rows.length ? rows.map(r => '• ' + (r.u.username ? '@' + esc(r.u.username) : esc(r.u.name || r.u.id)) + ' — ' + r.c.label + ' · ' + (r.c.kind === 'realstars' ? 'на канал' : whoLabel(r.c.via)) + ' · лишилось ' + leftMin(r.c) + ' хв').join('\n') : 'Немає.') +
      '\n\nНовий джекпот: надішліть посилання на повідомлення з чату або <code>/jackpot посилання [@нік]</code>\nСкасувати: <code>/jackpots @нік cancel</code>\n💝 Сердечко — лише від бота; інші подарунки — від акаунта.', { parse_mode: 'HTML' }).catch(() => {});
  });
  bot.command('jackpot', async (ctx) => { if (!isAdminCtx(ctx)) return; await jackpotAsk(ctx, ctx.message.text); });
  hooks.onAdminText.push(async (ctx, text) => {
    if (!jpParseLink(text) || /^\//.test(text)) return false;
    await jackpotAsk(ctx, text);
    return true;
  });
  // Подарунок: переможець сам обирає підпис і від кого (акаунт власника / бот) — у боті.
  // Решта призів — одразу.
  bot.action(/^jp_(\d+)_(heart|bear|rose|gift|cake|bouquet|champagne|ring|diamond|s5|t20|x100|p100|rs[1-4])$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const msgId = Number(ctx.match[1]);
    const key = ctx.match[2] === 'p100' ? 'x100' : ctx.match[2];
    // Друге натискання (або інша кнопка) по тому самому повідомленню — приз уже видано.
    if (jpDone.has(msgId)) return ctx.reply('Цей джекпот уже видано.').catch(() => {});
    jpDone.add(msgId);
    await jpDeliver(ctx, msgId, JP_PRIZES[key]);
  });

  // ─── Переможець: підпис і від кого ────────────────────────────────────
  const claimOf = (uid, id) => (((users.get(uid) || {}).jpClaims) || {})[id] || null;
  const setClaim = (uid, id, patch) => {
    const all = { ...((users.get(uid) || {}).jpClaims || {}) };
    all[id] = patch === null ? undefined : { ...(all[id] || {}), ...patch };
    if (patch === null) delete all[id];
    users.patch(uid, { jpClaims: all });
  };
  const whoLabel = (via) => via === 'bot' ? '🤖 бот StarForge' : '👤 акаунт StarForge';
  // Від кого можна надіслати цей подарунок.
  const viaAllowed = (giftId, via) => {
    const only = E.JACKPOT.viaOnly[giftId];
    return only ? via === only : via === 'account' || !E.JACKPOT.botLocked;
  };
  const defaultVia = (giftId) => E.JACKPOT.viaOnly[giftId] || 'account';
  const isExpired = (c) => c && c.status === 'pending' && Date.now() - (c.at || 0) > E.JACKPOT.claimTtlMs;
  const leftMin = (c) => Math.max(1, Math.ceil((E.JACKPOT.claimTtlMs - (Date.now() - (c.at || 0))) / 60000));
  function claimCard(c) {
    return withEmoji(ui.card('crown', 'ТВІЙ ДЖЕКПОТ: ' + c.label.toUpperCase(), [
      '{:eye} <b>Підпис:</b> ' + (c.text ? '\n<blockquote>' + esc(c.text) + '</blockquote>' : 'без підпису'),
      '{:lightning} <b>Від кого:</b> ' + whoLabel(c.via),
    ], 'Забери протягом ' + leftMin(c) + ' хв — потім приз згорає'));
  }
  function claimKb(id, c) {
    const lock = (via) => viaAllowed(c.id, via) ? (c.via === via ? '✅ ' : '') : '🔒 ';
    return ui.kb([
      [ui.cb(lock('account') + 'ВІД АКАУНТА', `jpc_${id}_acc`, c.via === 'account' ? 'success' : undefined),
        ui.cb(lock('bot') + 'ВІД БОТА', `jpc_${id}_bot`, c.via === 'bot' ? 'success' : undefined)],
      [ui.cb(c.text ? 'ЗМІНИТИ ПІДПИС' : 'НАПИСАТИ ПІДПИС', `jpc_${id}_text`, 'primary', 'lightning'), c.text ? ui.cb('БЕЗ ПІДПИСУ', `jpc_${id}_clear`) : null],
      [ui.cb('ЗАБРАТИ ' + c.label.toUpperCase(), `jpc_${id}_send`, 'success', 'giftBox')],
    ]);
  }
  const jpcAwait = new Map();   // uid -> id джекпоту, чекаємо підпис
  const jpcTapAt = new Map();   // uid -> час останнього натискання (антиспам)

  // Приз згорів: позначити, сказати переможцю й адміну.
  function expireClaim(uid, id, c) {
    setClaim(uid, id, { status: 'expired', expiredAt: Date.now() });
    notify.dm(uid, withEmoji('⌛ <b>Час вийшов</b> — джекпот ' + c.label + ' згорів, бо його не забрали за годину.\nНаступного разу забирай одразу {:lightning}'));
    notify.admin(`⌛ Джекпот згорів: ${c.name || uid} — ${c.label} (не забрав за годину)`);
  }
  // Раз на хвилину — прибрати прострочені.
  if (!config.NO_SCHEDULERS) {
    const t = setInterval(() => {
      for (const u of Object.values(users.all())) {
        for (const [id, c] of Object.entries((u && u.jpClaims) || {})) if (isExpired(c)) expireClaim(String(u.id), id, c);
      }
    }, 60000);
    if (t.unref) t.unref();
  }

  bot.action(/^jpc_(\d+)_(text|clear|acc|bot|send)$/, async (ctx) => {
    const uid = String(ctx.from.id), id = ctx.match[1], act = ctx.match[2];
    // Антиспам: часті натискання ігноруємо (без запитів до Telegram, крім відповіді на кнопку).
    const last = jpcTapAt.get(uid) || 0;
    if (Date.now() - last < E.JACKPOT.tapGapMs) return ctx.answerCbQuery('⏳ Не так швидко').catch(() => {});
    jpcTapAt.set(uid, Date.now());
    const c = claimOf(uid, id);
    if (isExpired(c)) {
      expireClaim(uid, id, c);
      await ctx.answerCbQuery('⌛ Час вийшов — приз згорів', { show_alert: true }).catch(() => {});
      return ctx.editMessageText(withEmoji('⌛ <b>Час вийшов</b> — джекпот ' + c.label + ' згорів.'), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (!c || c.status !== 'pending') return ctx.answerCbQuery(c && c.status === 'sent' ? 'Подарунок уже надіслано 🎁' : c && c.status === 'expired' ? '⌛ Приз згорів' : c ? '⏳ Уже надсилаю…' : 'Цей приз не твій 🙂').catch(() => {});
    if ((act === 'bot' || act === 'acc') && !viaAllowed(c.id, act === 'bot' ? 'bot' : 'account')) {
      return ctx.answerCbQuery('🔒 ' + (act === 'bot' ? 'Від бота' : 'Від акаунта') + ' — поки закрито для цього подарунка', { show_alert: true }).catch(() => {});
    }
    if (act === 'send' && !viaAllowed(c.id, c.via)) c.via = defaultVia(c.id);
    // Подвійне «Забрати» — стан синхронно, до першого await.
    if (act === 'send') setClaim(uid, id, { status: 'sending' });
    await ctx.answerCbQuery().catch(() => {});
    if (act === 'text') { jpcAwait.set(uid, id); return ctx.reply(withEmoji('{:lightning} Напиши підпис до подарунка одним повідомленням — до ' + usergifts.TEXT_MAX + ' символів. Емодзі можна 😉'), { parse_mode: 'HTML' }).catch(() => {}); }
    if (act === 'clear') setClaim(uid, id, { text: '', entities: [] });
    if (act === 'acc') setClaim(uid, id, { via: 'account' });
    if (act === 'bot') setClaim(uid, id, { via: 'bot' });
    if (act !== 'send') { const n = claimOf(uid, id); return ctx.editMessageText(claimCard(n), { parse_mode: 'HTML', ...claimKb(id, n) }).catch(() => ctx.reply(claimCard(n), { parse_mode: 'HTML', ...claimKb(id, n) }).catch(() => {})); }
    setClaim(uid, id, { via: c.via });
    await ctx.editMessageText('⏳ Надсилаю ' + c.label + '…').catch(() => {});
    const u = users.get(uid) || {};
    const g = c.via === 'bot'
      ? await tggifts.send(uid, c.id, c.text, c.entities)
      : usergifts.enabled() ? await usergifts.send(u.username ? '@' + u.username : uid, c.id, c.text, c.entities) : { ok: false, error: 'account_off' };
    if (!g.ok) {
      setClaim(uid, id, { status: 'pending', lastError: g.error });
      notify.admin(`⚠️ Джекпот: не вдалось надіслати ${c.label} для ${u.username ? '@' + u.username : uid} (${c.via === 'bot' ? 'бот' : 'акаунт'})\n<code>${esc(g.error)}</code>` + (g.error === 'account_off' ? '\nПідключіть акаунт: /tg_login' : ''));
      return ctx.reply(withEmoji('{:warn} Не вийшло надіслати зараз — спробуй ще раз за кілька хвилин, приз за тобою.'), { parse_mode: 'HTML', ...claimKb(id, claimOf(uid, id)) }).catch(() => {});
    }
    setClaim(uid, id, { status: 'sent', sentAt: Date.now() });
    const a = applications.create(uid, c.id, 'chat_jackpot', { autoSent: true, via: c.via }, { silent: true });
    a.status = 'approved'; a.decidedAt = Date.now(); store.save();
    await ctx.reply(withEmoji(ui.card('check', c.label.toUpperCase() + ' НАДІСЛАНО!', [
      '{:giftBox} Глянь у свій профіль Telegram → «Подарунки»',
    ], 'Дякуємо, що ти з нами — спілкуйся далі!')), { parse_mode: 'HTML' }).catch(() => {});
    const shown = chat() ? await chat().jackpot(Number(id), { name: c.name || (u.username ? '@' + esc(u.username) : 'гравець') }, c.label,
      { kind: c.id, claimed: true, via: c.via, text: c.text ? esc(c.text) : '' }) : false;
    notify.admin((shown ? '' : '⚠️ У чат оголосити не вдалось — /chat_status\n') + `🎁 Джекпот забрано: ${u.username ? '@' + u.username : uid} — ${c.label} від ${c.via === 'bot' ? 'бота' : 'акаунта'}` + (c.text ? `\nПідпис: ${esc(c.text)}` : '\nБез підпису'));
  });

  // ─── Джекпот реальними зірками: посилання на пост каналу переможця ────
  const { DISCLAIMER, HINT } = require('../betawd');
  function rsCard(c) {
    return withEmoji(ui.card('crown', 'ТВІЙ ДЖЕКПОТ: ' + c.n + '⭐ НА КАНАЛ', [
      '{:megaphone} <b>Пост:</b> ' + (c.link ? esc(c.link) : 'ще не вказано'),
      '{:lightning} Як: платна реакція ⭐, анонімно',
      '',
      DISCLAIMER,
    ], 'Забери протягом ' + leftMin(c) + ' хв — потім приз згорає'));
  }
  function rsKb(id, c) {
    return ui.kb([
      [ui.cb(c.link ? 'ЗМІНИТИ ПОСИЛАННЯ' : 'НАДІСЛАТИ ПОСИЛАННЯ НА ПОСТ', `jpr_${id}_link`, 'primary', 'megaphone')],
      c.link ? [ui.cb('ЗАБРАТИ ' + c.n + '⭐', `jpr_${id}_send`, 'success', 'starIcon')] : null,
    ]);
  }
  const jprAwait = new Map();   // uid -> id, чекаємо посилання
  bot.action(/^jpr_(\d+)_(link|send)$/, async (ctx) => {
    const uid = String(ctx.from.id), id = ctx.match[1], act = ctx.match[2];
    const last = jpcTapAt.get(uid) || 0;
    if (Date.now() - last < E.JACKPOT.tapGapMs) return ctx.answerCbQuery('⏳ Не так швидко').catch(() => {});
    jpcTapAt.set(uid, Date.now());
    const c = claimOf(uid, id);
    if (isExpired(c)) {
      expireClaim(uid, id, c);
      await ctx.answerCbQuery('⌛ Час вийшов — приз згорів', { show_alert: true }).catch(() => {});
      return ctx.editMessageText(withEmoji('⌛ <b>Час вийшов</b> — джекпот ' + c.label + ' згорів.'), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (!c || c.status !== 'pending') return ctx.answerCbQuery(c && c.status === 'sent' ? 'Зірки вже надіслано ⭐' : c && c.status === 'expired' ? '⌛ Приз згорів' : c ? '⏳ Уже надсилаю…' : 'Цей приз не твій 🙂').catch(() => {});
    if (act === 'link') {
      await ctx.answerCbQuery().catch(() => {});
      jprAwait.set(uid, id);
      return ctx.reply(withEmoji('{:megaphone} Надішли посилання на пост у своєму <b>публічному</b> каналі.\nПриклад: <code>https://t.me/mychannel/15</code>'), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (!c.link) return ctx.answerCbQuery('Спершу надішли посилання на пост', { show_alert: true }).catch(() => {});
    // Подвійне «Забрати» — стан синхронно, до першого await.
    setClaim(uid, id, { status: 'sending' });
    await ctx.answerCbQuery('⏳ Надсилаю…').catch(() => {});
    await ctx.editMessageText('⏳ Надсилаю ' + c.n + '⭐ на канал…').catch(() => {});
    const r = await usergifts.sendPaidReaction(c.link, c.n);
    const u = users.get(uid) || {};
    if (!r.ok) {
      setClaim(uid, id, { status: 'pending', lastError: r.error });
      notify.admin(`⚠️ Джекпот ${c.n}⭐ на канал не вдався: ${u.username ? '@' + u.username : uid} → ${esc(c.link)}\n<code>${esc(r.error)}</code>`);
      const n = claimOf(uid, id);
      return ctx.reply(withEmoji('{:warn} <b>Не вдалося надіслати.</b> ' + (HINT[r.hint] || HINT.other) + '\nПриз за тобою, поки не згорів.'), { parse_mode: 'HTML', disable_web_page_preview: true, ...rsKb(id, n) }).catch(() => {});
    }
    setClaim(uid, id, { status: 'sent', sentAt: Date.now() });
    store.appendLedger({ ts: Date.now(), uid, s: 0, t: 0, r: 'jackpot_realstars', m: { n: c.n, link: c.link } });
    await ctx.reply(withEmoji(ui.card('check', c.n + '⭐ НАДІСЛАНО НА КАНАЛ!', ['{:megaphone} Під постом: ' + esc(c.link), '{:lightning} Платна реакція ⭐, анонімно.'], 'Вивід із каналу в Telegram — від 1000⭐')), { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
    const shown = chat() ? await chat().jackpot(Number(id), { name: c.name || (u.username ? '@' + esc(u.username) : 'гравець') }, c.n + ' справжніх ⭐', { kind: 'stars', realStars: true }) : false;
    notify.admin((shown ? '' : '⚠️ У чат оголосити не вдалось\n') + `⭐ Джекпот забрано: ${u.username ? '@' + u.username : uid} — ${c.n}⭐ на канал ${esc(c.link)}` + (r.dry ? ' (сухий прогін)' : ''));
  });
  hooks.onText.push(async (ctx, uid, text) => {
    if (!jprAwait.has(uid)) return false;
    const id = jprAwait.get(uid); jprAwait.delete(uid);
    const c = claimOf(uid, id);
    if (!c || c.status !== 'pending' || isExpired(c)) return false;
    const p = usergifts.parsePostLink(text);
    if (!p) { jprAwait.set(uid, id); await ctx.reply('❌ Це не посилання на пост публічного каналу. Формат: https://t.me/канал/123').catch(() => {}); return true; }
    setClaim(uid, id, { link: p.link });
    const n = claimOf(uid, id);
    await ctx.reply(rsCard(n), { parse_mode: 'HTML', disable_web_page_preview: true, ...rsKb(id, n) }).catch(() => {});
    return true;
  });
  hooks.onCommand.push((uid) => jprAwait.delete(uid));

  hooks.onText.push(async (ctx, uid, text) => {
    if (!jpcAwait.has(uid)) return false;
    const id = jpcAwait.get(uid); jpcAwait.delete(uid);
    const c = claimOf(uid, id);
    if (!c || c.status !== 'pending') return false;
    if (!text.trim()) return true;
    if (text.length > usergifts.TEXT_MAX) { jpcAwait.set(uid, id); await ctx.reply(`❌ Задовго: ${text.length}/${usergifts.TEXT_MAX}. Коротше, будь ласка.`).catch(() => {}); return true; }
    setClaim(uid, id, { text, entities: tggifts.cleanEntities(ctx.message.entities) });
    const n = claimOf(uid, id);
    await ctx.reply(claimCard(n), { parse_mode: 'HTML', ...claimKb(id, n) }).catch(() => {});
    return true;
  });
  hooks.onCommand.push((uid) => jpcAwait.delete(uid));

  function jpWho(msgId) {
    const known = chat() ? chat().authorOf(msgId) : null;
    const uid = jpPending.get(msgId) || (known && known.uid);
    const u = uid ? users.get(uid) || {} : {};
    return { uid, known, name: u.username ? '@' + u.username : (known ? known.name : 'гравець') };
  }

  // Видати приз і оголосити в чаті. Подарунок — переможець забирає сам у боті.
  async function jpDeliver(ctx, msgId, prize) {
    const { uid, known, name } = jpWho(msgId);
    if (!uid) { jpDone.delete(msgId); return ctx.reply('Автора вже не знаю — надішли посилання ще раз із @username.'); }
    if (!users.get(uid) && known) users.ensure({ id: uid, first_name: known.plain });
    // Приз видається СПРАВЖНІЙ — інакше публічний «джекпот» обернеться хейтом.
    let note, claim = null;
    if (prize.kind === 'tier') {
      claim = { id: prize.id, label: prize.label, text: JP_GIFT_TEXT, entities: [], via: defaultVia(prize.id), status: 'pending', at: Date.now() };
      setClaim(uid, String(msgId), claim);
      claim.name = name;
      note = 'переможець обирає підпис і від кого — у боті; у чаті оголошу, щойно забере';
    } else if (prize.kind === 'realstars') {
      claim = { kind: 'realstars', n: prize.n, label: prize.label, link: null, status: 'pending', at: Date.now(), name };
      setClaim(uid, String(msgId), claim);
      note = 'переможець дає посилання на пост свого каналу — у чаті оголошу, щойно забере';
    } else if (prize.kind === 'stars') { users.move(uid, { stars: prize.n }, 'jackpot', {}); note = 'на балансі'; }
    else if (prize.kind === 'tickets') { users.move(uid, { tickets: prize.n }, 'jackpot', {}); note = 'на балансі'; }
    else { progress.addXp(uid, 'admin', prize.n, { why: 'jackpot' }); note = 'XP зараховано'; }
    // Подарунок — в чаті оголошуємо, коли переможець забере (з його підписом); решту — одразу.
    let ok = null;
    if (!claim) {
      await ctx.editMessageText(`⏳ Джекпот ${name}: ${prize.label} — оголошую в чаті…`).catch(() => {});
      ok = chat() ? await chat().jackpot(msgId, { name }, prize.label, { kind: prize.kind }) : false;
    }
    if (claim) {
      // Переможцю — лише картка: підпис і від кого.
      const card = claim.kind === 'realstars' ? [rsCard(claim), { parse_mode: 'HTML', disable_web_page_preview: true, ...rsKb(String(msgId), claim) }] : [claimCard(claim), { parse_mode: 'HTML', ...claimKb(String(msgId), claim) }];
      if (!(await notify.dm(uid, card[0], card[1]))) note += ' ⚠️ повідомлення не дійшло — людина ще не запускала бота';
    } else {
      notify.dm(uid, withEmoji(`{:crown} <b>ДЖЕКПОТ ЗА АКТИВНІСТЬ!</b>\n━━━━━━━━━━━━━━\nStarForge помітив твою активність у чаті — <b>${prize.label}</b> твоя!\n\n{:check} Уже зараховано на баланс.\n\n{:almost} Дякуємо, що ти з нами — спілкуйся далі!`));
    }
    jpPending.delete(msgId);
    await ctx.editMessageText(`✅ Джекпот ${name}: ${prize.label} (${note})` + (ok === null ? '' : ok ? '\nОголошено в чаті 🎉' : '\n⚠️ У чат написати не вдалось — /chat_status')).catch(() => {});
  }
}

module.exports = { register, jpParseLink, esc, store };
