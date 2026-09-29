// Профіль гравця для застосунку: статистика, історія, заявки, налаштування.
const E = require('../economy');
const users = require('../core/users');
const progress = require('../core/progress');
const applications = require('./applications');
const referrals = require('./referrals');
const { round2 } = require('../lib/util');

function historyItem(h, lang) {
  const kind = h.id === 'risk_win' || h.id === 'risk_lose' ? 'risk' : h.sp ? 'prize' : (h.tk || String(h.id).startsWith('tix')) ? 'tickets' : 'stars';
  let title;
  if (h.id === 'risk_win') title = '×' + (h.mult || 2) + ' +' + h.am + '⭐';
  else if (h.id === 'risk_lose') title = '−' + h.am + '⭐';
  else if (kind === 'prize') title = E.getTier(h.id).emoji + ' ' + E.tierName(h.id, lang);
  else if (kind === 'tickets') title = '+' + (h.tk || parseInt(String(h.id).slice(3), 10) || 0) + ' 🎫';
  else title = '+' + (h.am || 0) + '⭐';
  return { kind, title, wheel: h.w, at: h.at, won: h.id !== 'risk_lose', img: kind === 'prize' ? E.getTier(h.id).img : null, nonce: h.n };
}

function view(u, lang) {
  const best = u.bestWin || null;
  return {
    id: u.id, name: u.name || '', username: u.username || null, photo: u.photo || null,
    lang: u.lang || 'uk', since: u.firstSeenAt || u.joinedAt || null,
    settings: { anonymous: !!u.anonymous, notifyOnReferral: u.notifyOnReferral !== false, reminders: !u.remindersOff },
    stats: {
      spins: u.spinsTotal || 0, paidSpins: u.paidSpinsTotal || 0, prizes: u.prizesWonTotal || 0,
      earned: round2(u.starsEarnedTotal || 0), spent: round2(u.starsSpentTotal || 0), ticketsWon: u.ticketsWonTotal || 0,
      games: u.diceGames || 0, wagered: round2(u.diceWagered || 0),
      streak: u.dailyStreak || 0, bestStreak: u.bestStreak || 0, friends: (u.invitedIds || []).length,
      bestWin: best && best.outcomeId ? (String(best.outcomeId).startsWith('star') ? best.value + '⭐' : E.tierName(best.outcomeId, lang)) : null,
    },
    level: progress.view(u, lang).level,
    history: (u.spinHistory || []).slice().reverse().slice(0, 30).map(h => historyItem(h, lang)),
    applications: applications.listFor(u.id).slice(0, 30).map(a => applications.publicView(a, lang)),
    refLink: referrals.link(u.id),
  };
}

function updateSettings(uid, body) {
  const patch = {};
  if (body.lang && ['uk', 'en', 'ru'].includes(body.lang)) patch.lang = body.lang;
  if (typeof body.anonymous === 'boolean') patch.anonymous = body.anonymous;
  if (typeof body.notifyOnReferral === 'boolean') patch.notifyOnReferral = body.notifyOnReferral;
  if (typeof body.reminders === 'boolean') patch.remindersOff = !body.reminders;
  if (Object.keys(patch).length) users.patch(uid, patch);
  return view(users.get(uid), patch.lang || (users.get(uid) || {}).lang);
}

module.exports = { view, historyItem, updateSettings };
