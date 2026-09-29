// ==========================================================================
// ЛІГА ТИЖНЯ: рейтинг за XP, набраним із понеділка 00:00 за Києвом.
// Щопонеділка топ отримує призи. Вмикається й вимикається адміном
// (призи коштують реальних подарунків, тому за замовчуванням вимкнено).
// ==========================================================================
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const applications = require('./applications');
const time = require('../lib/time');
const i18n = require('../i18n');

function flags() { return store.getFeatureFlags() || {}; }
function enabled() { const f = flags(); return !!f.leagueOn && !f.leaguePaused; }
function hidden() { return (flags().leagueHidden || []).map(String); }
function excluded(uid) { return users.isAdmin(uid) || hidden().includes(String(uid)); }

function standings(wk) {
  const week = wk || time.weekKey(Date.now());
  const rows = [];
  for (const [uid, u] of Object.entries(users.all())) {
    if (!u || excluded(uid)) continue;
    const xp = progress.weekXp(u, week);
    if (xp > 0) rows.push({ uid, xp, lastAt: (u.xp && u.xp.week && u.xp.week.lastAt) || 0, u });
  }
  rows.sort((a, b) => (b.xp - a.xp) || (a.lastAt - b.lastAt));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function rewardText(items, lang) {
  if (!items) return '';
  return items.map(it => it.type === 'tier' ? E.getTier(it.id).emoji + ' ' + E.tierName(it.id, lang)
    : it.type === 'stars' ? it.n + '⭐' : it.n + '🎫').join(' + ');
}

function view(uid, lang) {
  const now = Date.now();
  const rows = standings();
  const me = rows.find(r => String(r.uid) === String(uid));
  const myXp = me ? me.xp : progress.weekXp(users.get(uid), time.weekKey(now));
  let gap = null;
  if (me && me.rank > 1) gap = Math.ceil((rows[me.rank - 2].xp - me.xp + 0.01) * 100) / 100;
  return {
    enabled: enabled(), week: time.weekKey(now), endsAt: time.weekEnd(now), players: rows.length,
    minXp: E.LEAGUE.minXpForPrize, participationXp: E.LEAGUE.participationXp, participationTickets: E.LEAGUE.participationTickets,
    top: rows.slice(0, 20).map(r => {
      const items = E.leagueRewardFor(r.rank);
      return { rank: r.rank, name: users.displayName(r.u), xp: r.xp, me: String(r.uid) === String(uid),
               prize: items && r.xp >= E.LEAGUE.minXpForPrize ? rewardText(items, lang) : null,
               locked: !!(items && r.xp < E.LEAGUE.minXpForPrize), photo: '/api/avatar/' + r.uid };
    }),
    me: { rank: me ? me.rank : null, xp: myXp, gap, excluded: excluded(uid) },
    rewards: E.LEAGUE.rewards.map(q => ({ place: q.from === q.to ? String(q.from) : q.from + '–' + q.to, text: rewardText(q.items, lang) })),
  };
}

// Підсумки тижня. Позначка в прапорцях не дасть видати двічі.
async function finalize(wk) {
  const f = flags();
  const done = f.leagueDone || {};
  if (done[wk]) return { ok: false, error: 'already' };
  done[wk] = Date.now();
  store.setFeatureFlags({ leagueDone: done });
  const rows = standings(wk);
  const winners = [];
  for (const r of rows) {
    const items = r.xp >= E.LEAGUE.minXpForPrize ? E.leagueRewardFor(r.rank) : null;
    const got = [];
    if (items) {
      for (const it of items) {
        if (it.type === 'tier') got.push(E.tierName(it.id, r.u.lang) + ' (#' + applications.create(r.uid, it.id, 'league', {}, { silent: true }).id + ')');
        else if (it.type === 'stars') { users.move(r.uid, { stars: it.n }, 'league', { week: wk }); got.push(it.n + '⭐'); }
        else if (it.type === 'tickets') { users.move(r.uid, { tickets: it.n }, 'league', { week: wk }); got.push(it.n + '🎫'); }
      }
      winners.push('#' + r.rank + ' ' + users.displayName(r.u) + ' — ' + r.xp + ' XP → ' + rewardText(items, 'uk'));
    } else if (r.xp >= E.LEAGUE.participationXp) {
      users.move(r.uid, { tickets: E.LEAGUE.participationTickets }, 'league', { week: wk });
      got.push(E.LEAGUE.participationTickets + '🎫');
    }
    if (got.length) {
      await notify.dm(r.uid, i18n.t(r.u.lang, 'league.result', { rank: r.rank, xp: r.xp, prize: got.join(' + ') }));
      await new Promise(x => setTimeout(x, 60));
    }
  }
  notify.admin('🏆 Ліга ' + wk + ' завершена · учасників: ' + rows.length + '\n\n' + (winners.join('\n') || 'Ніхто не набрав мінімум.'));
  return { ok: true, players: rows.length, winners: winners.length };
}

// Раз на хвилину: чи не почався новий тиждень.
function tick() {
  const cur = time.weekKey(Date.now());
  const f = flags();
  if (!f.leagueWeek) { store.setFeatureFlags({ leagueWeek: cur }); return; }
  if (f.leagueWeek === cur) return;
  const prev = f.leagueWeek;
  store.setFeatureFlags({ leagueWeek: cur });
  if (enabled()) finalize(prev).catch(e => console.error('league finalize:', e.message));
}

function setEnabled(on) { store.setFeatureFlags({ leagueOn: !!on, leaguePaused: false, leagueWeek: time.weekKey(Date.now()) }); }
function hide(uid, yes) {
  const set = new Set(hidden());
  if (yes) set.add(String(uid)); else set.delete(String(uid));
  store.setFeatureFlags({ leagueHidden: [...set] });
}

module.exports = { enabled, standings, view, finalize, tick, setEnabled, hide, excluded, rewardText };
