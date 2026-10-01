// Ігри: колеса (щоденне, за білети, за зірки) з ризиком ×2 і спільний банк —
// колесо, де кожен гравець має сектор завбільшки зі свою ставку.
// Ігри на зірки (кубик, дартс, слоти…) — у чаті з ботом, з анімацією Telegram.
import { el, mount, img } from '../dom.js';
import { t } from '../i18n.js';
import * as api from '../api.js';
import { S, setBalance, refreshSoon, refresh } from '../state.js';
import { haptic } from '../tg.js';
import { createWheel } from '../wheel.js';
import { createBankWheel, BANK_COLORS } from '../bankwheel.js';
import { openLink } from '../tg.js';
import { section, list, row, button, seg, bar, empty, pill, toast, fail, sheet, closeSheet, countdown, clock, left, fmt, stars, tix, when } from '../ui.js';

let wheelId = 'daily';

export function render(nav, v) {
  // Банк прибрано з застосунку: старі посилання на нього ведуть до коліс.
  if (wheelId === 'bank') wheelId = 'daily';
  return [el('div', { class: 'h1' }, t('games.title')), wheels(nav), diceCard()];
}

// Ігри на зірки живуть у боті: Telegram сам кидає кубик з анімацією.
// У застосунку їх видно, але кинути не можна — натискання пояснює, де грати.
const DICE_TILES = [['dice', '🎲', '×5.2'], ['darts', '🎯', '×5.2'], ['basket', '🏀', '×2.3'], ['football', '⚽', '×2.3'], ['bowling', '🎳', '×5.2'], ['slots', '🎰', '×20']];
function diceCard() {
  const tiles = el('div', { class: 'game-tiles' }, DICE_TILES.map(([id, e, x]) =>
    el('button', { class: 'gtile', type: 'button', onclick: () => { haptic('light'); botOnly(e); } },
      el('div', { class: 'gt-e' }, e), el('div', { class: 'gt-t' }, t('dice.g.' + id)), el('div', { class: 'gt-x' }, t('dice.upTo', { x })),
      el('div', { class: 'gt-lock' }, '🤖 ' + t('dice.inBotShort')))));
  return [...section(t('games.dice'), tiles, t('dice.inBotSub'))];
}
function botOnly(emoji) {
  const bot = S.me.bot;
  sheet((s) => [
    el('div', { class: 'result' }, el('div', { class: 'big' }, emoji), el('div', { class: 't' }, t('dice.onlyBot')), el('div', { class: 's' }, t('dice.onlyBotSub'))),
    el('div', { class: 'stack mt12' },
      bot ? button(t('dice.openBot'), () => { s.close(); openLink('https://t.me/' + bot + '?start=games'); }) : null,
      button(t('common.ok'), () => s.close(), 'plain')),
  ]);
}

// ─── Колеса ──────────────────────────────────────────────────────────────
export function wheelTitle(id) { return t('wheel.' + id); }
function tierName(id) { const x = (S.me.tiers || []).find(q => q.id === id); return x ? x.emoji + ' ' + x.name : id; }
function tierImg(id) { const x = (S.me.tiers || []).find(q => q.id === id); return x && x.img; }

function wheels(nav) {
  const W = S.me.wheels.wheels;
  if (wheelId !== 'bank' && !W[wheelId]) wheelId = 'daily';
  const ids = ['daily', 'referral', 'paid'].filter(id => W[id]);
  const bk = S.me.bank || {};
  const tabs = el('div', { class: 'wheel-tabs' }, ids.map(id => {
    const w = W[id];
    const cost = id === 'bank' ? (bk.active && bk.status === 'open' ? stars(bk.stars) : '—')
      : id === 'daily' ? t('wheel.free') : id === 'referral' ? w.cost.tickets + '🎫' : (w.gifted ? t('wheel.gifted', { n: w.gifted }) : w.cost.stars + '⭐');
    return el('button', { class: 'wheel-tab' + (id === wheelId ? ' on' : ''), type: 'button', onclick: () => { wheelId = id; haptic('select'); nav.rerender(); } },
      el('div', { class: 'wt-t' }, id === 'bank' ? '🏦 ' + t('games.bank') : wheelTitle(id)), el('div', { class: 'wt-s' }, cost));
  }));
  if (wheelId === 'bank') { const body = el('div'); bankView(nav, body); return [tabs, body]; }
  return [tabs, wheelCard(nav, wheelId), riskCard(nav), fairRow(nav)];
}

export function wheelCard(nav, id, compact) {
  const w = S.me.wheels.wheels[id];
  const wheel = createWheel(w.segments, id);
  const hh = S.me.wheels.happyHour;
  const meta = el('div', { class: 'wheel-meta' });
  if (hh && hh.active) meta.appendChild(pill('🍀 ' + t('wheel.happy'), 'warn'));
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
        el('div', { class: 's' }, t('res.app', { id: r.applicationId }))));
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
let bankPoll = null, bankSpinning = false;
async function bankView(nav, body) {
  mount(body, empty(t('common.loading')));
  let b;
  try { b = await api.get('/bank'); } catch (e) { mount(body, empty(t('err.generic'))); return; }
  if (!body.isConnected) return;
  drawBank(nav, body, b);
  clearInterval(bankPoll);
  bankPoll = setInterval(async () => {
    if (!body.isConnected) { clearInterval(bankPoll); return; }
    if (bankSpinning || (document.activeElement && document.activeElement.tagName === 'INPUT')) return;
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
  const late = open && b.drawAt <= Date.now();
  const parts = [bankCard(b, () => bankView(nav, body))];
  if (open && !late) parts.push(...section(t('bank.bet'), el('div', { class: 'card pad' }, betForm(nav, body, b)), t('bank.betFoot', { w: b.ticketWeight, c: b.consolePer })));

  const ms = b.milestones;
  if (ms && ms.list && ms.list.length) {
    parts.push(...section(t('bank.milestones'), el('div', { class: 'card pad' },
      ms.next ? [el('div', { class: 'kv', style: { marginTop: 0 } }, el('span', null, t('bank.toNext', { n: fmt(ms.toNext), label: ms.next.label })), el('span', null, ms.nextPercent + '%')), el('div', { class: 'mt8' }, bar(ms.nextPercent, 'gold'))] : el('div', { class: 'ok-text' }, t('bank.allMs')),
      el('div', { class: 'gap8 mt12' }, ms.list.map(m => pill((m.reached ? '✓ ' : '') + m.at + ' → +' + m.bonus + '⭐', m.reached ? 'ok' : 'grey'))))));
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

// Банк стоїть над колесами, як у попередній версії: колесо з гравцями
// видно одразу, без переходу у вкладку. Кнопка веде до ставки й деталей.
function bankTeaser(nav) {
  if (!(S.me.bank && S.me.bank.active)) return null;
  const holder = el('div', { class: 'bank-teaser' });
  api.get('/bank').then((b) => {
    if (!b.active) return;
    const open = b.status === 'open', late = open && b.drawAt <= Date.now();
    const go = () => { wheelId = 'bank'; haptic('select'); nav.rerender(); };
    mount(holder, bankCard(b, () => nav.rerender(),
      button(open && !late ? t('bank.betNow') : t('bank.details'), go, open && !late ? '' : 'tinted')));
  }).catch(() => {});
  return holder;
}

function bankCard(b, onTimeUp, extra) {
  const open = b.status === 'open';
  const late = open && b.drawAt <= Date.now();
  const wheel = createBankWheel(b.sectors || [], b.id, t('common.you'));
  const status = el('div', { class: 'bank-live' + (open ? '' : ' done') },
    open ? (late ? t('bank.drawing') : [t('bank.drawIn') + ' ', countdown(b.drawAt, clock, onTimeUp)]) : t('bank.drawn'));
  const legend = el('div', { class: 'bank-legend' }, (b.sectors || []).slice(0, 10).map((s, i) =>
    el('span', { class: 'bl' + (s.me ? ' me' : '') }, el('i', { style: { background: BANK_COLORS[i % BANK_COLORS.length] } }), (s.me ? t('common.you') : s.name) + ' ', el('b', null, s.percent + '%'))),
    (b.sectors || []).length > 10 ? el('span', { class: 'bl' }, t('bank.more', { n: b.sectors.length - 10 })) : null);
  const winnerBox = el('div');
  const showWinner = () => {
    if (!b.winner) return;
    mount(winnerBox, el('div', { class: 'banner ' + (b.winner.me ? 'green' : 'gold') + ' mt12' }, el('div', { class: 'bi' }, b.winner.me ? '🏆' : '🎉'),
      el('div', { class: 'bm' }, el('div', { class: 'bt' }, b.winner.me ? t('bank.youWon') : t('bank.winner', { name: b.winner.name })),
        b.won ? el('div', { class: 'bs' }, stars(b.won.stars) + (b.won.tickets ? ' + ' + tix(b.won.tickets) : '')) : null)));
  };
  const card = el('div', { class: 'card pad bank-card' },
    el('div', { class: 'bank-top' }, el('div', { class: 'bank-title' }, '🏦 ' + t('bank.title')), status),
    el('div', { class: 'bank-pot' }, stars(b.prize.stars) + (b.prize.tickets ? ' + ' + tix(b.prize.tickets) : '')),
    el('div', { class: 'center muted' }, t('bank.potSub', { n: b.players })),
    wheel.el,
    (b.sectors || []).length ? legend : el('div', { class: 'center muted mt8' }, t('bank.first')),
    b.mine.weight > 0 ? el('div', { class: 'bank-mine' },
      el('div', null, t('bank.mineLine', { s: fmt(b.mine.stars), t: b.mine.tickets, w: fmt(b.mine.weight) })),
      el('div', null, t('bank.chance') + ': ', el('b', null, b.mine.chance + '%')),
      b.consolation ? el('div', { class: 'muted' }, t('bank.consLine', { n: b.consolation })) : null) : null,
    winnerBox,
    extra ? el('div', { class: 'mt12' }, extra) : null);
  // Розіграно: крутимо колесо до переможця (один раз), потім показуємо результат.
  if (!open && b.winner) {
    if (wheel.alreadySpun()) { wheel.spinToWinner(b.winner.uid); showWinner(); }
    else { bankSpinning = true; setTimeout(() => wheel.spinToWinner(b.winner.uid).then(() => { bankSpinning = false; haptic(b.winner.me ? 'success' : 'light'); showWinner(); refreshSoon(); }), 300); }
  }
  return card;
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
