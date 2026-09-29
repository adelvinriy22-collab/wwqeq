// ==========================================================================
// ІГРИ В ЗАСТОСУНКУ: ризик ×2 після спіну й ігри на зірки (кубик, дартс,
// баскетбол, футбол, боулінг, слоти). Результат — з перевірюваного
// генератора, коефіцієнти ті самі, що були в боті (RTP 87–93%).
// ==========================================================================
const E = require('../economy');
const users = require('../core/users');
const progress = require('../core/progress');
const rng = require('../core/rng');
const quests = require('./quests');
const { round2 } = require('../lib/util');

// ─── Ризик ×2 ───────────────────────────────────────────────────────────
function riskState(u) {
  const pr = u && u.pendingRisk;
  if (!pr || !pr.amount) return null;
  if (Date.now() - pr.at > E.RISK.windowMs || pr.streak >= E.RISK.maxStreak) return null;
  return { amount: pr.amount, streak: pr.streak, expiresAt: pr.at + E.RISK.windowMs, chance: E.RISK.chance, maxStreak: E.RISK.maxStreak };
}

async function risk(uid) {
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    const pr = u.pendingRisk;
    if (!pr || !pr.amount) return { ok: false, status: 400, error: 'nothing_to_risk' };
    if (Date.now() - pr.at > E.RISK.windowMs) { users.patch(uid, { pendingRisk: null }); return { ok: false, status: 400, error: 'expired' }; }
    if (pr.streak >= E.RISK.maxStreak) return { ok: false, status: 400, error: 'max_streak' };
    // Ризикувати можна лише зірками, які ще на балансі.
    if (users.stars(u) + 1e-9 < pr.amount) { users.patch(uid, { pendingRisk: null }); return { ok: false, status: 400, error: 'spent' }; }

    const roll = rng.next(uid);
    const won = roll.v < E.RISK.chance;
    quests.track(uid, 'risk');
    const hist = (u.spinHistory || []);
    if (won) {
      const newAmount = pr.amount * 2, streak = pr.streak + 1;
      users.move(uid, { stars: pr.amount }, 'risk_win', { x: Math.pow(2, streak) });
      users.patch(uid, {
        pendingRisk: streak >= E.RISK.maxStreak ? null : { amount: newAmount, streak, at: Date.now(), spinAt: pr.spinAt },
        lastRiskResult: { won: true, finalAmount: newAmount, spinAt: pr.spinAt, at: Date.now() },
        spinHistory: hist.concat([{ id: 'risk_win', sp: 0, am: pr.amount, w: 'risk', mult: Math.pow(2, streak), at: Date.now(), n: roll.nonce }]).slice(-30),
      });
      const after = users.get(uid);
      return { ok: true, won: true, amount: newAmount, streak, canRiskAgain: streak < E.RISK.maxStreak,
               balance: users.stars(after), proof: { nonce: roll.nonce, hash: roll.hash }, roll: roll.v };
    }
    users.move(uid, { stars: -pr.amount }, 'risk_lose', {});
    users.patch(uid, {
      pendingRisk: null,
      lastRiskResult: { won: false, finalAmount: 0, spinAt: pr.spinAt, at: Date.now() },
      spinHistory: hist.concat([{ id: 'risk_lose', sp: 0, am: pr.amount, w: 'risk', mult: Math.pow(2, pr.streak || 0), at: Date.now(), n: roll.nonce }]).slice(-30),
    });
    return { ok: true, won: false, lost: pr.amount, balance: users.stars(users.get(uid)), proof: { nonce: roll.nonce, hash: roll.hash }, roll: roll.v };
  });
}

// ─── Ігри на зірки ──────────────────────────────────────────────────────
function catalog(lang) {
  const lg = lang || 'uk';
  return Object.entries(E.GAMES).map(([id, g]) => ({
    id, emoji: g.emoji, title: g.title[lg] || g.title.uk, faces: g.faces,
    bets: Object.entries(g.bets).map(([bid, b]) => ({
      id: bid, title: b.title[lg] || b.title.uk,
      k: b.slots ? null : b.k, win: b.win || null,
      chance: b.win ? Math.round(b.win.length / g.faces * 1000) / 10 : null,
      slots: !!b.slots,
    })),
  }));
}

async function play(uid, gameId, betId, stake) {
  const g = Object.prototype.hasOwnProperty.call(E.GAMES, gameId) ? E.GAMES[gameId] : null;
  const b = g && Object.prototype.hasOwnProperty.call(g.bets, betId) ? g.bets[betId] : null;
  if (!g || !b) return { ok: false, status: 400, error: 'unknown_game' };
  const bet = Math.floor(Number(stake));
  if (!Number.isFinite(bet) || bet < E.GAME_BET.min || bet > E.GAME_BET.max) {
    return { ok: false, status: 400, error: 'bad_bet', min: E.GAME_BET.min, max: E.GAME_BET.max };
  }
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    if (users.stars(u) < bet) return { ok: false, status: 402, error: 'not_enough_stars', have: users.stars(u), need: bet };
    users.move(uid, { stars: -bet }, 'game_bet', { game: gameId, bet: betId });

    const roll = rng.next(uid);
    const value = rng.face(roll.v, g.faces);
    let k = 0, reels = null;
    if (b.slots) { const s = E.slotResult(value); k = s.k; reels = s.reels; }
    else k = b.win.includes(value) ? b.k : 0;
    const payout = round2(bet * k);
    if (payout) users.move(uid, { stars: payout }, 'game_win', { game: gameId, k });

    const u2 = users.get(uid);
    users.patch(uid, {
      diceGames: (u2.diceGames || 0) + 1,
      diceWagered: round2((u2.diceWagered || 0) + bet),
      diceWon: round2((u2.diceWon || 0) + payout),
    });
    progress.addXp(uid, 'wager', bet * E.XP_RATES.gamePerStar);
    quests.track(uid, 'game');
    const after = users.get(uid);
    return {
      ok: true, game: gameId, bet: betId, stake: bet, value, reels, k, won: payout > 0, payout,
      balance: users.stars(after), proof: { nonce: roll.nonce, hash: roll.hash },
    };
  });
}

module.exports = { riskState, risk, catalog, play };
