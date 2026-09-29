// ==========================================================================
// ЗАЯВКИ — усе, що видає адмін вручну: подарунки, вивід зірок, покупки.
//
// Правило грошей: якщо за заявку людина ПЛАТИЛА (вивід, магазин), то при
// відхиленні чи скасуванні зірки повертаються автоматично. Виграші
// (колесо, розіграші, сходи) нічого не коштували — там повертати нічого.
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const notify = require('../core/notify');
const E = require('../economy');
const i18n = require('../i18n');
const { fmtStars, esc } = require('../lib/util');

// Звідки заявка — для людини й для адміна.
const SOURCE = {
  ladder: { uk: 'за друзів', en: 'for friends', ru: 'за друзей' },
  shop: { uk: 'магазин', en: 'shop', ru: 'магазин' },
  app_withdrawal: { uk: 'вивід зірок', en: 'star withdrawal', ru: 'вывод звёзд' },
  wheel_daily: { uk: 'щоденне колесо', en: 'daily wheel', ru: 'ежедневное колесо' },
  wheel_referral: { uk: 'колесо білетів', en: 'ticket wheel', ru: 'колесо билетов' },
  wheel_paid: { uk: 'колесо за зірки', en: 'stars wheel', ru: 'колесо за звёзды' },
  wheel_premium: { uk: 'преміум-колесо', en: 'premium wheel', ru: 'премиум-колесо' },
  season_pass: { uk: 'сезонний пас', en: 'season pass', ru: 'сезонный пропуск' },
  league: { uk: 'ліга тижня', en: 'weekly league', ru: 'лига недели' },
  league_launch: { uk: 'старт ліги', en: 'league launch', ru: 'старт лиги' },
  giveaway: { uk: 'розіграш', en: 'giveaway', ru: 'розыгрыш' },
  event: { uk: 'подія', en: 'event', ru: 'событие' },
  goal: { uk: 'спільна ціль', en: 'community goal', ru: 'общая цель' },
  password_challenge: { uk: 'челендж', en: 'challenge', ru: 'челлендж' },
  external_ref: { uk: 'партнерське завдання', en: 'partner task', ru: 'партнёрское задание' },
  chat_contest: { uk: 'змагання чату', en: 'chat contest', ru: 'соревнование чата' },
  chat_jackpot: { uk: 'джекпот у чаті', en: 'chat jackpot', ru: 'джекпот в чате' },
  temu: { uk: 'завдання Temu', en: 'Temu task', ru: 'задание Temu' },
};
function sourceLabel(src, lang) { const s = SOURCE[src]; return s ? (s[lang] || s.uk) : (src || '—'); }

function refundable(a) {
  if (!a || a.refunded) return 0;
  if (a.spentStars) return a.spentStars;
  if (a.source === 'shop') return E.shopPrice(E.getTier(a.tierId));   // старі покупки без spentStars
  return 0;
}
function refund(a, why) {
  const back = refundable(a);
  if (!back) return 0;
  const r = users.move(a.uid, { stars: back }, why || 'refund', { app: a.id });
  if (!r.ok) return 0;
  a.refunded = back;
  return back;
}

function label(a, lang) {
  if (a.tierId === 'stars_payout') return (a.payoutStars || 0) + '⭐';
  const t = E.getTier(a.tierId);
  return t.emoji + ' ' + (t.name[lang] || t.name.uk);
}

function adminKeyboard(id) {
  return { reply_markup: { inline_keyboard: [[
    { text: '✅ Підтвердити', callback_data: `admin_approve_${id}`, style: 'success' },
    { text: '❌ Відхилити', callback_data: `admin_reject_${id}`, style: 'danger' },
  ]] } };
}

// Нова заявка. opts.silent — без сповіщення адміну; opts.adminText — власний текст.
function create(uid, tierId, source, extra, opts) {
  const a = store.addApplication({ uid: String(uid), tierId, status: 'pending', createdAt: Date.now(), source, ...(extra || {}) });
  if (!(opts && opts.silent)) {
    const u = users.get(uid) || {};
    const who = `${esc(u.name || '—')} ${u.username ? '@' + u.username : ''} · id <code>${uid}</code>`;
    const head = tierId === 'stars_payout'
      ? `💸 <b>Вивід зірок</b> #${a.id}\nНАДІСЛАТИ: <b>${a.payoutStars}⭐</b>\nСписано: ${a.spentStars}⭐ (комісія ${a.fee || 0}⭐)`
      : `📥 <b>Заявка #${a.id}</b> · ${esc(label(a, 'uk'))}\nДжерело: ${sourceLabel(source, 'uk')}` + (a.spentStars ? `\nОплачено: ${a.spentStars}⭐` : '');
    notify.admin((opts && opts.adminText) || head + '\n' + who, adminKeyboard(a.id));
  }
  return a;
}

function approve(id) {
  const a = store.getApplication(id);
  if (!a) return { ok: false, error: 'not_found' };
  if (a.status !== 'pending') return { ok: false, error: 'not_pending', status: a.status };
  a.status = 'approved';
  a.decidedAt = Date.now();
  store.save();
  const u = users.get(a.uid) || {};
  const lg = u.lang || 'uk';
  notify.dm(a.uid, i18n.t(lg, 'app.approved', { id: a.id, what: esc(label(a, lg)) }), notify.appKeyboard(i18n.t(lg, 'btn.open'), 'profile'));
  return { ok: true, app: a };
}

// Відхилення. opts.noRefund — покарання за зловживання (зірки не повертаються).
function reject(id, reason, opts) {
  const a = store.getApplication(id);
  if (!a) return { ok: false, error: 'not_found' };
  if (a.status !== 'pending') return { ok: false, error: 'not_pending', status: a.status };
  a.status = 'rejected';
  a.decidedAt = Date.now();
  if (reason) a.reason = reason;
  const back = opts && opts.noRefund ? 0 : refund(a, 'refund');
  store.save();
  if (!(opts && opts.silent)) {
    const u = users.get(a.uid) || {};
    const lg = u.lang || 'uk';
    notify.dm(a.uid,
      i18n.t(lg, 'app.rejected', { id: a.id, what: esc(label(a, lg)) }) +
      (reason ? '\n\n' + i18n.t(lg, 'app.reason', { reason: esc(reason) }) : '') +
      (back ? '\n\n' + i18n.t(lg, 'app.refunded', { stars: fmtStars(back) }) : ''));
  }
  return { ok: true, app: a, refunded: back };
}

function cancel(id, reason) {
  const a = store.getApplication(id);
  if (!a || a.status !== 'pending') return { ok: false };
  a.status = 'cancelled';
  a.cancelledAt = Date.now();
  a.cancelReason = reason || null;
  const back = refund(a, 'refund');
  store.save();
  return { ok: true, app: a, refunded: back };
}

function listFor(uid) {
  return store.listApplications().filter(a => a.uid === String(uid)).sort((x, y) => y.createdAt - x.createdAt);
}

function publicView(a, lang) {
  return {
    id: a.id, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt || a.cancelledAt || null,
    title: label(a, lang), tierId: a.tierId, img: a.tierId !== 'stars_payout' ? E.getTier(a.tierId).img : null,
    source: sourceLabel(a.source, lang), reason: a.reason || a.cancelReason || null,
    paid: a.spentStars || 0, refunded: a.refunded || 0,
  };
}

module.exports = { create, approve, reject, cancel, refund, refundable, listFor, publicView, label, sourceLabel, adminKeyboard };
