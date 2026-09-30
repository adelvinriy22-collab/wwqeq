// ==========================================================================
// ПРАВИЛА ЧАТУ. /rules — список правил. Правило 1: згадки в чаті про
// невиплачені чи «довгі» заявки, вивід, «не прийшло» тощо заборонені —
// питання щодо заявок лише в підтримку. Порушення: повідомлення видаляється,
// бан на 7 днів; з 3-го порушення — назавжди. Адміну — сповіщення з текстом
// і кнопкою «Розбанити» (на випадок помилкового спрацювання), /unban @нік.
// Лічильник порушень — featureFlags.chatRules.strikes (і для тих, хто не в боті).
// ==========================================================================
const config = require('../config');
const store = require('../store');
const users = require('../core/users');
const notify = require('../core/notify');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');

const DAY = 86400e3;
const RULES = [
  {
    id: 'payouts', banDays: 7, permAfter: 3,
    text: 'Жодних згадок у чаті про невиплачені чи «довгі» заявки, вивід, «не прийшло» тощо.',
  },
];

// Правило 1. Порушення — явна скарга («не виплатили», «невиплачена») або тема
// (заявка, вивід, виплата) разом зі скаргою (довго, досі, не прийшло, чекаю, скам…).
const STRONG = /(невипла|не\s*випла|невыпла|не\s*выпла|не\s*плат(ить|ять|ит|ят|или|или)|не\s*вивел|не\s*вывел|не\s*вивод|не\s*вывод|не\s*видал|не\s*выдал)/i;
const TOPIC = /(заявк|заявоч|вив[іо]д|вивел|вивест|вивод|выв[оа]д|вывел|вывест|виплат|выплат|withdraw|payout)/i;
const PROBLEM = /(не\s*(прийш|приход|прих[оі]|надійш|надход|отрим|получ|дал|да[юв]|пришл|пришё|пришел|працю|обробл|схвал|одобр)|досі|до\s*сих|досих|ще\s*не|все\s*ще|вс[её]\s*ещ[её]|довго|долго|затрим|задерж|чекаю|чекаєм|жду|жд[её]м|скам|scam|обман|кину|кида|развод|розвод|фейк|лохотрон|де\s*(мо[їяє]|м[оі]й)|где\s*(мо[йяие])|\bнема\b|немає|\bнет\b|ніхто\s*не|никто\s*не|коли\s*(вже|нарешті)|когда\s*(уже|же))/i;
function violates(text) {
  const t = String(text || '').toLowerCase().replace(/[ʼ’']/g, '');
  if (t.length < 3) return false;
  return STRONG.test(t) || (TOPIC.test(t) && PROBLEM.test(t));
}

const st = () => (store.getFeatureFlags() || {}).chatRules || { strikes: {} };
const save = (s) => store.setFeatureFlags({ chatRules: s });
const whoOf = (from) => from.username ? '@' + from.username : esc(from.first_name || 'гравець');

function rulesText() {
  const r = RULES[0];
  return withEmoji('{:infoIcon} <b>ПРАВИЛА ЧАТУ</b>\n━━━━━━━━━━━━━━\n' +
    `1️⃣ ${r.text}\n` +
    `Питання щодо заявки — лише в підтримку: <b>${esc(config.SUPPORT)}</b>\n` +
    `{:redCircle} Порушення — бан на <b>${r.banDays} днів</b>, з ${r.permAfter}-го разу — <b>назавжди</b>.\n\n` +
    '<i>Порушення бот видаляє й карає автоматично.</i>');
}

// Перевірити повідомлення в чаті. true — порушення (повідомлення видалено, бан).
async function enforce(ctx, chatId) {
  const m = ctx.message;
  const from = ctx.from;
  if (!m || !from || from.is_bot || m.sender_chat || users.isAdmin(from.id)) return false;
  const text = m.text || m.caption || '';
  if (text.startsWith('/') || !violates(text)) return false;
  const r = RULES[0];
  const uid = String(from.id);
  const s = st();
  const prev = s.strikes[uid] || { n: 0 };
  const n = prev.n + 1;
  const perm = n >= r.permAfter;
  s.strikes[uid] = { n, at: Date.now(), chat: chatId, name: from.username ? '@' + from.username : (from.first_name || ''), perm };
  save(s);                                                   // до await — друге повідомлення не «загубить» лічильник
  const tg = ctx.telegram;
  await tg.deleteMessage(chatId, m.message_id).catch(() => {});
  await tg.callApi('banChatMember', { chat_id: chatId, user_id: Number(uid), revoke_messages: false,
    ...(perm ? {} : { until_date: Math.floor((Date.now() + r.banDays * DAY) / 1000) }) }).catch((e) => console.error('rules ban:', e.message));
  const term = perm ? 'назавжди' : `на ${r.banDays} днів`;
  await tg.sendMessage(chatId, withEmoji(`{:redCircle} ${whoOf(from)} — бан ${term} за правило чату №1.\n` +
    `Питання щодо заявок — лише в підтримку ${esc(config.SUPPORT)} · /rules`), { parse_mode: 'HTML' }).catch(() => {});
  notify.dm(uid, withEmoji(`{:redCircle} Тебе заблоковано в чаті <b>${term}</b>: згадки про невиплачені чи довгі заявки в чаті заборонені (/rules).\n\n` +
    `Питання щодо твоєї заявки — пиши в підтримку: <b>${esc(config.SUPPORT)}</b>` +
    (perm ? '' : `\n<i>Порушень: ${n}/${r.permAfter}. На ${r.permAfter}-му — бан назавжди.</i>`)));
  notify.admin(`🚫 Правило чату №1: ${whoOf(from)} · <code>${uid}</code> — бан ${term} (порушення ${n}/${r.permAfter})\n«${esc(text.slice(0, 300))}»`,
    { reply_markup: { inline_keyboard: [[{ text: '↩️ Розбанити', callback_data: 'rules_unban_' + uid, style: 'success' }]] } });
  return true;
}

// Розбанити (помилкове спрацювання): знімаємо бан і одне порушення.
async function unban(telegram, uid) {
  uid = String(uid);
  const s = st();
  const rec = s.strikes[uid];
  const chatId = (rec && rec.chat) || (notify.tg.chat && notify.tg.chat.status && notify.tg.chat.status().chatId);
  if (!chatId) return { ok: false, error: 'no_chat' };
  await telegram.callApi('unbanChatMember', { chat_id: chatId, user_id: Number(uid), only_if_banned: true }).catch((e) => console.error('rules unban:', e.message));
  if (rec) { rec.n = Math.max(0, rec.n - 1); rec.perm = false; save(s); }
  return { ok: true, name: rec ? rec.name : uid, left: rec ? rec.n : 0 };
}

function register(bot) {
  bot.command('rules', (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    return ctx.reply(rulesText(), { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  });
  const isAdminCtx = (ctx) => ctx.from && users.isAdmin(ctx.from.id);
  bot.action(/^rules_unban_(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCbQuery().catch(() => {});
    const r = await unban(ctx.telegram, ctx.match[1]);
    await ctx.answerCbQuery(r.ok ? '↩️ Розбанено' : 'Не знайшов чат').catch(() => {});
    if (r.ok) await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Розбанено', callback_data: 'noop' }]] }).catch(() => {});
  });
  bot.command('unban', async (ctx) => {
    if (!isAdminCtx(ctx) || (ctx.chat && ctx.chat.type !== 'private')) return;
    const arg = ctx.message.text.split(/\s+/)[1];
    const u = arg ? users.findByUsernameOrId(arg) : null;
    const uid = u ? String(u.id) : (/^\d+$/.test(arg || '') ? arg : null);
    if (!uid) return ctx.reply('Кого? /unban @нік або /unban id');
    const r = await unban(ctx.telegram, uid);
    return ctx.reply(r.ok ? `↩️ ${r.name} розбанено в чаті. Порушень лишилось: ${r.left}.` : 'Не знайшов чат — спершу /chat_here у групі.');
  });
}

module.exports = { RULES, violates, enforce, unban, rulesText, register };
