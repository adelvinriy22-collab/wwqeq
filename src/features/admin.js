// ==========================================================================
// АДМІН-ПАНЕЛЬ (у застосунку): зведення, черга заявок, пошук гравця,
// коригування балансу з причиною, промокоди, техроботи, ліга.
// Усі дії адміна з балансом теж ідуть у журнал транзакцій.
// ==========================================================================
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const applications = require('./applications');
const maintenance = require('./maintenance');
const league = require('./league');
const promo = require('./promo');
const time = require('../lib/time');
const { round2 } = require('../lib/util');

function overview() {
  const all = Object.values(users.all());
  const now = Date.now();
  const today = time.dayKey(now);
  let active24 = 0, active7 = 0, newToday = 0, stars = 0, tickets = 0, registered = 0, deposits = 0;
  for (const u of all) {
    if (!u) continue;
    if (u.lang) registered++;
    if (u.lastActiveAt && now - u.lastActiveAt < 86400000) active24++;
    if (u.lastActiveAt && now - u.lastActiveAt < 7 * 86400000) active7++;
    if (u.joinedAt && time.dayKey(u.joinedAt) === today) newToday++;
    stars += u.starBalance || 0;
    tickets += u.tickets || 0;
    deposits += u.depositedTotal || 0;
  }
  const pending = store.listApplications('pending');
  const f = store.getFeatureFlags() || {};
  return {
    users: all.length, registered, active24, active7, newToday,
    balances: { stars: round2(stars), tickets }, deposited: round2(deposits),
    pending: pending.length, pendingPayout: pending.reduce((s, a) => s + (a.payoutStars || 0), 0),
    pendingBySource: pending.reduce((m, a) => { m[a.source || 'ladder'] = (m[a.source || 'ladder'] || 0) + 1; return m; }, {}),
    maintenance: maintenance.state(),
    league: league.enabled(),
    spinNotify: !f.spinNotifyOff,
  };
}

function appItem(a) {
  const u = users.get(a.uid) || {};
  return { ...applications.publicView(a, 'uk'), uid: a.uid, user: { name: u.name || '—', username: u.username || null, friends: (u.invitedIds || []).length, lastActiveAt: u.lastActiveAt || 0 },
           payout: a.payoutStars || 0, sourceId: a.source || 'ladder' };
}
function appsList(status, limit) {
  const list = store.listApplications(status || 'pending').slice().sort((a, b) => (status === 'pending' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  return list.slice(0, Math.min(200, limit || 100)).map(appItem);
}

function userInfo(q) {
  const u = users.findByUsernameOrId(q);
  if (!u) return null;
  const pv = progress.view(u, 'uk');
  return {
    id: u.id, name: u.name, username: u.username, lang: u.lang, joinedAt: u.joinedAt, lastActiveAt: u.lastActiveAt,
    stars: users.stars(u), tickets: users.tickets(u), level: pv.level, xp: pv.total,
    friends: (u.invitedIds || []).length, referredBy: u.referredBy || null,
    spins: u.spinsTotal || 0, deposits: u.depositCount || 0, deposited: u.depositedTotal || 0,
    freeSpins: u.freeSpins || 0, gifted: u.paidSpinsGifted || 0, remindersOff: !!u.remindersOff,
    tx: (u.tx || []).slice(-25).reverse(),
    apps: applications.listFor(u.id).slice(0, 15).map(a => applications.publicView(a, 'uk')),
  };
}

function adjust(uid, stars, tickets, note) {
  const s = round2(Number(stars) || 0), t = Math.trunc(Number(tickets) || 0);
  if (!s && !t) return { ok: false, error: 'nothing' };
  if (!users.get(uid)) return { ok: false, error: 'no_user' };
  const r = users.move(uid, { stars: s, tickets: t }, 'admin', { note: String(note || '').slice(0, 120) });
  return r.ok ? { ok: true, stars: r.stars, tickets: r.tickets } : r;
}

function giveSpins(uid, free, gifted) {
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  users.patch(uid, { freeSpins: Math.max(0, (u.freeSpins || 0) + (parseInt(free, 10) || 0)), paidSpinsGifted: Math.max(0, (u.paidSpinsGifted || 0) + (parseInt(gifted, 10) || 0)) });
  return { ok: true };
}

function setSpinNotify(on) { store.setFeatureFlags({ spinNotifyOff: !on }); return !!on; }

module.exports = { overview, appsList, userInfo, adjust, giveSpins, setSpinNotify, promo, maintenance, league, E };
