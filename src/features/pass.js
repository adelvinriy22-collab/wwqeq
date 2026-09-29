// ==========================================================================
// СЕЗОННИЙ ПАС. Рівень пасу = XP, набраний за поточний сезон (30 днів).
// Дві лінії нагород: безкоштовна й платна (за 150⭐ з балансу або 100 реальних
// Telegram Stars — тоді ще +2 рівні бонусом).
// ==========================================================================
const E = require('../economy');
const users = require('../core/users');
const progress = require('../core/progress');
const applications = require('./applications');

const P = E.PASS;

function levelOf(xp) { return Math.max(1, Math.min(P.maxLevel, 1 + Math.floor((Number(xp) || 0) / P.levelXp))); }

// Запис пасу поточного сезону (купівля й забрані нагороди).
function stateOf(u, now) {
  const sid = progress.seasonId(now);
  const p = u && u.pass && u.pass.season === sid ? u.pass : null;
  return p || { season: sid, premium: false, premiumMethod: null, claimed: { free: [], prem: [] } };
}
function isClaimed(p, lv, track) { return ((p.claimed && p.claimed[track]) || []).includes(lv); }

function rewardLabel(rw, lang) {
  const lg = lang || 'uk';
  const L = {
    stars: { uk: '+{n}⭐', en: '+{n}⭐', ru: '+{n}⭐' },
    tickets: { uk: '+{n} 🎫', en: '+{n} 🎫', ru: '+{n} 🎫' },
    freeSpin: { uk: '{n} безкоштовн. спін', en: '{n} free spin', ru: '{n} бесплатн. спин' },
    paidSpin: { uk: 'Спін «За зірки»', en: 'Stars wheel spin', ru: 'Спин «За звёзды»' },
    final: { uk: 'Мішка + спін + 30⭐', en: 'Teddy + spin + 30⭐', ru: 'Мишка + спин + 30⭐' },
  };
  const tpl = (L[rw.type] || L.stars)[lg] || (L[rw.type] || L.stars).uk;
  return tpl.replace('{n}', rw.amount);
}

function claimable(u, now) {
  const p = stateOf(u, now);
  const lv = levelOf(progress.seasonXp(u, now));
  const out = [];
  for (let i = 1; i <= lv; i++) {
    if (P.free[i] && !isClaimed(p, i, 'free')) out.push({ level: i, track: 'free' });
    if (p.premium && P.prem[i] && !isClaimed(p, i, 'prem')) out.push({ level: i, track: 'prem' });
  }
  return out;
}

function view(u, lang) {
  const now = Date.now();
  const p = stateOf(u, now);
  const xp = progress.seasonXp(u, now);
  const level = levelOf(xp);
  const atMax = level >= P.maxLevel;
  const rewards = [];
  for (let lv = 1; lv <= P.maxLevel; lv++) {
    if (!P.free[lv] && !P.prem[lv]) continue;
    const mk = (rw, tr) => rw ? { type: rw.type, amount: rw.amount, label: rewardLabel(rw, lang), claimed: isClaimed(p, lv, tr),
      img: rw.type === 'final' ? 'bear' : null } : null;
    rewards.push({ level: lv, open: lv <= level, free: mk(P.free[lv], 'free'), prem: mk(P.prem[lv], 'prem') });
  }
  return {
    season: p.season, endsAt: progress.seasonEndsAt(now),
    xp, level, maxLevel: P.maxLevel, levelXp: P.levelXp,
    xpInLevel: atMax ? P.levelXp : Math.floor(xp - (level - 1) * P.levelXp),
    toNext: atMax ? 0 : Math.ceil(level * P.levelXp - xp),
    premium: !!p.premium, price: P.price, priceXtr: P.priceXtr, xtrBonusLevels: P.xtrBonusLevels,
    claimable: claimable(u, now).length, rewards,
  };
}

// Видача однієї нагороди. Викликати під блокуванням гравця.
function grant(uid, level, track) {
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  const now = Date.now();
  const lv = parseInt(level, 10);
  const tr = track === 'prem' ? 'prem' : 'free';
  const rw = (tr === 'prem' ? P.prem : P.free)[lv];
  if (!rw) return { ok: false, error: 'no_reward' };
  const p = stateOf(u, now);
  if (lv > levelOf(progress.seasonXp(u, now))) return { ok: false, error: 'locked' };
  if (tr === 'prem' && !p.premium) return { ok: false, error: 'not_premium' };
  if (isClaimed(p, lv, tr)) return { ok: false, error: 'already' };
  const claimed = { free: (p.claimed.free || []).slice(), prem: (p.claimed.prem || []).slice() };
  claimed[tr].push(lv);
  users.patch(uid, { pass: { ...p, claimed } });

  const meta = { level: lv, track: tr };
  let appId = null;
  if (rw.type === 'stars') users.move(uid, { stars: rw.amount }, 'pass', meta);
  else if (rw.type === 'tickets') users.move(uid, { tickets: rw.amount }, 'pass', meta);
  else if (rw.type === 'freeSpin') users.patch(uid, { freeSpins: (users.get(uid).freeSpins || 0) + rw.amount });
  else if (rw.type === 'paidSpin') users.patch(uid, { paidSpinsGifted: (users.get(uid).paidSpinsGifted || 0) + rw.amount });
  else if (rw.type === 'final') {
    users.move(uid, { stars: rw.stars }, 'pass', meta);
    users.patch(uid, { paidSpinsGifted: (users.get(uid).paidSpinsGifted || 0) + rw.paidSpin });
    appId = applications.create(uid, rw.prize, 'season_pass').id;
  }
  return { ok: true, level: lv, track: tr, type: rw.type, label: rewardLabel(rw, u.lang), applicationId: appId };
}

async function claim(uid, level, track) {
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    const list = level === 'all' ? claimable(u) : [{ level, track }];
    const results = [];
    for (const c of list) { const r = grant(uid, c.level, c.track); if (r.ok) results.push(r); }
    return { ok: true, results, state: view(users.get(uid), u.lang), balance: users.stars(users.get(uid)) };
  });
}

// method: 'balance' — з внутрішніх зірок; 'xtr' — після оплати реальними зірками.
function unlock(uid, method) {
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'no_user' };
  const p = stateOf(u);
  if (p.premium) return { ok: false, error: 'already_premium' };
  if (method === 'balance') {
    const r = users.move(uid, { stars: -P.price }, 'pass_buy', {});
    if (!r.ok) return { ok: false, error: 'not_enough_stars', need: P.price, have: users.stars(u) };
  }
  users.patch(uid, { pass: { ...p, premium: true, premiumMethod: method, premiumAt: Date.now() } });
  if (method === 'xtr') {
    // Бонусні рівні: доливаємо XP сезону (не більше ніж до останнього рівня).
    const cur = progress.seasonXp(users.get(uid));
    const target = Math.min((P.maxLevel - 1) * P.levelXp, cur + P.xtrBonusLevels * P.levelXp);
    if (target > cur) {
      const x = progress.xpOf(users.get(uid));
      x.season = { ...x.season, xp: target };
      users.patch(uid, { xp: x });
    }
  }
  const after = users.get(uid);
  return { ok: true, method, unlocked: claimable(after).filter(c => c.track === 'prem').length, level: levelOf(progress.seasonXp(after)) };
}

async function buy(uid) { return users.withLock(uid, () => unlock(uid, 'balance')); }

module.exports = { view, claim, buy, unlock, claimable, levelOf, stateOf, rewardLabel };
