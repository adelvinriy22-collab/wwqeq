// ==========================================================================
// РОЗСИЛКИ, ЧАТ І ДЖЕКПОТ.
//   /broadcast — відповіддю на повідомлення: усім гравцям в особисті
//   /chat_say, /chat_post [pin], /post_all, /chats — публікації в групи
//   /chat_status, /chat_debug, /chat_drop, /chat_quiz, /chat_word, /chat_top,
//   /chat_contest HH:MM [N], /chat_contest_status, /chat_contest_end,
//   /chat_pause, /chat_resume
//   Посилання на повідомлення з чату → «ДЖЕКПОТ» з реальним призом.
// ==========================================================================
const store = require('../../store');
const users = require('../../core/users');
const progress = require('../../core/progress');
const notify = require('../../core/notify');
const applications = require('../../features/applications');
const tggifts = require('../../features/tggifts');
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
  bear: { label: '🧸 Мішку', kind: 'tier', id: 'bear' },
  gift: { label: '🎁 Подарунок', kind: 'tier', id: 'gift' },
  s5:   { label: '5 ⭐', kind: 'stars', n: 5 },
  t20:  { label: '20 🎫', kind: 'tickets', n: 20 },
  x100: { label: '✨ +100 XP', kind: 'xp', n: 100 },
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
      '\n\nЯкий приз?\n🧸 Мішку (15⭐) і 🎁 Подарунок (25⭐) бот надішле <b>одразу сам</b> — справжнім подарунком Telegram з балансу зірок бота.', { parse_mode: 'HTML', ...ui.kb([
      [ui.cb('🧸 Мішка — одразу', `jp_${msgId}_bear`, 'danger'), ui.cb('🎁 Подарунок — одразу', `jp_${msgId}_gift`, 'danger')],
      [ui.cb('20 🎫', `jp_${msgId}_t20`, 'primary'), ui.cb('5 ⭐', `jp_${msgId}_s5`, 'primary')],
      [ui.cb('✨ +100 XP (безкоштовно)', `jp_${msgId}_x100`, 'success')],
    ]) });
  }
  bot.command('jackpot', async (ctx) => { if (!isAdminCtx(ctx)) return; await jackpotAsk(ctx, ctx.message.text); });
  hooks.onAdminText.push(async (ctx, text) => {
    if (!jpParseLink(text) || /^\//.test(text)) return false;
    await jackpotAsk(ctx, text);
    return true;
  });
  bot.action(/^jp_(\d+)_(bear|gift|s5|t20|x100|p100)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    const msgId = Number(ctx.match[1]);
    const prize = JP_PRIZES[ctx.match[2] === 'p100' ? 'x100' : ctx.match[2]];
    // Друге натискання (або інша кнопка) по тому самому повідомленню — приз уже видано.
    if (jpDone.has(msgId)) return ctx.reply('Цей джекпот уже видано.').catch(() => {});
    jpDone.add(msgId);
    const known = chat() ? chat().authorOf(msgId) : null;
    const uid = jpPending.get(msgId) || (known && known.uid);
    if (!uid) return ctx.reply('Автора вже не знаю — надішли посилання ще раз із @username.');
    if (!users.get(uid) && known) users.ensure({ id: uid, first_name: known.plain });
    const u = users.get(uid) || {};
    const name = u.username ? '@' + u.username : (known ? known.name : 'гравець');
    // Приз видається СПРАВЖНІЙ — інакше публічний «джекпот» обернеться хейтом.
    let note, auto = false;
    if (prize.kind === 'tier') {
      // Мішку й Подарунок бот надсилає одразу сам — справжнім подарунком Telegram.
      const g = tggifts.canSend(prize.id) ? await tggifts.send(uid, prize.id, JP_GIFT_TEXT) : { ok: false, error: 'manual' };
      const a = applications.create(uid, prize.id, 'chat_jackpot', g.ok ? { autoSent: true } : {}, { silent: true });
      if (g.ok) {
        a.status = 'approved'; a.decidedAt = Date.now(); store.save();
        auto = true; note = 'надіслано одразу, подарунком Telegram ✅';
      } else {
        note = 'заявка #' + a.id + ' (автоматично не вийшло: ' + g.error + (g.lowBalance ? ' — замало зірок на балансі бота' : '') + ')';
      }
    } else if (prize.kind === 'stars') { users.move(uid, { stars: prize.n }, 'jackpot', {}); note = 'на балансі'; }
    else if (prize.kind === 'tickets') { users.move(uid, { tickets: prize.n }, 'jackpot', {}); note = 'на балансі'; }
    else { progress.addXp(uid, 'admin', prize.n, { why: 'jackpot' }); note = 'XP зараховано'; }
    await ctx.editMessageText(`⏳ Джекпот ${name}: ${prize.label} — оголошую в чаті…`).catch(() => {});
    const kind = prize.kind === 'tier' ? prize.id : prize.kind;
    const ok = chat() ? await chat().jackpot(msgId, { name }, prize.label, { kind, auto }) : false;
    notify.dm(uid, withEmoji(`{:crown} <b>ДЖЕКПОТ ЗА АКТИВНІСТЬ!</b>\n━━━━━━━━━━━━━━\nАдмін помітив твою активність у чаті й обрав саме тебе — <b>${prize.label}</b>!\n\n` +
      (auto ? '{:lightning} <b>Бот уже надіслав подарунок</b> — глянь у свій профіль Telegram → «Подарунки» {:giftBox}'
        : prize.kind === 'tier' ? '{:pendingIcon} Заявку створено — видамо найближчим часом.' : '{:check} Уже зараховано на баланс.') +
      '\n\n{:almost} Дякуємо, що ти з нами — спілкуйся далі!'));
    jpPending.delete(msgId);
    await ctx.editMessageText(`✅ Джекпот ${name}: ${prize.label} (${note})` + (ok ? '\nОголошено в чаті 🎉' : '\n⚠️ У чат написати не вдалось — /chat_status')).catch(() => {});
  });
}

module.exports = { register, jpParseLink, esc, store };
