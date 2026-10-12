// ==========================================================================
// ПОКАРАННЯ ЗА АБУЗ БОТА (адмін: /abuse @нік причина, відміна — /unabuse @нік).
//
//   • усі невиплачені заявки гравця відхиляються без повернення списаного;
//   • баланс зірок обнуляється (через users.move — з журналом);
//   • XP скидається: рівень, пас і ліга — з нуля (progress.resetXp);
//   • гравцю — попередження з причиною й переліком того, що скасовано.
// Що знято, пишемо в u.abuse — /unabuse повертає зірки й XP (заявки — ні).
// Усе синхронно, тож подвійний виклик не перетнеться з першим.
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const applications = require('./applications');

const pendingOf = (uid) => store.listApplications('pending').filter(a => a.uid === String(uid));

// Що буде скасовано — для попереднього перегляду.
function preview(uid) {
  const u = users.get(uid);
  if (!u) return null;
  const x = progress.xpOf(u);
  return { stars: users.stars(u), xp: x.total, level: progress.levelIndex(x.total) + 1, apps: pendingOf(uid), prev: u.abuse || null };
}

// Покарати. → { ok, stars, xp, level, apps: [id…], count }
function punish(uid, reason, by) {
  uid = String(uid);
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  const why = 'Абуз бота' + (reason ? ': ' + reason : '');
  const apps = pendingOf(uid).filter(a => applications.reject(a.id, why, { noRefund: true, silent: true }).ok).map(a => a.id);
  const stars = Math.max(0, users.stars(u));
  if (stars > 0) users.move(uid, { stars: -stars }, 'abuse', { reason: reason || null });
  const level = progress.levelIndex(progress.xpOf(u).total) + 1;
  const xp = progress.resetXp(uid);
  // Повторне покарання до відміни — додаємо до вже знятого, щоб /unabuse повернув усе.
  const p = u.abuse || {};
  const sum = (a, b) => Math.round(((a || 0) + (b || 0)) * 100) / 100;
  const xpTaken = p.xp && xp ? {
    total: sum(p.xp.total, xp.total),
    season: p.xp.season && p.xp.season.id === xp.season.id ? { id: xp.season.id, xp: sum(p.xp.season.xp, xp.season.xp) } : xp.season,
    week: p.xp.week && p.xp.week.id === xp.week.id ? { id: xp.week.id, xp: sum(p.xp.week.xp, xp.week.xp) } : xp.week,
  } : xp;
  const count = (u.abuseCount || 0) + 1;
  users.patch(uid, {
    abuse: { at: Date.now(), by: by ? String(by) : null, reason: reason || null, stars: sum(p.stars, stars), xp: xpTaken, apps: (p.apps || []).concat(apps) },
    abuseCount: count,
  });
  return { ok: true, stars, xp: xp ? xp.total : 0, level, apps, count };
}

// Відмінити: повернути зняті зірки й XP. → { ok, stars, xp }
function undo(uid) {
  uid = String(uid);
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  const a = u.abuse;
  if (!a) return { ok: false, error: 'not_punished' };
  users.patch(uid, { abuse: null, abuseCount: Math.max(0, (u.abuseCount || 1) - 1) });
  if (a.stars > 0) users.move(uid, { stars: a.stars }, 'abuse_undo', {});
  const xp = progress.restoreXp(uid, a.xp);
  return { ok: true, stars: a.stars || 0, xp, apps: a.apps || [] };
}

module.exports = { preview, punish, undo };
