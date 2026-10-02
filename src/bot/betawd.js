// ==========================================================================
// БЕТА-ВИВІД 1–4⭐ НА КАНАЛ. Гравець обирає суму, дає посилання на пост у
// своєму публічному каналі — акаунт власника ставить під постом платну
// реакцію ⭐ на цю суму, анонімно (features/usergifts.sendPaidReaction).
// Спершу — великий дисклеймер. Списання до відправки (синхронно, до await),
// Telegram відхилив — повернення. Раз на E.BETA_WD.cooldownMs.
// ==========================================================================
const users = require('../core/users');
const notify = require('../core/notify');
const usergifts = require('../features/usergifts');
const sponsor = require('../features/sponsor');
const ui = require('./ui');
const E = require('../economy');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');

// Спільний дисклеймер — також для джекпоту реальними зірками.
const DISCLAIMER = [
  '{:warn} <b>ОБОВ\'ЯЗКОВО ПРОЧИТАЙ:</b>',
  '1️⃣ Зірки надходять на <b>ТВІЙ канал</b> — платною реакцією ⭐ під постом.',
  '2️⃣ Ти <b>обов\'язково</b> маєш дати посилання на пост у своєму <b>публічному</b> каналі: <code>https://t.me/канал/123</code>',
  '3️⃣ У каналі мають бути <b>увімкнені платні реакції</b> (Керування каналом → Реакції → Платні ⭐).',
  '4️⃣ Зірки надсилаються <b>анонімно</b>.',
  '5️⃣ Мінімальний вивід зірок із каналу в Telegram — <b>1000⭐</b>. На це ми <b>ніяк не впливаємо</b>.',
  '6️⃣ Неправильне посилання або вимкнені реакції — зірки не дійдуть (якщо Telegram відхилить — повернемо на баланс).',
].join('\n');
const HINT = {
  link: 'Перевір посилання: пост у публічному каналі, формат https://t.me/канал/123.',
  reactions: 'У каналі вимкнені платні реакції — увімкни: Керування каналом → Реакції → Платні ⭐.',
  balance: 'Тимчасово недоступно — спробуй пізніше.',
  other: 'Спробуй ще раз пізніше.',
};

const flow = new Map();   // uid -> { step: 'amount'|'link'|'confirm', amount, link }
const busy = new Set();

function startCard() {
  return withEmoji(ui.card('lightning', 'БЕТА-ВИВІД НА КАНАЛ · 1–4⭐', [
    'Виводь маленькі суми прямо на свій Telegram-канал.',
    '',
    DISCLAIMER,
  ], 'Бета-режим · раз на добу · без комісії'));
}

function register(bot, hooks) {
  const open = async (ctx) => {
    const uid = String(ctx.from.id);
    if (!usergifts.accountReady() && !usergifts.dryRun()) return ctx.reply('🧪 Бета-вивід тимчасово недоступний.').catch(() => {});
    flow.set(uid, { step: 'amount' });
    await ctx.reply(startCard(), { parse_mode: 'HTML', ...ui.kb([
      E.BETA_WD.amounts.map(n => ui.cb(n + '⭐', 'bw:a' + n, 'success', 'starIcon')),
      [ui.back((users.get(uid) || {}).lang || 'uk')],
    ]) }).catch(() => {});
  };
  bot.command('beta_wd', open);
  bot.action('bw:start', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await open(ctx); });

  bot.action(/^bw:a(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const uid = String(ctx.from.id), n = Number(ctx.match[1]);
    if (!E.BETA_WD.amounts.includes(n)) return;
    const u = users.get(uid) || {};
    if (users.stars(u) < n) return ctx.reply(`❌ На балансі ${users.stars(u)}⭐ — замало для ${n}⭐.`).catch(() => {});
    const wait = (u.betaWdAt || 0) + E.BETA_WD.cooldownMs - Date.now();
    if (wait > 0 && !users.isAdmin(uid)) return ctx.reply(`⏳ Бета-вивід — раз на добу. Наступний — через ${Math.ceil(wait / 3600e3)} год.`).catch(() => {});
    if (!(await sponsor.okForWithdraw(uid))) return ctx.reply('❌ Спершу підпишись на ' + sponsor.channel() + ' — це умова виводу.').catch(() => {});
    flow.set(uid, { step: 'link', amount: n });
    await ctx.reply(withEmoji('{:lightning} Надішли <b>посилання на пост</b> у своєму публічному каналі, під який прийде <b>' + n + '⭐</b>.\nПриклад: <code>https://t.me/mychannel/15</code>\n\n<i>Платні реакції в каналі мають бути увімкнені.</i>'), { parse_mode: 'HTML' }).catch(() => {});
  });

  hooks.onText.push(async (ctx, uid, text) => {
    const f = flow.get(uid);
    if (!f || f.step !== 'link') return false;
    const p = usergifts.parsePostLink(text);
    if (!p) { await ctx.reply('❌ Це не схоже на посилання на пост публічного каналу. Формат: https://t.me/канал/123').catch(() => {}); return true; }
    f.step = 'confirm'; f.link = p.link;
    await ctx.reply(withEmoji(ui.card('eye', 'ПЕРЕВІР ПЕРЕД ВИВОДОМ', [
      '{:starIcon} Сума: <b>' + f.amount + '⭐</b> (спишеться з балансу)',
      '{:megaphone} Пост: ' + esc(p.link),
      '{:lightning} Як: платна реакція ⭐, <b>анонімно</b>',
      '',
      '{:warn} Платні реакції в каналі <b>увімкнені</b>? Вивід із каналу в Telegram — від <b>1000⭐</b>, на це ми не впливаємо.',
    ])), { parse_mode: 'HTML', disable_web_page_preview: true, ...ui.kb([
      [ui.cb('ВИВЕСТИ ' + f.amount + '⭐', 'bw:go', 'success', 'starIcon')],
      [ui.cb('ІНШЕ ПОСИЛАННЯ', 'bw:a' + f.amount, 'primary'), ui.cb('СКАСУВАТИ', 'bw:cancel', 'danger')],
    ]) }).catch(() => {});
    return true;
  });
  hooks.onCommand.push((uid) => { const f = flow.get(uid); if (f && f.step === 'link') flow.delete(uid); });

  bot.action('bw:cancel', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); flow.delete(String(ctx.from.id)); await ctx.editMessageText('🚫 Скасовано.').catch(() => {}); });

  bot.action('bw:go', async (ctx) => {
    const uid = String(ctx.from.id), f = flow.get(uid);
    if (!f || f.step !== 'confirm' || busy.has(uid)) return ctx.answerCbQuery(busy.has(uid) ? '⏳ Уже надсилаю…' : 'Почни заново: /beta_wd').catch(() => {});
    // Подвійне натискання й списання — синхронно, до першого await.
    busy.add(uid); flow.delete(uid);
    const r = users.move(uid, { stars: -f.amount }, 'beta_withdraw', { link: f.link });
    if (!r.ok) { busy.delete(uid); return ctx.answerCbQuery('Замало зірок на балансі', { show_alert: true }).catch(() => {}); }
    users.patch(uid, { betaWdAt: Date.now() });
    await ctx.answerCbQuery('⏳ Надсилаю…').catch(() => {});
    await ctx.editMessageText('⏳ Надсилаю ' + f.amount + '⭐ на канал…').catch(() => {});
    const s = await usergifts.sendPaidReaction(f.link, f.amount);
    busy.delete(uid);
    const u = users.get(uid) || {};
    if (!s.ok) {
      users.move(uid, { stars: f.amount }, 'refund', { why: 'beta_withdraw', error: s.error });
      users.patch(uid, { betaWdAt: 0 });
      notify.admin(`⚠️ Бета-вивід не вдався: ${u.username ? '@' + u.username : uid} — ${f.amount}⭐ → ${esc(f.link)}\n<code>${esc(s.error)}</code>`);
      return ctx.reply(withEmoji('{:warn} <b>Не вдалося надіслати.</b> ' + (HINT[s.hint] || HINT.other) + '\n{:check} ' + f.amount + '⭐ повернуто на баланс.'), { parse_mode: 'HTML' }).catch(() => {});
    }
    notify.admin(`🧪 Бета-вивід: ${u.username ? '@' + u.username : uid} — ${f.amount}⭐ → ${esc(f.link)}` + (s.dry ? ' (сухий прогін)' : ''));
    await ctx.reply(withEmoji(ui.card('check', f.amount + '⭐ НАДІСЛАНО НА КАНАЛ!', [
      '{:megaphone} Під постом: ' + esc(f.link),
      '{:lightning} Платна реакція ⭐, анонімно.',
    ], 'Вивід із каналу в Telegram — від 1000⭐')), { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  });
}

module.exports = { register, DISCLAIMER, HINT };
