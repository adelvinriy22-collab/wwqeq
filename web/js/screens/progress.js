// Прогрес: один досвід (XP) → рівень гравця, сезонний пас і ліга тижня.
// Плюс завдання дня, питання дня й партнерські завдання.
import { el, mount, img } from '../dom.js';
import { t } from '../i18n.js';
import * as api from '../api.js';
import { S, setBalance, refreshSoon, refresh } from '../state.js';
import { haptic, openLink, openInvoice } from '../tg.js';
import { section, list, row, button, seg, bar, empty, pill, toast, fail, sheet, countdown, left, fmt, stars, tix } from '../ui.js';

let view = 'pass';

export function render(nav, v) {
  if (v) view = v;
  if (!['pass', 'league', 'quests'].includes(view)) view = 'pass';
  const body = el('div');
  const out = [el('div', { class: 'h1' }, t('prog.title')), levelCard(), seg([['pass', t('prog.pass')], ['league', t('prog.league')], ['quests', t('prog.quests')]], view, (id) => { view = id; nav.rerender(); }), body];
  load(nav, body);
  return out;
}

async function load(nav, body) {
  const cached = S.cache.progress;
  if (cached && Date.now() - cached.at < 4000) return draw(nav, body, cached.data);
  if (!cached) mount(body, empty(t('common.loading')));
  else draw(nav, body, cached.data);
  try {
    const d = await api.get('/progress');
    S.cache.progress = { at: Date.now(), data: d };
    if (body.isConnected) draw(nav, body, d);
  } catch (e) { if (body.isConnected && !cached) mount(body, empty(t('err.generic'))); }
}
function reload(nav, body) { S.cache.progress = null; load(nav, body); }
function draw(nav, body, d) {
  if (view === 'pass') mount(body, passView(nav, body, d));
  else if (view === 'league') mount(body, leagueView(d));
  else mount(body, questsView(nav, body, d));
}

function levelCard() {
  const lv = S.me.progress.level;
  return el('div', { class: 'card pad' },
    el('div', { class: 'gap8', style: { flexWrap: 'nowrap' } },
      el('div', { style: { fontSize: '36px' } }, lv.e),
      el('div', { style: { flex: 1, minWidth: 0 } },
        el('div', { style: { fontWeight: 700, fontSize: '17px' } }, lv.t),
        el('div', { class: 'muted', style: { fontSize: '13px' } }, t('prog.levelN', { n: lv.n }) + ' · ' + fmt(lv.xp) + ' XP')),
      el('button', { class: 'btn small tinted', type: 'button', onclick: xpHelp }, t('prog.howXp'))),
    el('div', { class: 'mt12' }, bar(lv.pct)),
    el('div', { class: 'kv' }, el('span', null, lv.next ? t('prog.toNext', { n: fmt(lv.next.left), t: lv.next.e + ' ' + lv.next.t }) : t('prog.max')),
      lv.next && rewardText(lv.next.reward) ? el('span', { class: 'ok-text', style: { fontWeight: 600 } }, rewardText(lv.next.reward)) : null),
    lv.perks ? el('div', { class: 'gap8 mt8' }, perkPills(lv.perks)) : null,
    el('div', { class: 'mt12' }, button(t('lvl.all'), levelsSheet, 'tinted')));
}

// Нагорода за рівень і що він відкриває — однаково в картці, сходинках і боті.
export function rewardText(rw) {
  if (!rw) return '';
  return [rw.tickets ? '+' + rw.tickets + '🎫' : null, rw.stars ? '+' + rw.stars + '⭐' : null].filter(Boolean).join(' ');
}
function unlockText(u) {
  if (!u) return '';
  const out = [];
  if (u.withdrawFee != null) out.push(t('perk.fee', { f: u.withdrawFee }));
  if (u.topupBonus != null) out.push(t('perk.topup', { p: u.topupBonus }));
  if (u.chatBonus != null) out.push(t('perk.chat', { n: u.chatBonus }));
  return out.join(' · ');
}
function perkPills(p) {
  return [
    pill('💸 ' + t('perk.fee', { f: p.withdrawFee }), p.withdrawFee < 5 ? 'ok' : 'grey'),
    p.topupBonus ? pill('⭐ ' + t('perk.topup', { p: p.topupBonus }), 'ok') : null,
    p.chatBonus ? pill('🎁 ' + t('perk.chat', { n: p.chatBonus }), 'ok') : null,
  ];
}

async function levelsSheet() {
  let d = S.cache.progress && S.cache.progress.data;
  if (!d || !d.levels) { try { d = await api.get('/progress'); S.cache.progress = { at: Date.now(), data: d }; } catch (e) { fail(e); return; } }
  const cur = S.me.progress.level.n;
  sheet(() => [
    el('h3', null, t('lvl.title')),
    el('p', null, t('lvl.lead')),
    list(d.levels.map(L => row({
      icon: L.e,
      title: L.t + ' · ' + t('prog.levelN', { n: L.n }) + (L.n === cur ? ' · ' + t('lvl.you') : ''),
      sub: [rewardText(L.reward), unlockText(L.unlocks)].filter(Boolean).join(' · ') || null,
      value: L.reached ? '✅' : fmt(L.at) + ' XP',
    }))),
    el('p', { class: 'mt12 muted' }, t('lvl.foot')),
  ]);
}

function xpHelp() {
  const d = S.cache.progress && S.cache.progress.data;
  const src = (d && d.xpSources) || {};
  const rates = (d && d.xpRates) || {};
  sheet(() => [
    el('h3', null, t('xp.title')),
    el('p', null, t('xp.lead')),
    list(
      row({ icon: '🎰', title: t('xp.spin', { n: (src.spin || {}).per || 10 }), sub: t('xp.cap', { n: (src.spin || {}).dayCap || 80 }) }),
      row({ icon: '⭐', title: t('xp.wager', { a: rates.paidSpinPerStar || 3, b: rates.gamePerStar || 2, c: rates.bankPerStar || 1 }), sub: t('xp.cap', { n: (src.wager || {}).dayCap || 450 }) }),
      row({ icon: '🏦', title: t('xp.bank', { n: (src.bank || {}).per || 15 }) }),
      row({ icon: '👥', title: t('xp.friend', { n: (src.friend || {}).per || 150 }) }),
      row({ icon: '💳', title: t('xp.deposit', { n: (src.deposit || {}).per || 100 }) }),
      row({ icon: '📋', title: t('xp.quest'), sub: t('xp.cap', { n: (src.quest || {}).dayCap || 300 }) }),
      row({ icon: '💬', title: t('xp.chat'), sub: t('xp.cap', { n: (src.chat || {}).dayCap || 200 }) })),
    el('p', { class: 'mt12' }, t('xp.where')),
    button(t('lvl.all'), () => levelsSheet(), 'tinted'),
  ]);
}

// ─── Пас ────────────────────────────────────────────────────────────────
function rewardIcon(type) { return { stars: '⭐', tickets: '🎫', freeSpin: '🎰', paidSpin: '💫', final: '🧸' }[type] || '🎁'; }

function passView(nav, body, d) {
  const p = d.pass;
  const out = [];
  out.push(...section(t('pass.season', { s: p.season }), el('div', { class: 'card pad' },
    el('div', { class: 'kv', style: { marginTop: 0 } }, el('span', { style: { color: 'var(--text)', fontWeight: 600, fontSize: '15px' } }, t('pass.level', { n: p.level, m: p.maxLevel })), el('span', null, t('pass.ends') + ' ', countdown(p.endsAt, left))),
    el('div', { class: 'mt8' }, bar(p.xpInLevel / p.levelXp * 100)),
    el('div', { class: 'kv' }, el('span', null, p.toNext ? t('pass.toNext', { n: p.toNext }) : t('prog.max')), el('span', null, fmt(p.xp) + ' XP')),
    p.claimable ? el('div', { class: 'mt12' }, button(t('pass.claimAll', { n: p.claimable }), () => claim(nav, body, 'all'), 'ok')) : null)));

  if (!p.premium) {
    out.push(el('div', { class: 'banner gold mt12' }, el('div', { class: 'bi' }, '💎'),
      el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('pass.premT')), el('div', { class: 'bs' }, t('pass.premS', { n: p.xtrBonusLevels })))));
    out.push(el('div', { class: 'card pad' }, el('div', { class: 'stack' },
      button(t('pass.buyXtr', { n: p.priceXtr }), async () => {
        try {
          const r = await api.post('/pass/invoice');
          const st = await openInvoice(r.link);
          if (st === 'paid') { toast(t('pass.bought'), 'success'); setTimeout(() => { refresh().catch(() => {}); reload(nav, body); }, 1500); }
          else if (st === 'failed') toast(t('pay.failed'), 'error');
        } catch (e) { fail(e); }
      }),
      button(t('pass.buyBal', { n: p.price }), async () => {
        try { await api.post('/pass/buy'); toast(t('pass.bought'), 'success'); refreshSoon(); reload(nav, body); } catch (e) { fail(e); }
      }, 'tinted'))));
  } else {
    out.push(el('div', { class: 'banner green mt12' }, el('div', { class: 'bi' }, '💎'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('pass.premOn')))));
  }

  const cell = (lv, rw, track, open) => {
    if (!rw) return el('div', { class: 'track-cell' + (track === 'prem' ? ' prem' : '') }, el('span', { class: 'muted' }, '—'));
    let right;
    if (rw.claimed) right = pill('✓', 'ok');
    else if (!open) right = el('span', { class: 'muted' }, '🔒');
    else if (track === 'prem' && !p.premium) right = el('span', { class: 'muted' }, '💎');
    else right = el('button', { class: 'btn small ok', type: 'button', onclick: () => claim(nav, body, lv, track) }, t('pass.take'));
    const label = /[⭐🎫]/u.test(rw.label) ? rw.label : rewardIcon(rw.type) + ' ' + rw.label;
    return el('div', { class: 'track-cell' + (track === 'prem' ? ' prem' : '') }, el('div', { class: 'rw' }, label), right);
  };
  out.push(el('div', { class: 'track-head mt16' }, el('div'), el('div', null, t('pass.free')), el('div', null, '💎 ' + t('pass.prem'))));
  out.push(el('div', { class: 'track' }, p.rewards.map(r => el('div', { class: 'track-row' + (r.open ? ' open' : '') },
    el('div', { class: 'track-lv' }, String(r.level)), cell(r.level, r.free, 'free', r.open), cell(r.level, r.prem, 'prem', r.open)))));
  out.push(el('div', { class: 'sec-foot' }, t('pass.foot', { n: p.levelXp })));
  return out;
}

async function claim(nav, body, level, track) {
  try {
    const r = await api.post('/pass/claim', { level, track });
    setBalance(r.balance);
    haptic('success');
    const got = (r.results || []).map(x => x.label).join(', ');
    toast(got ? t('pass.got', { r: got }) : t('pass.nothing'), got ? 'success' : null);
    if (S.cache.progress) S.cache.progress.data.pass = r.state;
    refreshSoon();
    draw(nav, body, S.cache.progress.data);
  } catch (e) { fail(e); }
}

// ─── Ліга ───────────────────────────────────────────────────────────────
function leagueView(d) {
  const L = d.league;
  if (!L.enabled) return el('div', { class: 'card pad center' }, el('div', { style: { fontSize: '44px' } }, '🏆'), el('div', { class: 'mt8', style: { fontWeight: 600 } }, t('league.off')), el('div', { class: 'muted mt8' }, t('league.offText')));
  const me = L.me;
  return [
    el('div', { class: 'card' },
      el('div', { class: 'hero' }, el('div', { class: 'sub' }, t('league.you')), el('div', { class: 'big' }, me.rank ? '#' + me.rank : '—'),
        el('div', { class: 'sub' }, fmt(me.xp) + ' XP' + (me.gap ? ' · ' + t('league.gap', { n: fmt(me.gap) }) : ''))),
      el('div', { class: 'stat-grid' },
        el('div', null, el('b', null, String(L.players)), el('span', null, t('league.players'))),
        el('div', null, el('b', null, String(L.minXp)), el('span', null, t('league.minXp'))),
        el('div', null, el('b', null, countdown(L.endsAt, left)), el('span', null, t('league.ends'))))),
    me.excluded ? el('div', { class: 'sec-foot' }, t('league.excluded')) : null,
    ...section(t('league.top'), L.top.length ? list(L.top.map(r => row({
      icon: r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : String(r.rank), title: r.name + (r.me ? ' · ' + t('common.you') : ''),
      sub: r.prize ? '🎁 ' + r.prize : r.locked ? t('league.locked', { n: L.minXp }) : null, value: fmt(r.xp) + ' XP', strong: r.me,
    }))) : el('div', { class: 'card' }, empty(t('league.empty')))),
    ...section(t('league.rewards'), list(L.rewards.map(q => row({ icon: '🏅', title: t('league.place', { p: q.place }), value: q.text }))),
      t('league.foot', { x: L.participationXp, t: L.participationTickets })),
  ];
}

// ─── Завдання ───────────────────────────────────────────────────────────
function questsView(nav, body, d) {
  const out = [];
  const dq = d.daily;
  out.push(...section(t('quest.daily'), list(dq.items.map(q => row({
    icon: q.done ? '✅' : '🎯', iconClass: q.done ? 'c-green' : '',
    title: q.title, sub: q.need > 1 ? q.progress + '/' + q.need : null,
    value: q.done ? '+' + dq.reward.tickets + '🎫' : null,
    onClick: q.done ? null : () => goQuest(nav, q.go),
  }))), [t('quest.dailyFoot', { t: dq.allReward.tickets, x: dq.allReward.xp }), ' · ', t('quest.new') + ' ', countdown(dq.endsAt, left)]));

  const qz = d.quiz;
  const qBox = el('div', { class: 'card pad' });
  const drawQuiz = (qv) => {
    mount(qBox, el('div', { style: { fontWeight: 600 } }, qv.question),
      el('div', { class: 'stack mt12' }, qv.answers.map((a, i) => {
        let cls = 'tinted';
        if (qv.answered) cls = i === qv.correct ? 'ok' : (qv.right === false && qv.chosen === i ? 'danger' : 'tinted');
        const b = el('button', { class: 'btn ' + cls, type: 'button', disabled: qv.answered }, a);
        if (!qv.answered) b.addEventListener('click', async () => {
          haptic('light');
          try {
            const r = await api.post('/quiz/answer', { choice: i });
            haptic(r.right ? 'success' : 'error');
            drawQuiz({ ...qv, answered: true, right: r.right, correct: r.correct, chosen: i });
            toast(r.right ? t('quiz.right') : t('quiz.wrong'));
            S.cache.progress = null; refreshSoon();
          } catch (e) { fail(e); }
        });
        return b;
      })),
      el('div', { class: 'sec-foot', style: { margin: '10px 0 0' } }, qv.answered ? (qv.right ? t('quiz.gotSpin') : t('quiz.tomorrow')) : t('quiz.reward')));
  };
  drawQuiz(qz);
  out.push(...section(t('quiz.title'), qBox));

  const P = d.partner;
  if (P && P.on) {
    const st = P.status;
    out.push(...section(t('quest.secret'), el('div', { class: 'card pad' },
      el('div', { style: { fontWeight: 600 } }, '🔐 ' + P.name),
      el('div', { class: 'muted mt8' }, t('quest.secretText')),
      el('div', { class: 'gap8 mt8' }, pill('+' + P.reward.stars + '⭐'), pill('+' + P.reward.tickets + '🎫'), pill('+' + P.reward.xp + ' XP'), P.early ? pill('🔥 ×2 · ' + t('quest.earlyLeft', { n: P.earlyLeft }), 'warn') : null),
      st === 'done' ? el('div', { class: 'ok-text mt12' }, '✅ ' + t('quest.done'))
        : st === 'pending' ? el('div', { class: 'mt12 muted' }, '⏳ ' + t('quest.pending'))
          : el('div', { class: 'stack mt12' },
            st === 'rejected' ? el('div', { class: 'bad-text' }, t('quest.rejected')) : null,
            button(t('quest.open'), () => openLink(P.link), 'tinted'),
            button(t('quest.check'), async () => {
              try { await api.post('/partner/claim'); toast(t('quest.sent'), 'success'); reload(nav, body); refreshSoon(); } catch (e) { fail(e); }
            })))));
  }

  if (d.tasks && d.tasks.length) {
    out.push(...section(t('quest.partner'), list(d.tasks.map(tk => row({
      icon: tk.done ? '✅' : '🤝', title: tk.label,
      sub: tk.done ? t('quest.done') : [tk.reward ? '+' + tk.reward + '⭐' : null, tk.bears ? '🧸×' + tk.bears : null].filter(Boolean).join(' · '),
      onClick: tk.done ? null : () => taskSheet(nav, body, tk),
    })))));
  }
  return out;
}

function goQuest(nav, target) {
  const [tab, sub] = String(target || '').split(':');
  if (tab === 'wheel') { import('./games.js').then(() => nav.go('games', 'wheels')); return; }
  if (tab === 'games') return nav.go('games', 'dice');
  if (tab === 'bank') return nav.go('games', 'bank');
  if (tab === 'quests') return;
  nav.go(tab || 'home', sub);
}

function taskSheet(nav, body, tk) {
  sheet((s) => {
    const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      try {
        const photo = await shrink(f);
        await api.post('/tasks/proof', { taskId: tk.id, photo });
        toast(t('quest.proofSent'), 'success');
        s.close();
      } catch (e) { fail(e); }
    });
    return [
      el('h3', null, tk.label),
      el('p', null, tk.proof ? t('quest.proofHow') : t('quest.managerHow', { c: tk.contact })),
      el('div', { class: 'stack' },
        tk.link ? button(t('quest.open'), () => openLink(tk.link), 'tinted') : null,
        tk.proof ? button(t('quest.sendProof'), () => file.click()) : button(t('quest.writeManager'), () => openLink('https://t.me/' + String(tk.contact || '').replace('@', ''))),
        file),
    ];
  });
}

// Зменшити скрін перед надсиланням (до 1280 px, JPEG).
function shrink(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read'));
    r.onload = () => {
      const im = new Image();
      im.onerror = () => resolve(r.result);
      im.onload = () => {
        const k = Math.min(1, 1280 / Math.max(im.width, im.height));
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      im.src = r.result;
    };
    r.readAsDataURL(f);
  });
}
