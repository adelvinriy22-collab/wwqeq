// ==========================================================================
// ДОСВІД (XP) — одна шкала за будь-яку активність.
//
// Кожне нарахування одночасно рухає три речі:
//   total  → рівень гравця з титулом (назавжди)
//   season → сезонний пас (обнуляється кожні 30 днів)
//   week   → ліга тижня (обнуляється щопонеділка 00:00 за Києвом)
//
// Раніше було три окремі лічильники (очки чату, XP пасу, XP ліги), і людина
// не розуміла, за що що дають. Тепер: «+10 XP» — і видно, куди воно пішло.
// ==========================================================================
const E = require('../economy');
const time = require('../lib/time');
const users = require('./users');

const hooks = { onLevelUp: [] };

function seasonIndex(now) { return Math.floor(((now || Date.now()) - E.PASS.epoch) / (E.PASS.seasonDays * time.DAY_MS)); }
function seasonId(now) { return 'S' + (seasonIndex(now) + 1); }
function seasonEndsAt(now) { return E.PASS.epoch + (seasonIndex(now) + 1) * E.PASS.seasonDays * time.DAY_MS; }

// Привести запис досвіду до поточних сезону/тижня/дня. Мутує x і повертає його.
function roll(x, now) {
  const t = now || Date.now();
  const sid = seasonId(t), wid = time.weekKey(t), did = time.dayKey(t);
  if (!x.season || x.season.id !== sid) {
    if (x.season && x.season.xp > 0) x.prevSeason = x.season;
    x.season = { id: sid, xp: 0 };
  }
  if (!x.week || x.week.id !== wid) {
    // Минулий тиждень лишаємо: підсумки ліги можуть підбиватись трохи пізніше.
    if (x.week && x.week.xp > 0) x.prevWeek = x.week;
    x.week = { id: wid, xp: 0, lastAt: 0 };
  }
  if (!x.day || x.day.id !== did) x.day = { id: did, src: {} };
  return x;
}

function xpOf(u, now) {
  const x = (u && u.xp && typeof u.xp === 'object') ? { ...u.xp } : { total: 0 };
  x.total = Math.max(0, Number(x.total) || 0);
  return roll(x, now);
}

function levelIndex(total) {
  let i = 0;
  while (i + 1 < E.LEVELS.length && total >= E.LEVELS[i + 1].at) i++;
  return i;
}

function levelInfo(total, lang) {
  const tot = Math.max(0, Math.floor(total || 0));
  const i = levelIndex(tot);
  const L = E.LEVELS[i], nx = E.LEVELS[i + 1];
  const lg = lang || 'uk';
  return {
    index: i, n: i + 1, e: L.e, t: L.t[lg] || L.t.uk, xp: tot, at: L.at, max: E.LEVELS.length,
    perks: E.levelPerks(i + 1),
    next: nx ? { n: i + 2, e: nx.e, t: nx.t[lg] || nx.t.uk, at: nx.at, left: nx.at - tot, reward: E.levelReward(i + 1), unlocks: E.perksUnlockedAt(i + 2) } : null,
    pct: nx ? Math.max(0, Math.min(100, Math.round((tot - L.at) / (nx.at - L.at) * 100))) : 100,
  };
}

// Нарахувати XP. Повертає скільки реально нараховано (після денних стель).
// opts.silent — без сповіщень про новий рівень; opts.msgId — для реакції в чаті.
function addXp(uid, src, amount, opts) {
  const u = users.get(uid);
  if (!u) return 0;
  let gain = Math.max(0, Math.round((Number(amount) || 0) * 100) / 100);
  if (!gain) return 0;
  const now = Date.now();
  const x = xpOf(u, now);
  const cap = E.XP[src] && E.XP[src].dayCap;
  if (cap != null) {
    const used = x.day.src[src] || 0;
    gain = Math.min(gain, Math.max(0, cap - used));
    if (gain <= 0) return 0;
  }
  const before = levelIndex(x.total);
  x.total = Math.round((x.total + gain) * 100) / 100;
  x.season = { ...x.season, xp: Math.round((x.season.xp + gain) * 100) / 100 };
  x.week = { ...x.week, xp: Math.round((x.week.xp + gain) * 100) / 100, lastAt: now };
  x.day = { ...x.day, src: { ...x.day.src, [src]: (x.day.src[src] || 0) + gain } };
  users.patch(uid, { xp: x });
  const after = levelIndex(x.total);
  if (after > before) {
    // Нагорода — за КОЖЕН пройдений рівень, а сповіщення одне: про останній,
    // із сумою всіх нагород (інакше стрибок на кілька рівнів — це кілька повідомлень).
    const total = { tickets: 0, stars: 0 };
    for (let i = before + 1; i <= after; i++) {
      const rw = E.levelReward(i);
      if (rw.tickets || rw.stars) users.move(uid, { tickets: rw.tickets || 0, stars: rw.stars || 0 }, 'level', { level: i + 1 });
      total.tickets += rw.tickets || 0;
      total.stars += rw.stars || 0;
    }
    const info = levelInfo(x.total, u.lang);
    // from — НОМЕР першого нового рівня (before — індекс старого, з нуля).
    const o = { ...(opts || {}), from: before + 2, levels: after - before };
    for (const h of hooks.onLevelUp) {
      try { h(uid, info, total, o); } catch (e) { console.error('onLevelUp hook:', e.message); }
    }
  }
  return gain;
}

// Стан для застосунку.
function view(u, lang) {
  const x = xpOf(u);
  return {
    total: x.total,
    level: levelInfo(x.total, lang),
    season: { id: x.season.id, xp: x.season.xp, endsAt: seasonEndsAt() },
    week: { id: x.week.id, xp: x.week.xp, endsAt: time.weekEnd(Date.now()) },
    today: x.day.src,
  };
}

function weekXp(u, wk) {
  const x = u && u.xp;
  if (!x) return 0;
  if (x.week && x.week.id === wk) return x.week.xp || 0;
  if (x.prevWeek && x.prevWeek.id === wk) return x.prevWeek.xp || 0;
  return 0;
}
function seasonXp(u, now) {
  const x = u && u.xp;
  const sid = seasonId(now);
  return x && x.season && x.season.id === sid ? (x.season.xp || 0) : 0;
}

// Привілеї гравця за його рівнем (комісія виводу, бонус до поповнень, бонус у чаті).
function perksOf(u) { return E.levelPerks(levelIndex(xpOf(u).total) + 1); }

// Усі сходинки: пороги, нагороди, що відкривається, досягнуто чи ні.
function ladder(u, lang) {
  const tot = xpOf(u).total;
  const lg = lang || 'uk';
  return E.LEVELS.map((L, i) => ({
    n: i + 1, e: L.e, t: L.t[lg] || L.t.uk, at: L.at, reached: tot >= L.at,
    reward: E.levelReward(i), unlocks: E.perksUnlockedAt(i + 1),
  }));
}

module.exports = {
  hooks, addXp, view, levelInfo, levelIndex, xpOf, perksOf, ladder,
  seasonId, seasonEndsAt, weekXp, seasonXp,
};
