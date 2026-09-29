// Жива стрічка: що виграють інші просто зараз. Призи з усіх джерел плюс
// помітні виграші на колесі (дрібні зірки не показуємо).
const store = require('../store');
const users = require('../core/users');
const E = require('../economy');
const applications = require('./applications');

const SHOW_SOURCES = new Set(['shop', 'ladder', 'season_pass', 'goal', 'giveaway', 'event', 'password_challenge',
  'external_ref', 'temu', 'league', 'league_launch', 'chat_contest', 'chat_jackpot', 'wheel_daily', 'wheel_referral', 'wheel_paid']);

function feed(uid, lang) {
  const out = [];
  const perUser = {};
  const apps = store.listApplications().filter(a => a.tierId && a.tierId !== 'stars_payout' && SHOW_SOURCES.has(a.source) && a.status !== 'rejected' && a.status !== 'cancelled')
    .slice(-80).sort((x, y) => y.createdAt - x.createdAt);
  for (const a of apps) {
    if (out.length >= 8) break;
    perUser[a.uid] = (perUser[a.uid] || 0) + 1;
    if (perUser[a.uid] > 2) continue;
    const u = users.get(a.uid);
    const t = E.getTier(a.tierId);
    out.push({ kind: 'prize', name: users.displayName(u), what: t.emoji + ' ' + E.tierName(a.tierId, lang), img: t.img,
               how: applications.sourceLabel(a.source, lang), at: a.createdAt, me: String(a.uid) === String(uid) });
  }
  const log = (store.getWheelLog() || []).slice(-200).reverse();
  for (const e of log) {
    if (out.length >= 16) break;
    const o = e && e.extra && e.extra.outcomeId;
    if (!o || E.PRIZE_IDS.includes(o)) continue;   // призи вже є з заявок
    const isTix = String(o).startsWith('tix');
    const amt = parseInt(String(o).replace(/^star|^tix/, ''), 10) || 0;
    if (!isTix && amt < 5) continue;
    if (isTix && amt < 3) continue;
    perUser[e.uid] = (perUser[e.uid] || 0) + 1;
    if (perUser[e.uid] > 2) continue;
    out.push({ kind: isTix ? 'tix' : 'star', name: users.displayName(users.get(e.uid) || { id: e.uid, name: e.name, username: e.username }),
               what: isTix ? '+' + amt + ' 🎫' : '+' + amt + '⭐', at: e.ts, me: String(e.uid) === String(uid) });
  }
  return out.sort((a, b) => b.at - a.at);
}

module.exports = { feed };
