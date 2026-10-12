// ==========================================================================
// ВИВІД ПОДАРУНКАМИ: розблокування, активність по днях, антиабуз, ліміти.
//
//   • Активні дні — коли гравець заходив у бота (приват) чи застосунок:
//     u.activeDays (останні 30 днів за Києвом). Для днів до запуску цього
//     обліку беремо журнал рухів (ledger), u.tx і lastActiveAt.
//   • Розблокування — кнопка з розсилки (/wd_unlock) діє E.WITHDRAW.unlockWindowMs;
//     натиснути можна, якщо за останні unlockLookbackDays днів людина була
//     в боті щонайменше unlockNeedDays різних днів. Без цього вивід закритий.
//   • Антиабуз — вік акаунта, «справжні» друзі (були в боті ≥2 дні), одна
//     заявка в черзі, денний ліміт виплат, бан виводу (u.wdBan), ризик-картка
//     для адміна на кожній заявці.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const store = require('../store');
const users = require('../core/users');
const E = require('../economy');
const time = require('../lib/time');

const DAY = time.DAY_MS;
const W = () => E.WITHDRAW;

// ─── Активні дні ────────────────────────────────────────────────────────
// Патч для users.patch або null (якщо сьогодні вже відмічено).
function touchPatch(u, now) {
  const today = time.dayKey(now || Date.now());
  const days = (u && u.activeDays) || [];
  if (days[days.length - 1] === today) return null;
  return { activeDays: days.filter(d => d !== today).concat([today]).slice(-30) };
}
function touch(uid) {
  const u = users.get(uid);
  if (!u) return;
  const p = touchPatch(u);
  if (p) users.patch(uid, p);
}

// Журнал рухів за останні дні: uid -> Set(днів). Читаємо не частіше разу на 10 хв.
let ledgerCache = { at: 0, map: new Map() };
function ledgerDays() {
  if (Date.now() - ledgerCache.at < 10 * 60000) return ledgerCache.map;
  const map = new Map();
  const since = Date.now() - 9 * DAY;
  const months = new Set([new Date().toISOString().slice(0, 7), new Date(since).toISOString().slice(0, 7)]);
  for (const m of months) {
    const f = path.join(store.DATA_DIR, 'ledger-' + m + '.jsonl');
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!e || !e.uid || !(e.ts >= since)) continue;
        if (!map.has(e.uid)) map.set(e.uid, new Set());
        map.get(e.uid).add(time.dayKey(e.ts));
      } catch (e) {}
    }
  }
  ledgerCache = { at: Date.now(), map };
  return map;
}

// Скільки різних днів гравець був у боті за останні lookbackDays (включно з сьогодні).
function activeDaysIn(uid, lookbackDays) {
  const u = users.get(uid);
  if (!u) return 0;
  const now = Date.now();
  const from = time.dayKey(now - (lookbackDays - 1) * DAY);
  const set = new Set();
  const add = (d) => { if (d && d >= from) set.add(d); };
  for (const d of u.activeDays || []) add(d);
  if (u.lastActiveAt) add(time.dayKey(u.lastActiveAt));
  for (const t of u.tx || []) if (t && t.ts) add(time.dayKey(t.ts));
  const led = ledgerDays().get(String(uid));
  if (led) for (const d of led) add(d);
  return set.size;
}

// ─── Друзі, які рахуються для виводу ───────────────────────────────────
// «Справжній» друг — запустив бота й повертався: ≥2 різні дні або ≥24 год між
// першим і останнім заходом. Пачки ботів-реферів, що зайшли раз, не рахуються.
function isRealFriend(f) {
  if (!f || !f.lang) return false;
  if ((f.activeDays || []).length >= W().realFriendMinDays) return true;
  const first = f.joinedAt || f.firstSeenAt || 0;
  return !!(f.lastActiveAt && first && f.lastActiveAt - first >= DAY);
}
function realFriends(u) {
  return (u.invitedIds || []).filter(id => isRealFriend(users.get(id))).length;
}

// ─── Заявки на вивід ────────────────────────────────────────────────────
const isWithdrawal = (a) => a && a.source === 'app_withdrawal';
const live = (a) => a.status === 'pending' || a.status === 'approved';
function myWithdrawals(uid) { return store.listApplications().filter(a => isWithdrawal(a) && a.uid === String(uid)); }
function pendingCount(uid) { return myWithdrawals(uid).filter(a => a.status === 'pending').length; }
// Сума виплат (подарунків) за сьогодні — для денного ліміту.
function payoutToday(uid) {
  const today = time.dayKey(Date.now());
  return myWithdrawals(uid).filter(a => live(a) && time.dayKey(a.createdAt) === today).reduce((s, a) => s + (a.payoutStars || 0), 0);
}

// ─── Розблокування ──────────────────────────────────────────────────────
const unlockState = () => (store.getFeatureFlags() || {}).wdUnlock || null;
const windowOpen = (s) => !!(s && Date.now() < s.until);
const isUnlocked = (u) => !W().needUnlock || !!(u && (u.wdUnlockedAt || u.wdUnlockGranted));

// Натиснув кнопку. → { ok } або { ok: false, error: 'closed'|'already'|'not_active', days, need }
function tryUnlock(uid) {
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  if (isUnlocked(u)) return { ok: false, error: 'already' };
  if (!windowOpen(unlockState())) return { ok: false, error: 'closed' };
  const days = activeDaysIn(uid, W().unlockLookbackDays);
  if (days < W().unlockNeedDays) return { ok: false, error: 'not_active', days, need: W().unlockNeedDays };
  users.patch(uid, { wdUnlockedAt: Date.now() });
  return { ok: true, days };
}

// ─── Ризик-картка для адміна ────────────────────────────────────────────
function risk(uid) {
  const u = users.get(uid) || {};
  const ageDays = Math.floor((Date.now() - (u.joinedAt || u.firstSeenAt || Date.now())) / DAY);
  const total = (u.invitedIds || []).length, real = realFriends(u);
  const days7 = activeDaysIn(uid, 7);
  const done = myWithdrawals(uid).filter(a => a.status === 'approved');
  const flags = [];
  if (ageDays < 7) flags.push('новий акаунт');
  if (total >= 3 && real < total / 2) flags.push('більшість друзів неактивні');
  if (!(u.depositedTotal > 0)) flags.push('без поповнень');
  if (days7 < 3) flags.push('мало днів у боті');
  if (!u.username) flags.push('без @username');
  return {
    ageDays, friends: total, realFriends: real, days7, deposited: u.depositedTotal || 0,
    withdrawnCount: done.length, withdrawnStars: done.reduce((s, a) => s + (a.payoutStars || 0), 0), flags,
  };
}
function riskText(uid) {
  const r = risk(uid);
  return `🔎 Акаунт: ${r.ageDays} дн. · у боті ${r.days7}/7 днів · друзі ${r.realFriends}/${r.friends} справжніх\n` +
    `💳 Поповнено: ${r.deposited}⭐ · виведено раніше: ${r.withdrawnCount} (${r.withdrawnStars}⭐)` +
    (r.flags.length ? `\n⚠️ ${r.flags.join(' · ')}` : '\n✅ Підозр немає');
}

module.exports = {
  touch, touchPatch, activeDaysIn, isRealFriend, realFriends,
  pendingCount, payoutToday, myWithdrawals,
  unlockState, windowOpen, isUnlocked, tryUnlock,
  risk, riskText,
};
