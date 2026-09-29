// Ігри: колеса (щоденне, за білети, за зірки) з ризиком ×2, спільний банк,
// ігри на зірки (кубик, дартс, боулінг, баскетбол, футбол, слоти).
import { el, mount, img } from '../dom.js';
import { t } from '../i18n.js';
import * as api from '../api.js';
import { S, setBalance, refreshSoon, refresh } from '../state.js';
import { haptic } from '../tg.js';
import { createWheel } from '../wheel.js';
import { section, list, row, button, seg, bar, empty, pill, toast, fail, sheet, closeSheet, countdown, clock, left, fmt, stars, tix, when } from '../ui.js';

let view = 'wheels';
let wheelId = 'daily';

export function render(nav, v) {
  if (v) view = v === 'dice' ? 'dice' : v;
  if (!['wheels', 'bank', 'dice'].includes(view)) view = 'wheels';
  const body = el('div');
  const pick = (id) => { view = id; nav.rerender(); };
  const out = [
    el('div', { class: 'h1' }, t('games.title')),
    seg([['wheels', t('games.wheels')], ['bank', t('games.bank')], ['dice', t('games.dice')]], view, pick),
    body,
  ];
  if (view === 'wheels') mount(body, wheels(nav));
  else if (view === 'bank') bankView(nav, body);
  else diceView(nav, body);
  return out;
}

// ─── Колеса ──────────────────────────────────────────────────────────────
export function wheelTitle(id) { return t('wheel.' + id); }
function tierName(id) { const x = (S.me.tiers || []).find(q => q.id === id); return x ? x.emoji + ' ' + x.name : id; }
function tierImg(id) { const x = (S.me.tiers || []).find(q => q.id === id); return x && x.img; }

function wheels(nav) {
  const W = S.me.wheels.wheels;
  if (!W[wheelId]) wheelId = 'daily';
  const ids = ['daily', 'referral', 'paid'].filter(id => W[id]);
  const tabs = el('div', { class: 'wheel-tabs' }, ids.map(id => {
    const w = W[id];
    const cost = id === 'daily' ? t('wheel.free') : id === 'referral' ? w.cost.tickets + '🎫' : (w.gifted ? t('wheel.gifted', { n: w.gifted }) : w.cost.stars + '⭐');
    return el('button', { class: 'wheel-tab' + (id === wheelId ? ' on' : ''), type: 'button', onclick: () => { wheelId = id; haptic('select'); nav.rerender(); } },
      el('div', { class: 'wt-t' }, wheelTitle(id)), el('div', { class: 'wt-s' }, cost));
  }));
  return [tabs, wheelCard(nav, wheelId), riskCard(nav), fairRow(nav)];
}

export function wheelCard(nav, id, compact) {
  const w = S.me.wheels.wheels[id];
  const wheel = createWheel(w.segments, id);
  const hh = S.me.wheels.happyHour;
  const meta = el('div', { class: 'wheel-meta' });
  if (hh && hh.active) meta.appendChild(pill('🍀 ' + t('wheel.happy'), 'warn'));
  if (w.pity && w.pity.giftLeft) meta.appendChild(pill('🎁 ' + t('wheel.pityGift', { n: w.pity.giftLeft }), 'grey'));
  if (w.pity && w.pity.nftLeft) meta.appendChild(pill('💎 ' + t('wheel.pityNft', { n: w.pity.nftLeft }), 'grey'));
  if (id === 'daily' && S.me.wheels.daily.streak > 1 && S.me.wheels.daily.streakAlive) meta.appendChild(pill('🔥 ' + t('wheel.streak', { n: S.me.wheels.daily.streak })));

  const holder = el('div', { class: 'mt8' });
  const draw = () => mount(holder, spinButton(nav, id, wheel, draw));
  draw();
  return el('div', { class: 'card pad' }, compact ? null : null, wheel.el, meta, holder);
}

function spinButton(nav, id, wheel, redraw) {
  const w = S.me.wheels.wheels[id];
  const bal = S.me.balance;
  const go = () => spinFlow(nav, id, wheel).then(() => redraw());
  if (id === 'daily') {
    if (w.ready) {
      const bonus = !S.me.wheels.daily.ready && w.freeSpins > 0;
      return button(bonus ? t('wheel.bonusSpin', { n: w.freeSpins }) : t('wheel.spinFree'), go, '', bonus ? null : t('wheel.everyDay'));
    }
    const b = el('button', { class: 'btn tinted', type: 'button', disabled: true }, el('span', null, t('wheel.next') + ' '), countdown(w.nextAt, (ms) => clock(ms), () => refresh().then(redraw).catch(() => {})));
    return el('div', { class: 'stack' }, b, S.me.balance.tickets >= 5 ? button(t('wheel.tryTickets'), () => { wheelId = 'referral'; nav.go('games', 'wheels'); }, 'plain') : null);
  }
  if (id === 'referral') {
    if (w.ready) return button(t('wheel.spinFor', { cost: w.cost.tickets + '🎫' }), go, '', t('wheel.youHave', { v: tix(bal.tickets) }));
    return el('div', { class: 'stack' },
      el('button', { class: 'btn tinted', type: 'button', disabled: true }, t('wheel.needTickets', { n: w.cost.tickets - bal.tickets })),
      button(t('wheel.getTickets'), () => nav.go('progress', 'quests'), 'plain'));
  }
  // paid
  if (w.gifted) return button(t('wheel.giftedSpin', { n: w.gifted }), go, 'ok');
  if (w.ready) return button(t('wheel.spinFor', { cost: w.cost.stars + '⭐' }), go, '', t('wheel.youHave', { v: stars(bal.stars) }));
  return el('div', { class: 'stack' },
    el('button', { class: 'btn tinted', type: 'button', disabled: true }, t('wheel.needStars', { n: fmt(w.cost.stars - bal.stars) })),
    button(t('wallet.topup'), () => nav.go('wallet', 'topup'), 'plain'));
}

let spinning = false;
export const busy = () => spinning;
export async function spinFlow(nav, id, wheel) {
  if (spinning) return null;
  spinning = true;
  try {
    wheel.nudge();
    let r;
    try { r = await api.post('/spin', { wheel: id }); }
    catch (e) {
      fail(e);
      if (e.code === 'not_subscribed' || e.code === 'daily_cooldown') refresh().then(() => nav.rerender()).catch(() => {});
      return null;
    }
    haptic('medium');
    if (r.kind === 'prize') wheel.showPrize(r.segment, tierImg(r.outcome));
    await wheel.spinTo(r.segment);
    S.me.wheels = r.state;
    S.me.risk = r.riskAvailable ? { amount: r.amount, streak: 0, expiresAt: Date.now() + 5 * 60000, chance: 0.45, maxStreak: 3 } : null;
    setBalance(r.balance, r.tickets);
    haptic(r.kind === 'prize' ? 'success' : 'light');
    showResult(nav, r);
    refreshSoon();
    return r;
  } finally { spinning = false; }
}

function showResult(nav, r) {
  sheet((s) => {
    const parts = [];
    if (r.kind === 'prize') {
      parts.push(el('div', { class: 'result' }, img(tierImg(r.outcome)), el('div', { class: 't' }, t('res.prize', { name: tierName(r.outcome) })),
        el('div', { class: 's' }, t('res.app', { id: r.applicationId })), r.byPity ? el('div', { class: 's' }, t('res.pity')) : null));
    } else if (r.kind === 'tickets') {
      parts.push(el('div', { class: 'result' }, el('div', { class: 'big' }, '+' + r.amount + '🎫'), el('div', { class: 's' }, t('res.tickets'))));
    } else {
      parts.push(el('div', { class: 'result' }, el('div', { class: 'big' }, '+' + fmt(r.amount) + '⭐'), el('div', { class: 's' }, t('res.stars'))));
    }
    if (r.streakBonus) parts.push(el('div', { class: 'banner gold mt8' }, el('div', { class: 'bi' }, '🔥'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('res.streak', { n: r.streak, s: r.streakBonus })))));
    const riskBox = el('div', { class: 'mt12' });
    if (r.riskAvailable) mount(riskBox, riskOffer(nav, s, r.amount, 0));
    else mount(riskBox, button(t('common.great'), () => s.close()));
    parts.push(riskBox);
    parts.push(el('div', { class: 'center muted mt8 mono' }, '#' + r.proof.nonce + ' · ' + String(r.proof.hash).slice(0, 12) + '…'));
    return parts;
  });
}

// Пропозиція «ризикнути ×2» у шторці результату або на екрані.
function riskOffer(nav, s, amount, streak) {
  const box = el('div', { class: 'stack' },
    el('div', { class: 'center muted' }, t('risk.offer', { a: fmt(amount), b: fmt(amount * 2), p: 45 })),
    el('div', { class: 'btns' },
      button(t('risk.take'), () => { S.me.risk = null; s.close(); nav.rerender(); }, 'tinted'),
      button(t('risk.go', { x: Math.pow(2, streak + 1) }), async () => {
        let r;
        try { r = await api.post('/risk'); } catch (e) { fail(e); S.me.risk = null; s.close(); return; }
        setBalance(r.balance);
        if (r.won) {
          haptic('success');
          S.me.risk = r.canRiskAgain ? { amount: r.amount, streak: r.streak, expiresAt: Date.now() + 5 * 60000 } : null;
          s.set(el('div', { class: 'result' }, el('div', { class: 'big ok-text' }, '×' + Math.pow(2, r.streak) + ' → ' + fmt(r.amount) + '⭐'), el('div', { class: 's' }, t('risk.won'))),
            el('div', { class: 'mt12' }, r.canRiskAgain ? riskOffer(nav, s, r.amount, r.streak) : button(t('common.great'), () => { s.close(); nav.rerender(); })));
        } else {
          haptic('error');
          S.me.risk = null;
          s.set(el('div', { class: 'result' }, el('div', { class: 'big bad-text' }, '−' + fmt(r.lost) + '⭐'), el('div', { class: 's' }, t('risk.lost'))),
            el('div', { class: 'mt12' }, button(t('common.ok'), () => { s.close(); nav.rerender(); })));
        }
        refreshSoon();
      })));
  return box;
}

function riskCard(nav) {
  const r = S.me.risk;
  if (!r || !r.amount || (r.expiresAt && r.expiresAt < Date.now())) return null;
  return el('div', { class: 'banner gold mt12' },
    el('div', { class: 'bi' }, '🎲'),
    el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('risk.bannerT', { a: fmt(r.amount) })), el('div', { class: 'bs' }, t('risk.bannerS'), ' ', r.expiresAt ? countdown(r.expiresAt, clock) : null)),
    el('button', { class: 'btn small', type: 'button', onclick: () => sheet((s) => [el('h3', null, t('risk.title')), riskOffer(nav, s, r.amount, r.streak || 0)]) }, t('risk.try')));
}

function fairRow(nav) {
  return [
    ...section(null, list(row({ icon: '🛡', title: t('fair.title'), sub: t('fair.short', { h: String(S.me.fairHash || '').slice(0, 10) + '…' }), onClick: () => import('./profile.js').then(m => m.openFair(nav)) }))),
  ];
}

// ─── Банк ────────────────────────────────────────────────────────────────
let bankPoll = null;
async function bankView(nav, body) {
  mount(body, empty(t('common.loading')));
  let b;
  try { b = await api.get('/bank'); } catch (e) { mount(body, empty(t('err.generic'))); return; }
  if (!body.isConnected) return;
  drawBank(nav, body, b);
  clearInterval(bankPoll);
  bankPoll = setInterval(async () => {
    if (!body.isConnected) { clearInterval(bankPoll); return; }
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    try { const nb = await api.get('/bank'); if (body.isConnected) drawBank(nav, body, nb); } catch (e) {}
  }, 6000);
}

function drawBank(nav, body, b) {
  if (!b.active) {
    mount(body, el('div', { class: 'card pad center' },
      el('div', { style: { fontSize: '48px' } }, '🏦'),
      el('div', { class: 't mt8', style: { fontWeight: 600 } }, t('bank.none')),
      el('div', { class: 'muted mt8' }, b.auto && b.auto.enabled ? t('bank.autoNext', { h: String(b.auto.hour).padStart(2, '0') }) : t('bank.soon'))),
      ...section(t('bank.how'), list(
        row({ icon: '⭐', title: t('bank.how1') }), row({ icon: '🎫', title: t('bank.how2', { w: 5 }) }),
        row({ icon: '🎯', title: t('bank.how3') }), row({ icon: '🎁', title: t('bank.how4') }))));
    return;
  }
  const open = b.status === 'open';
  const hero = el('div', { class: 'card' },
    el('div', { class: 'hero' },
      el('div', { class: 'sub' }, open ? t('bank.pot') : t('bank.drawn')),
      el('div', { class: 'big' }, stars(b.prize.stars) + (b.prize.tickets ? ' + ' + tix(b.prize.tickets) : '')),
      el('div', { class: 'sub' }, open ? [t('bank.drawIn') + ' ', countdown(b.drawAt, left, () => bankView(nav, body))] : when(b.drawAt))),
    el('div', { class: 'stat-grid' },
      el('div', null, el('b', null, String(b.players)), el('span', null, t('bank.players'))),
      el('div', null, el('b', null, fmt(b.mine.weight)), el('span', null, t('bank.myStake'))),
      el('div', null, el('b', null, b.mine.chance + '%'), el('span', null, t('bank.chance')))));
  const parts = [hero];

  if (!open && b.winner) {
    parts.push(el('div', { class: 'banner ' + (b.winner.me ? 'green' : '') + ' mt12' }, el('div', { class: 'bi' }, b.winner.me ? '🏆' : '🎉'),
      el('div', { class: 'bm' }, el('div', { class: 'bt' }, b.winner.me ? t('bank.youWon') : t('bank.winner', { name: b.winner.name })), b.won ? el('div', { class: 'bs' }, stars(b.won.stars) + (b.won.tickets ? ' + ' + tix(b.won.tickets) : '')) : null)));
  }
  if (open) parts.push(...section(t('bank.bet'), el('div', { class: 'card pad' }, betForm(nav, body, b)), t('bank.betFoot', { w: b.ticketWeight, c: b.consolePer })));

  const ms = b.milestones;
  if (ms && ms.list && ms.list.length) {
    parts.push(...section(t('bank.milestones'), el('div', { class: 'card pad' },
      ms.next ? [el('div', { class: 'kv', style: { marginTop: 0 } }, el('span', null, t('bank.toNext', { n: fmt(ms.toNext), label: ms.next.label })), el('span', null, ms.nextPercent + '%')), el('div', { class: 'mt8' }, bar(ms.nextPercent, 'gold'))] : el('div', { class: 'ok-text' }, t('bank.allMs')),
      el('div', { class: 'gap8 mt12' }, ms.list.map(m => pill((m.reached ? '✓ ' : '') + m.at + ' → +' + m.bonus + '⭐', m.reached ? 'ok' : 'grey'))))));
  }
  if (b.sectors && b.sectors.length) {
    parts.push(...section(t('bank.table'), list(b.sectors.slice(0, 15).map((s, i) =>
      row({ icon: i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1), title: s.name + (s.me ? ' · ' + t('common.you') : ''), sub: (s.stars ? stars(s.stars) : '') + (s.stars && s.tickets ? ' + ' : '') + (s.tickets ? tix(s.tickets) : ''), value: s.percent + '%', strong: s.me })))));
  }
  if (b.feed && b.feed.length && open) {
    parts.push(...section(t('bank.feed'), list(b.feed.slice(0, 6).map(f => row({ icon: f.tickets && !f.stars ? '🎫' : '⭐', title: f.name, sub: when(f.at), value: '+' + (f.stars ? stars(f.stars) : '') + (f.stars && f.tickets ? ' ' : '') + (f.tickets ? tix(f.tickets) : '') })))));
  }
  const verify = b.verify;
  parts.push(...section(t('fair.title'), list(
    row({ icon: '🔒', title: t('bank.seedHash'), sub: el('span', { class: 'mono' }, String(b.seedHash || '')) }),
    verify ? row({ icon: verify.seedOk && verify.hmacOk ? '✅' : '⚠️', title: verify.seedOk && verify.hmacOk ? t('bank.verified') : t('bank.verifyFail'), sub: el('span', { class: 'mono' }, 'seed: ' + verify.seed) }) : null),
    t('bank.fairFoot')));
  mount(body, parts);
}

function betForm(nav, body, b) {
  const sIn = el('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: '0' });
  const tIn = el('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: '0' });
  const hint = el('div', { class: 'kv' });
  const upd = () => {
    const s = Math.floor(Number(sIn.value) || 0), tk = Math.floor(Number(tIn.value) || 0);
    const w = s + tk * b.ticketWeight;
    const mine = b.mine.weight + w, pot = b.pot + w;
    hint.textContent = '';
    hint.append(el('span', null, t('bank.weight', { w: fmt(w) })), el('span', null, w ? t('bank.newChance', { p: pot ? Math.round(mine / pot * 1000) / 10 : 0 }) : ''));
  };
  sIn.addEventListener('input', upd); tIn.addEventListener('input', upd);
  upd();
  const presets = el('div', { class: 'presets four mt8' }, [5, 10, 25, 50].map(n => el('button', { class: 'preset', type: 'button', onclick: () => { sIn.value = String(n); haptic('select'); upd(); } }, n + '⭐')));
  return el('div', null,
    el('div', { class: 'btns' },
      el('div', { class: 'field' }, sIn, el('span', { class: 'unit' }, '⭐')),
      el('div', { class: 'field' }, tIn, el('span', { class: 'unit' }, '🎫'))),
    el('div', { class: 'kv' }, el('span', null, t('wheel.youHave', { v: stars(b.balance) })), el('span', null, tix(b.myTickets))),
    presets, hint,
    el('div', { class: 'mt12' }, button(t('bank.place'), async () => {
      const s = Math.floor(Number(sIn.value) || 0), tk = Math.floor(Number(tIn.value) || 0);
      if (!s && !tk) { toast(t('bank.enter')); return; }
      try {
        const r = await api.post('/bank/bet', { stars: s, tickets: tk });
        setBalance(r.balance, r.tickets);
        toast(t('bank.placed', { p: r.chance }), 'success');
        refreshSoon();
        const nb = await api.get('/bank');
        drawBank(nav, body, nb);
      } catch (e) { fail(e); }
    })));
}

// ─── Ігри на зірки ───────────────────────────────────────────────────────
let gameId = 'dice', betId = null, stake = 5;
async function diceView(nav, body) {
  let cat = S.cache.games;
  if (!cat) {
    mount(body, empty(t('common.loading')));
    try { cat = S.cache.games = await api.get('/games'); } catch (e) { mount(body, empty(t('err.generic'))); return; }
  }
  if (!body.isConnected) return;
  drawDice(nav, body, cat);
}

const SLOT = ['BAR', '🍇', '🍋', '7'];
function drawDice(nav, body, cat) {
  const g = cat.games.find(x => x.id === gameId) || cat.games[0];
  gameId = g.id;
  if (!g.bets.find(x => x.id === betId)) betId = g.bets[0].id;
  const bt = g.bets.find(x => x.id === betId);
  const stage = el('div', { class: 'dice-stage' }, g.id === 'slots'
    ? el('div', { class: 'reels' }, [0, 1, 2].map(() => el('div', { class: 'reel' }, '7')))
    : el('div', { class: 'dice-face' }, g.emoji), el('div', { class: 'dice-val' }));
  const outcome = el('div', { class: 'center muted', style: { minHeight: '22px' } }, bt.slots ? t('dice.slotsRule') : t('dice.rule', { win: (bt.win || []).join(', '), k: bt.k, p: bt.chance }));
  const balLine = el('span', null, t('wheel.youHave', { v: stars(S.me.balance.stars) }));
  const stakeIn = el('input', { type: 'number', inputmode: 'numeric', min: cat.bet.min, max: cat.bet.max, value: String(stake) });
  stakeIn.addEventListener('input', () => { stake = Math.floor(Number(stakeIn.value) || 0); });
  const presets = el('div', { class: 'presets mt8' }, cat.bet.presets.map(n => el('button', { class: 'preset' + (n === stake ? ' on' : ''), type: 'button', onclick: () => { stake = n; drawDice(nav, body, cat); } }, n + '⭐')));

  mount(body,
    el('div', { class: 'grid3' }, cat.games.map(x => el('button', { class: 'tile' + (x.id === gameId ? ' on' : ''), type: 'button', onclick: () => { gameId = x.id; betId = null; haptic('select'); drawDice(nav, body, cat); } },
      el('div', { class: 'em' }, x.emoji), el('div', { class: 'tt' }, x.title)))),
    ...section(g.title, el('div', { class: 'card pad' },
      stage, outcome,
      g.bets.length > 1 ? el('div', { class: 'presets mt12' }, g.bets.map(x => el('button', { class: 'preset' + (x.id === betId ? ' on' : ''), type: 'button', onclick: () => { betId = x.id; drawDice(nav, body, cat); } }, x.title, el('small', null, '×' + x.k)))) : null,
      el('div', { class: 'label' }, t('dice.stake')),
      el('div', { class: 'field' }, stakeIn, el('span', { class: 'unit' }, '⭐')),
      presets,
      el('div', { class: 'kv' }, balLine, el('span', null, bt.slots ? '777 ×20 · ×6 · ×2' : t('dice.win', { v: fmt(stake * bt.k) }))),
      el('div', { class: 'mt12' }, button(bt.slots ? t('dice.spin') : t('dice.play'), async () => {
        const st = Math.floor(Number(stakeIn.value) || 0);
        if (st < cat.bet.min || st > cat.bet.max) { toast(t('err.bad_bet', { min: cat.bet.min, max: cat.bet.max })); return; }
        if (st > S.me.balance.stars) { toast(t('err.not_enough_stars')); return; }
        const face = stage.firstChild;
        if (g.id === 'slots') face.childNodes.forEach(n => n.classList.add('spin')); else face.classList.add('rolling');
        let r;
        const started = Date.now();
        try { r = await api.post('/games/play', { game: g.id, bet: bt.id, stake: st }); }
        catch (e) { fail(e); if (g.id === 'slots') face.childNodes.forEach(n => n.classList.remove('spin')); else face.classList.remove('rolling'); return; }
        await new Promise(res => setTimeout(res, Math.max(0, 900 - (Date.now() - started))));
        if (g.id === 'slots') { face.childNodes.forEach((n, i) => { n.classList.remove('spin'); n.textContent = SLOT[r.reels[i]]; }); }
        else { face.classList.remove('rolling'); stage.lastChild.textContent = t('dice.value', { v: r.value }); }
        setBalance(r.balance);
        balLine.textContent = t('wheel.youHave', { v: stars(r.balance) });
        outcome.textContent = r.won ? t('dice.won', { v: fmt(r.payout), k: r.k }) : t('dice.lost', { v: fmt(r.stake) });
        outcome.className = 'center ' + (r.won ? 'ok-text' : 'bad-text');
        haptic(r.won ? 'success' : 'error');
        refreshSoon();
      })))),
    el('div', { class: 'sec-foot' }, t('dice.fair', { n: cat.fair ? cat.fair.nonce : 0 })));
}
