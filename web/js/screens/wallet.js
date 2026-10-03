// Гаманець: баланс, поповнення Telegram Stars, вивід, обмін білетів,
// магазин призів, промокод, історія всіх рухів.
import { el, mount, img } from '../dom.js';
import { t } from '../i18n.js';
import * as api from '../api.js';
import { S, setBalance, refreshSoon, refresh } from '../state.js';
import { openInvoice, confirm, haptic } from '../tg.js';
import { section, list, row, button, empty, pill, toast, fail, sheet, fmt, stars, tix, when } from '../ui.js';

export function render(nav, v) {
  const body = el('div');
  load(nav, body);
  // Одноразові переходи (з бота чи іншого екрана): відкрити й забути.
  if (v === 'topup' || v === 'withdraw') S.route.view = null;
  if (v === 'topup') setTimeout(() => topup(nav), 50);
  if (v === 'withdraw') setTimeout(() => withdraw(nav, body), 50);
  const b = S.me.balance;
  return [
    el('div', { class: 'h1' }, t('wallet.title')),
    el('div', { class: 'card' },
      el('div', { class: 'hero' }, el('div', { class: 'sub' }, t('wallet.balance')), el('div', { class: 'big' }, stars(b.stars)), el('div', { class: 'sub' }, tix(b.tickets))),
      el('div', { class: 'actions' },
        action('＋', t('wallet.topup'), () => topup(nav)),
        action('↑', t('wallet.withdraw'), () => withdraw(nav, body)),
        action('⇄', t('wallet.exchange'), () => exchange(nav, body)))),
    body,
  ];
}

function action(icon, label, fn) {
  return el('button', { class: 'action', type: 'button', onclick: () => { haptic('light'); fn(); } }, el('span', { class: 'ai' }, icon), el('span', null, label));
}

let data = null;
async function load(nav, body) {
  if (!data) mount(body, empty(t('common.loading')));
  else draw(nav, body);
  try { data = await api.get('/wallet'); if (body.isConnected) draw(nav, body); } catch (e) { if (body.isConnected && !data) mount(body, empty(t('err.generic'))); }
}

function draw(nav, body) {
  const d = data;
  const out = [];
  out.push(el('div', { class: 'banner green mt12' }, el('div', { class: 'bi' }, '⚡'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('wd.auto')), el('div', { class: 'bs' }, t('wd.autoS')))));
  // Магазин
  const sh = d.shop;
  out.push(...section(t('shop.title'), el('div', null,
    !sh.unlocked ? el('div', { class: 'banner' }, el('div', { class: 'bi' }, '🔒'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('shop.locked')), el('div', { class: 'bs' }, t('shop.lockedS', { n: sh.unlockSpins })))) : null,
    el('div', { class: 'grid2' }, sh.items.map(it => el('button', { class: 'tile', type: 'button', disabled: !sh.unlocked, onclick: () => buy(nav, body, it) },
      img(it.img) || el('div', { class: 'em' }, it.emoji), el('div', { class: 'tt' }, it.name), el('div', { class: 'ts' }, stars(it.price)))))),
  t('shop.foot')));
  // Промокод
  const code = el('input', { type: 'text', placeholder: t('promo.ph'), autocapitalize: 'characters', maxlength: 32 });
  out.push(...section(t('promo.title'), el('div', { class: 'card pad' },
    el('div', { class: 'btns' }, el('div', { class: 'field' }, code),
      button(t('promo.apply'), async () => {
        const c = code.value.trim();
        if (!c) return;
        try { const r = await api.post('/promo', { code: c }); toast(t('promo.ok', { w: r.what || '' }), 'success'); code.value = ''; refreshSoon(); nav.rerender(); }
        catch (e) { fail(e); }
      }, 'auto')))));
  // Історія
  out.push(...section(t('hist.title'), d.history.length ? list(d.history.slice(0, 40).map(h => row({
    icon: h.stars && h.tickets ? '🔁' : h.tickets ? '🎫' : '⭐', title: t('why.' + h.reason) === 'why.' + h.reason ? h.reason : t('why.' + h.reason),
    sub: when(h.at) + (h.meta && h.meta.note ? ' · ' + h.meta.note : ''),
    value: [h.stars ? (h.stars > 0 ? '+' : '') + fmt(h.stars) + '⭐' : null, h.tickets ? (h.tickets > 0 ? '+' : '') + h.tickets + '🎫' : null].filter(Boolean).join(' '),
  }))) : el('div', { class: 'card' }, empty(t('hist.empty'))), t('hist.foot')));
  mount(body, out);
}

async function buy(nav, body, it) {
  if (!(await confirm(t('shop.confirm', { n: it.name, p: it.price })))) return;
  try { const r = await api.post('/shop/buy', { item: it.id }); setBalance(r.balance); toast(t('shop.bought', { id: r.applicationId }), 'success'); refreshSoon(); nav.rerender(); }
  catch (e) { fail(e); }
}

// ─── Поповнення ─────────────────────────────────────────────────────────
function topup(nav) {
  const info = S.me.topup;
  let amount = info.presets[1] || info.presets[0];
  sheet((s) => {
    const input = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: info.max, value: String(amount) });
    const bonus = el('div', { class: 'kv' });
    const upd = () => {
      amount = Math.floor(Number(input.value) || 0);
      bonus.textContent = '';
      // +10% на перші поповнення або постійний бонус рівня — діє більший.
      const lvl = info.levelBonusPercent || 0;
      const first = info.bonusLeft ? info.bonusPercent : 0;
      const pct = Math.max(first, lvl);
      bonus.append(el('span', null, !pct ? '' : first >= lvl ? t('topup.bonus', { p: first, n: info.bonusLeft }) : t('topup.levelBonus', { p: lvl })),
        el('span', null, pct && amount ? '+' + fmt(Math.round(amount * pct) / 100) + '⭐' : ''));
      presets.querySelectorAll('.preset').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === amount));
    };
    const presets = el('div', { class: 'presets' }, info.presets.map(n => el('button', { class: 'preset', type: 'button', dataset: { v: n }, onclick: () => { input.value = String(n); upd(); } }, n + '⭐')));
    input.addEventListener('input', upd);
    setTimeout(upd);
    return [
      el('h3', null, t('topup.title')),
      el('p', null, t('topup.lead')),
      presets,
      el('div', { class: 'label' }, t('topup.custom')),
      el('div', { class: 'field' }, input, el('span', { class: 'unit' }, '⭐')),
      bonus,
      el('div', { class: 'mt12' }, button(t('topup.pay'), async () => {
        if (!amount || amount < 1) { toast(t('err.bad_amount')); return; }
        try {
          const r = await api.post('/wallet/topup', { amount });
          const st = await openInvoice(r.link);
          if (st === 'paid') {
            s.close(); toast(t('topup.paid'), 'success');
            setTimeout(() => refresh().then(() => nav.rerender()).catch(() => {}), 1500);
          } else if (st === 'failed') toast(t('pay.failed'), 'error');
        } catch (e) { fail(e); }
      })),
    ];
  });
}

// ─── Вивід ──────────────────────────────────────────────────────────────
function withdraw(nav, body) {
  const w = (data && data.withdraw) || S.me.withdraw;
  sheet((s) => {
    const input = el('input', { type: 'number', inputmode: 'numeric', min: w.min, value: String(Math.max(w.min, w.maxPayout || 0)) });
    const calc = el('div', { class: 'kv' });
    const upd = () => {
      const p = Math.floor(Number(input.value) || 0);
      const cost = Math.ceil(p * (1 + w.feePercent / 100));
      calc.textContent = '';
      calc.append(el('span', null, t('wd.cost', { c: fmt(cost), f: fmt(cost - p) })), el('span', null, t('wd.max', { m: w.maxPayout })));
    };
    input.addEventListener('input', upd);
    upd();
    const reqs = list(
      row({ icon: w.haveRefs >= w.needRefs ? '✅' : '▫️', title: t('wd.reqRefs', { n: w.needRefs }), value: w.haveRefs + '/' + w.needRefs }),
      row({ icon: w.hasUsername ? '✅' : '▫️', title: t('wd.reqUser'), sub: w.hasUsername ? null : t('wd.reqUserS') }),
      w.needSub ? row({ icon: w.hasSub ? '✅' : '▫️', title: t('wd.reqSub', { c: w.needSub }) }) : null,
      row({ icon: w.maxPayout >= w.min ? '✅' : '▫️', title: t('wd.reqMin', { n: w.min }) }));
    return [
      el('h3', null, t('wd.title')),
      w.blocked ? el('div', { class: 'banner red' }, el('div', { class: 'bi' }, '🛠'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('wd.blocked')))) : null,
      el('p', null, t('wd.lead', { f: w.feePercent })),
      el('div', { class: 'banner green' }, el('div', { class: 'bi' }, '⚡'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('wd.auto')), el('div', { class: 'bs' }, t('wd.autoS')))),
      w.baseFeePercent != null && w.feePercent < w.baseFeePercent ? el('div', { class: 'banner green' }, el('div', { class: 'bi' }, '🏅'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('wd.levelFee', { f: w.feePercent, b: w.baseFeePercent })))) : null,
      reqs,
      el('div', { class: 'label' }, t('wd.amount')),
      el('div', { class: 'field' }, input, el('span', { class: 'unit' }, '⭐')),
      calc,
      el('div', { class: 'mt12' }, button(t('wd.send'), async () => {
        const p = Math.floor(Number(input.value) || 0);
        if (!(await confirm(t('wd.confirm', { p, c: Math.ceil(p * (1 + w.feePercent / 100)) })))) return;
        try { const r = await api.post('/wallet/withdraw', { amount: p }); setBalance(r.balance); s.close(); toast(t('wd.done', { id: r.applicationId }), 'success'); refreshSoon(); nav.rerender(); }
        catch (e) { fail(e); }
      })),
    ];
  });
}

// ─── Обмін ──────────────────────────────────────────────────────────────
// Зворотний обмін: зірки → білети.
function buyTickets(nav, body) {
  const per = ((data && data.exchange) || {}).buyPerStar || 10;
  const have = Math.floor(S.me.balance.stars || 0);
  sheet((s) => {
    let n = Math.max(1, Math.min(have, 1));
    const val = el('div', { class: 'result' });
    const upd = () => { mount(val, el('div', { class: 'big' }, n + '⭐ → ' + n * per + '🎫'), el('div', { class: 's' }, t('bt.rate', { t: per }))); };
    upd();
    const step = (d) => { n = Math.max(1, Math.min(Math.max(1, have), n + d)); upd(); };
    return [
      el('div', { class: 'btns' }, button(t('ex.toStars'), () => { s.close(); exchange(nav, body); }, 'tinted'), button(t('ex.toTickets'), () => {})),
      el('h3', { class: 'mt12' }, t('bt.title')),
      el('p', null, t('bt.have', { n: have })),
      val,
      el('div', { class: 'btns mt8' }, button('−', () => step(-1), 'tinted'), button('+', () => step(1), 'tinted'), button('+10', () => step(10), 'tinted')),
      el('div', { class: 'mt12' }, button(t('bt.go'), async () => {
        try { const r = await api.post('/wallet/buy-tickets', { stars: n }); setBalance(r.balance, r.ticketsLeft); s.close(); toast(t('bt.done', { t: r.tickets }), 'success'); refreshSoon(); nav.rerender(); }
        catch (e) { fail(e); }
      })),
    ];
  });
}

function exchange(nav, body) {
  const ex = (data && data.exchange) || { tickets: 10, stars: 2 };
  const have = S.me.balance.tickets;
  const maxN = Math.floor(have / ex.tickets) * ex.tickets;
  sheet((s) => {
    let n = maxN || ex.tickets;
    const val = el('div', { class: 'result' });
    const upd = () => { mount(val, el('div', { class: 'big' }, n + '🎫 → ' + fmt(n / ex.tickets * ex.stars) + '⭐'), el('div', { class: 's' }, t('ex.rate', { t: ex.tickets, s: ex.stars }))); };
    upd();
    const step = (d) => { n = Math.max(ex.tickets, Math.min(Math.max(ex.tickets, maxN), n + d * ex.tickets)); upd(); };
    return [
      el('div', { class: 'btns' }, button(t('ex.toStars'), () => {}), button(t('ex.toTickets'), () => { s.close(); buyTickets(nav, body); }, 'tinted')),
      el('h3', { class: 'mt12' }, t('ex.title')),
      el('p', null, t('ex.have', { n: have })),
      val,
      el('div', { class: 'btns mt8' }, button('−', () => step(-1), 'tinted'), button('+', () => step(1), 'tinted'), button(t('ex.all'), () => { n = Math.max(ex.tickets, maxN); upd(); }, 'tinted')),
      el('div', { class: 'mt12' }, button(t('ex.go'), async () => {
        try { const r = await api.post('/wallet/exchange', { tickets: n }); setBalance(r.balance, r.ticketsLeft); s.close(); toast(t('ex.done', { s: fmt(r.stars) }), 'success'); refreshSoon(); nav.rerender(); }
        catch (e) { fail(e); }
      })),
    ];
  });
}
