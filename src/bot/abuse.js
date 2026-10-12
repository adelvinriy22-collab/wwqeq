// ==========================================================================
// /abuse @нік причина — попередження за абуз бота і «скасувати все»
// (features/abuse.js): спершу перегляд, що саме буде скасовано, і кнопка
// «Покарати»; /unabuse @нік — повернути зняті зірки й XP.
// ==========================================================================
const users = require('../core/users');
const notify = require('../core/notify');
const abuse = require('../features/abuse');
const applications = require('../features/applications');
const ui = require('./ui');
const { withEmoji } = require('../emoji');
const { esc, fmtStars } = require('../lib/util');
const { isAdminCtx, argsOf } = require('./admin/shared');

const T = {
  uk: {
    title: 'ПОПЕРЕДЖЕННЯ ЗА АБУЗ БОТА',
    intro: 'Ми помітили зловживання ботом.',
    reason: 'Причина: <b>{reason}</b>',
    apps: '• Заявки скасовано без повернення: <b>{n}</b>',
    stars: '• Баланс зірок обнулено: <b>−{stars}⭐</b>',
    xp: '• XP і рівень скинуто: <b>−{xp} XP</b>',
    foot: 'Повторне порушення — блокування виводу. Питання — у підтримку.',
    undoTitle: 'ПОПЕРЕДЖЕННЯ ЗНЯТО',
    undo: 'Покарання скасовано — повернуто: <b>{stars}⭐</b> і <b>{xp} XP</b>.',
  },
  en: {
    title: 'WARNING: BOT ABUSE',
    intro: 'We noticed abuse of the bot.',
    reason: 'Reason: <b>{reason}</b>',
    apps: '• Requests cancelled without refund: <b>{n}</b>',
    stars: '• Star balance reset: <b>−{stars}⭐</b>',
    xp: '• XP and level reset: <b>−{xp} XP</b>',
    foot: 'Another violation — withdrawals get blocked. Questions — contact support.',
    undoTitle: 'WARNING LIFTED',
    undo: 'The penalty was cancelled — returned: <b>{stars}⭐</b> and <b>{xp} XP</b>.',
  },
  ru: {
    title: 'ПРЕДУПРЕЖДЕНИЕ ЗА АБУЗ БОТА',
    intro: 'Мы заметили злоупотребление ботом.',
    reason: 'Причина: <b>{reason}</b>',
    apps: '• Заявки отменены без возврата: <b>{n}</b>',
    stars: '• Баланс звёзд обнулён: <b>−{stars}⭐</b>',
    xp: '• XP и уровень сброшены: <b>−{xp} XP</b>',
    foot: 'Повторное нарушение — блокировка вывода. Вопросы — в поддержку.',
    undoTitle: 'ПРЕДУПРЕЖДЕНИЕ СНЯТО',
    undo: 'Наказание отменено — возвращено: <b>{stars}⭐</b> и <b>{xp} XP</b>.',
  },
};
const L = (u) => (T[(u || {}).lang] ? u.lang : 'uk');
const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] !== undefined ? p[k] : m));
const who = (u) => (u.username ? '@' + u.username : esc(u.name || '—')) + ' · id <code>' + u.id + '</code>';

// Попередження гравцю — лише те, що справді скасовано.
function warnText(u, r, reason) {
  const t = T[L(u)];
  return withEmoji(ui.card('warn', t.title, [
    t.intro,
    reason ? fill(t.reason, { reason: esc(reason) }) : null,
    '',
    r.apps.length ? fill(t.apps, { n: r.apps.length }) : null,
    r.stars > 0 ? fill(t.stars, { stars: fmtStars(r.stars) }) : null,
    r.xp > 0 ? fill(t.xp, { xp: fmtStars(r.xp) }) : null,
  ], t.foot));
}

// Причина між переглядом і кнопкою (callback_data — до 64 байт).
const drafts = new Map();   // uid -> { reason, by, at }

function register(bot) {
  bot.command('abuse', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const [q, ...rest] = argsOf(ctx);
    const u = q ? users.findByUsernameOrId(q) : null;
    if (!u) {
      return ctx.reply('Формат: <code>/abuse @нік причина</code> — попередження за абуз і скасувати все: ' +
        'заявки (без повернення), баланс зірок, XP і рівень. Спершу покажу, що саме.\nВідмінити: <code>/unabuse @нік</code>', { parse_mode: 'HTML' }).catch(() => {});
    }
    if (users.isAdmin(u.id)) return ctx.reply('Це адмін.').catch(() => {});
    const reason = rest.join(' ').slice(0, 200);
    const p = abuse.preview(u.id);
    drafts.set(String(u.id), { reason, by: String(ctx.from.id), at: Date.now() });
    const apps = p.apps.map(a => '#' + a.id + ' ' + esc(applications.label(a, 'uk'))).join(', ');
    await ctx.reply(withEmoji(ui.card('warn', 'АБУЗ: СКАСУВАТИ ВСЕ?', [
      'Гравець: ' + who(u),
      'Причина: <b>' + (reason ? esc(reason) : '—') + '</b>',
      '',
      '• Заявки без повернення: <b>' + p.apps.length + '</b>' + (apps ? ' (' + apps + ')' : ''),
      '• Баланс зірок: <b>' + fmtStars(p.stars) + '⭐</b> → 0',
      '• XP: <b>' + fmtStars(p.xp) + '</b> (рівень ' + p.level + ') → 0',
      p.prev ? '\n⚠️ Уже має непогашене попередження (' + new Date(p.prev.at).toLocaleDateString('uk-UA') + ').' : null,
    ], 'Гравець отримає попередження з причиною. Відмінити: /unabuse')), {
      parse_mode: 'HTML',
      ...ui.kb([[ui.cb('🚫 Покарати', 'abuse_go_' + u.id, 'danger'), ui.cb('Скасувати', 'abuse_no_' + u.id)]]),
    }).catch(() => {});
  });

  bot.action(/^abuse_go_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    const uid = ctx.match[1];
    const d = drafts.get(uid);
    // Чернетку забираємо до першого await — друге натискання вже нічого не зробить.
    drafts.delete(uid);
    if (!d) return ctx.answerCbQuery('Вже виконано або застаріло — /abuse ще раз').catch(() => {});
    const u = users.get(uid);
    const r = abuse.punish(uid, d.reason, ctx.from.id);
    await ctx.answerCbQuery(r.ok ? '🚫 Покарано' : 'Не вийшло').catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    if (!r.ok) return ctx.reply('Не вийшло: ' + r.error).catch(() => {});
    notify.dm(uid, warnText(u, r, d.reason));
    await ctx.reply(withEmoji(ui.card('check', 'ПОКАРАНО', [
      'Гравець: ' + who(u),
      '• Скасовано заявок: <b>' + r.apps.length + '</b>' + (r.apps.length ? ' (#' + r.apps.join(', #') + ')' : ''),
      '• Знято зірок: <b>' + fmtStars(r.stars) + '⭐</b>',
      '• Знято XP: <b>' + fmtStars(r.xp) + '</b> (був рівень ' + r.level + ')',
      '• Попереджень усього: <b>' + r.count + '</b>',
    ], 'Попередження надіслано. Відмінити: /unabuse ' + (u.username ? '@' + u.username : uid))), { parse_mode: 'HTML' }).catch(() => {});
  });
  bot.action(/^abuse_no_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    drafts.delete(ctx.match[1]);
    await ctx.answerCbQuery('Скасовано').catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  bot.command('unabuse', async (ctx) => {
    if (!isAdminCtx(ctx)) return;
    const u = users.findByUsernameOrId(argsOf(ctx)[0] || '');
    if (!u) return ctx.reply('Формат: /unabuse @нік — повернути зняті зірки й XP (заявки не відновлюються).').catch(() => {});
    const r = abuse.undo(u.id);
    if (!r.ok) return ctx.reply(r.error === 'not_punished' ? 'У ' + (u.username ? '@' + u.username : u.id) + ' немає покарання за абуз.' : 'Не вийшло: ' + r.error).catch(() => {});
    const t = T[L(u)];
    notify.dm(u.id, withEmoji(ui.card('check', t.undoTitle, [fill(t.undo, { stars: fmtStars(r.stars), xp: fmtStars(r.xp) })])));
    await ctx.reply('✅ Покарання знято з ' + (u.username ? '@' + u.username : u.id) + ': повернуто ' + fmtStars(r.stars) + '⭐ і ' + fmtStars(r.xp) + ' XP.' +
      (r.apps.length ? '\nСкасовані заявки (#' + r.apps.join(', #') + ') не відновлюються.' : '')).catch(() => {});
  });
}

module.exports = { register, T };
