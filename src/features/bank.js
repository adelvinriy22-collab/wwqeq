// ==========================================================================
// СПІЛЬНИЙ БАНК ПРИБРАНО.
// Лишилось одне: якщо на момент оновлення був відкритий банк зі ставками —
// повернути кожному його ставку (зірки й білети окремо) і повідомити людей,
// щойно бот запуститься. Повернення позначається в базі й не повторюється.
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const notify = require('../core/notify');
const i18n = require('../i18n');
const { round2 } = require('../lib/util');

function closeLegacy() {
  const f = store.getFeatureFlags() || {};
  const b = f.bank;
  const patch = {};
  if (f.bankAuto && f.bankAuto.enabled) patch.bankAuto = { ...f.bankAuto, enabled: false };
  if (!b || b.status !== 'open') {
    if (Object.keys(patch).length) store.setFeatureFlags(patch);
    return null;
  }
  const notices = [];
  let stars = 0, tickets = 0;
  for (const uid of b.order || []) {
    const s = b.betStars ? (b.betStars[uid] || 0) : ((b.bets || {})[uid] || 0);
    const t = b.betTickets ? (b.betTickets[uid] || 0) : 0;
    if (!users.get(uid) || (!s && !t)) continue;
    users.move(uid, { stars: s, tickets: t }, 'bank_refund', { bank: b.id, why: 'bank_removed' });
    stars += s; tickets += t;
    notices.push({ uid, what: (s ? s + '⭐' : '') + (s && t ? ' + ' : '') + (t ? t + '🎫' : '') });
  }
  store.setFeatureFlags({
    ...patch,
    bank: { ...b, status: 'cancelled', cancelledAt: Date.now(), reason: 'bank_removed' },
    bankRefundNotices: (f.bankRefundNotices || []).concat(notices),
  });
  const r = { players: notices.length, stars: round2(stars), tickets };
  console.log(`🏦 Банк прибрано: повернуто ${r.stars}⭐ і ${r.tickets}🎫 для ${r.players} гравців`);
  return r;
}

// Повідомлення про повернення — коли бот уже на зв'язку.
async function deliverNotices() {
  const list = (store.getFeatureFlags() || {}).bankRefundNotices || [];
  if (!list.length || !notify.tg.telegram) return 0;
  store.setFeatureFlags({ bankRefundNotices: [] });
  for (const n of list) {
    const u = users.get(n.uid);
    if (u) await notify.dm(n.uid, i18n.t(u.lang || 'uk', 'bank.refund', { what: n.what }));
    await new Promise(r => setTimeout(r, 60));
  }
  return list.length;
}

module.exports = { closeLegacy, deliverNotices };
