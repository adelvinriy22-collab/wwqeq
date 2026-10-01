// ==========================================================================
// ТЕСТ: подарунок від АКАУНТА власника (MTProto, features/usergifts.js).
// /ugift @нік [тип] [підпис] → картка-прев'ю: кому, що, ціна, підпис рівно
// так, як його побачать → «Надіслати» / «Змінити підпис» / «Без підпису» /
// «В чат: так/ні» / «Скасувати». Після надсилання — картка адміну,
// привітання отримувачу від бота й (за бажанням) оголошення в чаті.
// Стан — у пам'яті: чернетка на адміна; «sending» ставиться до першого await.
// ==========================================================================
const users = require('../core/users');
const notify = require('../core/notify');
const ui = require('./ui');
const { withEmoji } = require('../emoji');
const { esc } = require('../lib/util');
const tggifts = require('../features/tggifts');
const usergifts = require('../features/usergifts');

const NAMES = { heart: 'Серце', bear: 'Мішка', rose: 'Троянда', gift: 'Подарунок', cake: 'Торт', bouquet: 'Букет',
  champagne: 'Шампанське', rocket: 'Ракета', trophy: 'Кубок', ring: 'Каблучка', diamond: 'Діамант' };

// Отримувачу — мовою гравця.
const T = {
  uk: { title: 'ТОБІ ПОДАРУНОК!', body: '{gift} <b>{name}</b> уже в твоєму профілі Telegram — особисто від власника <b>StarForge</b> {:crown}', caption: '{:eye} Підпис:', foot: 'Глянь: профіль Telegram → «Подарунки»' },
  en: { title: 'A GIFT FOR YOU!', body: '{gift} <b>{name}</b> is already in your Telegram profile — personally from the <b>StarForge</b> owner {:crown}', caption: '{:eye} Caption:', foot: 'Check: Telegram profile → «Gifts»' },
  ru: { title: 'ТЕБЕ ПОДАРОК!', body: '{gift} <b>{name}</b> уже в твоём профиле Telegram — лично от владельца <b>StarForge</b> {:crown}', caption: '{:eye} Подпись:', foot: 'Загляни: профиль Telegram → «Подарки»' },
};
const NAMES_I18N = { en: { bear: 'Teddy Bear', heart: 'Heart', rose: 'Rose', gift: 'Gift Box', cake: 'Cake', bouquet: 'Bouquet', champagne: 'Champagne', rocket: 'Rocket', trophy: 'Trophy', ring: 'Ring', diamond: 'Diamond' },
  ru: { bear: 'Мишка', heart: 'Сердце', rose: 'Роза', gift: 'Подарок', cake: 'Торт', bouquet: 'Букет', champagne: 'Шампанское', rocket: 'Ракета', trophy: 'Кубок', ring: 'Кольцо', diamond: 'Бриллиант' } };
const giftIcon = (tier) => tier === 'bear' ? '{:teddyBear}' : tier === 'gift' ? '{:giftBox}' : tggifts.CATALOG[tier].emoji;
const nameOf = (tier, lang) => ((NAMES_I18N[lang] || {})[tier]) || NAMES[tier];
const whoTxt = (d) => d.username ? '@' + esc(d.username) : esc(d.name || d.target);

// Підпис у HTML з форматуванням (для карток) — простий розбір за entities.
function captionHtml(text, ents) {
  if (!text) return null;
  const tags = { bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', spoiler: 'tg-spoiler' };
  const opens = {}, closes = {};
  for (const e of ents || []) {
    const o = e.type === 'custom_emoji' ? '<tg-emoji emoji-id="' + e.custom_emoji_id + '">' : tags[e.type] ? '<' + tags[e.type] + '>' : null;
    if (!o) continue;
    const c = e.type === 'custom_emoji' ? '</tg-emoji>' : '</' + tags[e.type] + '>';
    (opens[e.offset] = opens[e.offset] || []).push(o);
    (closes[e.offset + e.length] = closes[e.offset + e.length] || []).unshift(c);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    if (closes[i]) out += closes[i].join('');
    if (opens[i]) out += opens[i].join('');
    if (i < text.length) out += esc(text[i]);
  }
  return '<blockquote>' + out + '</blockquote>';
}

const drafts = new Map();   // adminUid -> { target, uid, username, name, tier, text, entities, announce, status, at }
const awaiting = new Set(); // адміни, від яких чекаємо підпис

function previewCard(d) {
  const c = tggifts.CATALOG[d.tier];
  return withEmoji(ui.card('giftBox', 'ПОДАРУНОК ВІД ВАШОГО АКАУНТА', [
    '{:crown} Кому: <b>' + whoTxt(d) + '</b>' + (d.uid ? ' · <code>' + d.uid + '</code>' : ''),
    giftIcon(d.tier) + ' Що: <b>' + NAMES[d.tier] + '</b> · ' + c.stars + '{:starIcon} з балансу акаунта',
    '{:megaphone} Оголосити в чаті: <b>' + (d.announce ? 'так' : 'ні') + '</b>',
    '',
    d.text ? '{:eye} <b>Підпис (так його побачать):</b>\n' + captionHtml(d.text, d.entities) : '{:eye} Без підпису',
  ], (usergifts.dryRun() ? 'СУХИЙ ПРОГІН — зірки не списуються · ' : 'Тестовий режим · ') + 'підпис до ' + usergifts.TEXT_MAX + ' символів'));
}
function previewKb(d) {
  return { parse_mode: 'HTML', ...ui.kb([
    [ui.cb('НАДІСЛАТИ ' + NAMES[d.tier].toUpperCase(), 'ug:send', 'success', d.tier === 'bear' ? 'teddyBear' : 'giftBox')],
    [ui.cb(d.text ? 'ЗМІНИТИ ПІДПИС' : 'НАПИСАТИ ПІДПИС', 'ug:text', 'primary', 'lightning'), d.text ? ui.cb('БЕЗ ПІДПИСУ', 'ug:clear') : null].filter(Boolean),
    [ui.cb('В ЧАТ: ' + (d.announce ? 'ТАК' : 'НІ'), 'ug:ann', null, 'megaphone'), ui.cb('СКАСУВАТИ', 'ug:cancel', 'danger')],
  ]) };
}
const showPreview = (ctx, d) => ctx.reply(previewCard(d), previewKb(d)).catch(() => {});

async function doSend(ctx, aid) {
  const d = drafts.get(aid);
  if (!d) return ctx.reply('Чернетки немає — почніть з /ugift @нік').catch(() => {});
  if (d.status === 'sending') return ctx.reply('⏳ Уже надсилаю — зачекайте кілька секунд.').catch(() => {});
  // Прапорець до першого await — подвійне натискання не надішле двох подарунків.
  d.status = 'sending';
  await ctx.reply(withEmoji('⏳ Надсилаю ' + giftIcon(d.tier) + ' <b>' + NAMES[d.tier] + '</b> → ' + whoTxt(d) + '…'), { parse_mode: 'HTML' }).catch(() => {});
  const r = await usergifts.send(d.target, d.tier, d.text, d.entities);
  if (!r.ok) {
    d.status = 'draft';
    const hint = /BALANCE_TOO_LOW/i.test(r.error) ? 'На балансі акаунта замало зірок.'
      : /USERNAME|PEER|INPUT_USER|entity/i.test(r.error) ? 'Не знайшов отримувача — перевірте @нік (за id — лише якщо акаунт уже бачив цю людину).'
      : /AUTH|SESSION/i.test(r.error) ? 'Сесія недійсна — увійдіть знову: /tg_login' : 'Спробуйте ще раз за хвилину.';
    return ctx.reply(withEmoji(ui.card('warn', 'НЕ ВДАЛОСЯ', ['<code>' + esc(r.error) + '</code>', '', hint], 'Чернетка збережена — можна натиснути ще раз')),
      { parse_mode: 'HTML', ...ui.kb([[ui.cb('СПРОБУВАТИ ЩЕ', 'ug:send', 'primary', 'lightning'), ui.cb('СКАСУВАТИ', 'ug:cancel', 'danger')]]) }).catch(() => {});
  }
  drafts.delete(aid);
  await ctx.reply(withEmoji(ui.card('check', 'ПОДАРУНОК НАДІСЛАНО!', [
    giftIcon(d.tier) + ' <b>' + NAMES[d.tier] + '</b> → <b>' + whoTxt(d) + '</b>',
    '{:starIcon} Списано з акаунта: <b>' + r.stars + '⭐</b>',
    d.text ? '{:eye} Підпис:\n' + captionHtml(d.text, d.entities) : '{:eye} Без підпису',
    d.uid ? '{:lightning} Гравцю надіслано привітання від бота' : null,
    d.announce ? '{:megaphone} Оголошено в чаті' : null,
  ], r.dry ? 'Сухий прогін — насправді нічого не надіслано' : 'Від вашого акаунта, не від бота')), { parse_mode: 'HTML' }).catch(() => {});
  // Привітання отримувачу — лише якщо він є в базі бота.
  if (d.uid) {
    const u = users.get(d.uid) || {};
    const lang = T[u.lang] ? u.lang : 'uk', t = T[lang];
    const fill = (s) => s.replace('{gift}', giftIcon(d.tier)).replace('{name}', nameOf(d.tier, lang));
    notify.dm(d.uid, withEmoji(ui.card('giftBox', t.title, [fill(t.body), d.text ? '\n' + t.caption + '\n' + captionHtml(d.text, d.entities) : null], t.foot)), { parse_mode: 'HTML' });
  }
  if (d.announce) {
    notify.announce(withEmoji(giftIcon(d.tier) + ' <b>' + whoTxt(d) + '</b> отримав справжній подарунок Telegram — <b>' + NAMES[d.tier] + '</b> від власника StarForge {:crown}\nБудь активним — і наступним можеш бути ти 👀'));
  }
  return null;
}

function register(bot, hooks) {
  const isAdm = (ctx) => !!(ctx.from && users.isAdmin(ctx.from.id));

  bot.command('ugift', async (ctx) => {
    if (!isAdm(ctx)) return;
    if (!usergifts.enabled()) {
      return ctx.reply(withEmoji(ui.card('warn', 'ПОДАРУНКИ ВІД АКАУНТА ВИМКНЕНІ', [
        'Задайте змінні оточення:', '• <code>TG_API_ID</code>, <code>TG_API_HASH</code> — з my.telegram.org',
        '• потім <code>/tg_login</code> — QR-код, скануєте телефоном',
      ], 'Сесія = повний доступ до акаунта, нікому не передавайте')), { parse_mode: 'HTML' }).catch(() => {});
    }
    const text = String(ctx.message.text || '');
    const m = text.match(/^\/\S+[ \t]+(\S+)(?:[ \t]+([\s\S]*))?$/);
    if (!m) {
      return ctx.reply(withEmoji(ui.card('giftBox', 'ПОДАРУНОК ВІД ВАШОГО АКАУНТА', [
        '<code>/ugift @нік</code> — {:teddyBear} Мішка, підпис допишете далі',
        '<code>/ugift @нік Текст підпису</code> — одразу з підписом',
        '<code>/ugift @нік heart Текст</code> — інший подарунок:',
        Object.keys(tggifts.CATALOG).map(k => tggifts.CATALOG[k].emoji + ' ' + k).join(' · '),
      ], 'Спершу — прев\'ю, надсилання лише після кнопки')), { parse_mode: 'HTML' }).catch(() => {});
    }
    let rest = m[2] || '', restOff = m[2] ? text.length - m[2].length : text.length;
    let tier = 'bear';
    const w = (rest.match(/^\S+/) || [''])[0];
    if (w && tggifts.CATALOG[w.toLowerCase()]) {
      tier = w.toLowerCase();
      const cut = rest.length - rest.slice(w.length).replace(/^\s+/, '').length;
      rest = rest.slice(cut); restOff += cut;
    }
    const u = users.findByUsernameOrId(m[1]);
    const target = u && u.username ? '@' + u.username : /^\d+$/.test(m[1]) ? m[1] : '@' + m[1].replace(/^@/, '');
    if (rest.length > usergifts.TEXT_MAX) return ctx.reply(`❌ Підпис задовгий: ${rest.length}/${usergifts.TEXT_MAX} символів.`).catch(() => {});
    // Форматування з самої команди (зсуваємо на початок підпису).
    const entities = tggifts.cleanEntities((ctx.message.entities || []).filter(e => e.offset >= restOff))
      .map(e => ({ ...e, offset: e.offset - restOff }));
    const d = { target, uid: u ? String(u.id) : null, username: u ? u.username : (/^\d+$/.test(m[1]) ? null : m[1].replace(/^@/, '')),
      name: u ? u.name : null, tier, text: rest, entities, announce: false, status: 'draft', at: Date.now() };
    drafts.set(String(ctx.from.id), d);
    awaiting.delete(String(ctx.from.id));
    await showPreview(ctx, d);
  });

  const withDraft = (fn) => async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isAdm(ctx)) return;
    const aid = String(ctx.from.id), d = drafts.get(aid);
    if (!d) return ctx.reply('Чернетки немає — почніть з /ugift @нік').catch(() => {});
    return fn(ctx, aid, d);
  };
  bot.action('ug:send', withDraft((ctx, aid) => { awaiting.delete(aid); return doSend(ctx, aid); }));
  bot.action('ug:text', withDraft(async (ctx, aid) => {
    awaiting.add(aid);
    await ctx.reply(withEmoji('{:lightning} Напишіть підпис одним повідомленням — до ' + usergifts.TEXT_MAX + ' символів. Можна <b>жирний</b>, <i>курсив</i>, спойлер і преміум-емодзі.'), { parse_mode: 'HTML' }).catch(() => {});
  }));
  bot.action('ug:clear', withDraft((ctx, aid, d) => { if (d.status === 'sending') return null; d.text = ''; d.entities = []; return showPreview(ctx, d); }));
  bot.action('ug:ann', withDraft((ctx, aid, d) => { if (d.status === 'sending') return null; d.announce = !d.announce; return showPreview(ctx, d); }));
  bot.action('ug:cancel', withDraft(async (ctx, aid, d) => {
    if (d.status === 'sending') return ctx.reply('⏳ Уже надсилається — скасувати не можна.').catch(() => {});
    drafts.delete(aid); awaiting.delete(aid);
    await ctx.reply('🚫 Скасовано. Подарунок не надіслано.').catch(() => {});
  }));

  hooks.onAdminText.push(async (ctx, text) => {
    const aid = String(ctx.from.id);
    if (!awaiting.has(aid)) return false;
    const d = drafts.get(aid);
    if (!d || d.status === 'sending') { awaiting.delete(aid); return false; }
    if (!text.trim()) return true;
    if (text.length > usergifts.TEXT_MAX) { await ctx.reply(`❌ Задовго: ${text.length}/${usergifts.TEXT_MAX}. Коротше, будь ласка.`).catch(() => {}); return true; }
    awaiting.delete(aid);
    d.text = text; d.entities = tggifts.cleanEntities(ctx.message.entities);
    await showPreview(ctx, d);
    return true;
  });
  hooks.onCommand.push((uid) => awaiting.delete(uid));
}

module.exports = { register, captionHtml };
