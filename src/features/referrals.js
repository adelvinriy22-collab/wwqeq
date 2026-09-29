// ==========================================================================
// ДРУЗІ. Друг зараховується лише тоді, коли він:
//   • новий у боті (не проходив старт раніше) — давні гравці не можуть
//     «стати рефералом» чужого посилання;
//   • підписався на канал (фейки, що тиснуть /start і йдуть, не рахуються).
// За кожного друга: +1🎫 і +150 XP. Сходи призів — справжні подарунки за
// 5, 10, 20… друзів.
// ==========================================================================
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const i18n = require('../i18n');
const applications = require('./applications');

const hooks = { onReferral: [] };

function link(uid) {
  const b = notify.tg.botUsername;
  return b ? `https://t.me/${b}?start=ref_${uid}` : null;
}

// Викликається на /start ref_<id>. Лише для тих, хто ще не проходив старт.
function setPending(uid, refId) {
  const id = String(refId || '').replace(/\D/g, '');
  const u = users.get(uid);
  if (!id || !u || id === String(uid)) return false;
  if (u.referredBy || u.pendingRef || u.lang) return false;
  if (!users.get(id)) return false;
  users.patch(uid, { pendingRef: id });
  return true;
}

function attributeIfPending(uid) {
  const u = users.get(uid);
  if (u && u.pendingRef && !u.referredBy) {
    const ref = u.pendingRef;
    users.patch(uid, { pendingRef: null });
    attribute(uid, ref);
  }
}

function attribute(uid, inviterId) {
  uid = String(uid); inviterId = String(inviterId);
  if (!inviterId || inviterId === uid) return false;
  const u = users.get(uid);
  const inv = users.get(inviterId);
  if (!u || !inv || u.referredBy) return false;
  users.patch(uid, { referredBy: inviterId, referredAt: Date.now() });
  const ids = (inv.invitedIds || []).slice();
  if (ids.includes(uid)) return false;
  ids.push(uid);
  users.patch(inviterId, { invitedIds: ids });
  users.move(inviterId, { tickets: E.TICKETS.perFriend }, 'referral', { friend: uid });
  progress.addXp(inviterId, 'friend', E.XP.friend.per);
  for (const h of hooks.onReferral) { try { h(inviterId, uid); } catch (e) { console.error('onReferral hook:', e.message); } }
  const fresh = users.get(inviterId);
  if (fresh.notifyOnReferral !== false) {
    notify.dm(inviterId, i18n.t(fresh.lang, 'ref.new', { name: users.displayName(u), tickets: E.TICKETS.perFriend, total: ids.length }),
      notify.appKeyboard(i18n.t(fresh.lang, 'btn.open'), 'friends'));
  }
  return true;
}

function ladder(u, lang) {
  const count = (u.invitedIds || []).length;
  const mine = store.listApplications().filter(a => a.uid === String(u.id) && store.isLadderApp(a));
  let nextShown = false;
  const steps = E.TIERS.filter(t => t.ladder).sort((a, b) => a.ladder - b.ladder).map(t => {
    const find = (st) => mine.find(a => a.tierId === t.id && a.status === st);
    let state;
    if (find('approved')) state = 'approved';
    else if (find('pending')) state = 'pending';
    else if (find('rejected')) state = 'rejected';
    else if (count >= t.ladder) state = 'claimable';
    else state = 'locked';
    const next = state === 'locked' && !nextShown; if (next) nextShown = true;
    return { id: t.id, name: E.tierName(t.id, lang), emoji: t.emoji, img: t.img, need: t.ladder, value: t.price, state, next, left: Math.max(0, t.ladder - count) };
  });
  return { count, link: link(u.id), steps };
}

async function claimLadder(uid, tierId) {
  const t = E.TIERS.find(x => x.id === tierId && x.ladder);
  if (!t) return { ok: false, status: 400, error: 'unknown_tier' };
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    if ((u.invitedIds || []).length < t.ladder) return { ok: false, status: 403, error: 'not_enough_friends', need: t.ladder };
    if (store.hasApplicationFor(uid, tierId)) return { ok: false, status: 409, error: 'already' };
    if (!u.username) return { ok: false, status: 400, error: 'need_username' };
    const a = applications.create(uid, tierId, 'ladder', {}, {
      adminText: `📥 <b>Заявка #${store.raw().nextApplicationId}</b> · ${t.emoji} ${t.name.uk} (${t.ladder} друзів)\n` +
        `${u.name || '—'} ${u.username ? '@' + u.username : ''} · id <code>${uid}</code> · друзів: ${(u.invitedIds || []).length}`,
    });
    return { ok: true, applicationId: a.id };
  });
}

function friendsList(u) {
  return (u.invitedIds || []).slice(-50).reverse().map(id => {
    const f = users.get(id);
    return { name: f ? users.displayName(f) : 'гравець', joinedAt: f ? (f.referredAt || f.joinedAt || null) : null, active: !!(f && f.lastActiveAt && Date.now() - f.lastActiveAt < 3 * 86400000) };
  });
}

module.exports = { hooks, link, setPending, attributeIfPending, attribute, ladder, claimLadder, friendsList };
