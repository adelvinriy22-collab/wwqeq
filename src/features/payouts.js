// ==========================================================================
// АВТОВИПЛАТА ЗАЯВОК: бот сам надсилає подарунок Telegram і одразу підтверджує.
//
//   • Заявка на подарунок із каталогу (🧸 🎁 🚀 🏆 💝 🌹 …) — цей подарунок.
//   • Старий вивід зірок (stars_payout, будь-яка сума) — набором подарунків
//     рівно на цю суму (100/50/25/15), до PLAN_MAX штук; інакше — лише вручну.
//   • NFT, Premium тощо — лише вручну.
// Надсилає бот (sendGift із балансу зірок бота); не вийшло, а акаунт власника
// підключено (/tg_login) — пробуємо від акаунта. Частково надіслане запам'ятовується
// (a.paidGifts), тож повторна спроба не надішле те саме вдруге.
// ==========================================================================
const store = require('../store');
const users = require('../core/users');
const tggifts = require('./tggifts');
const usergifts = require('./usergifts');
const applications = require('./applications');

const PLAN_MAX = 4;
// Номінали для збирання суми: найдешевший подарунок кожної ціни.
const DENOMS = [[100, 'trophy'], [50, 'rocket'], [25, 'gift'], [15, 'bear']];

// Набір подарунків рівно на суму (найменше штук) або null.
function giftsForSum(sum) {
  const best = { list: null };
  (function go(left, from, acc) {
    if (left === 0) { if (!best.list || acc.length < best.list.length) best.list = acc.slice(); return; }
    if (acc.length >= PLAN_MAX || (best.list && acc.length + 1 >= best.list.length)) return;
    for (let i = from; i < DENOMS.length; i++) {
      if (DENOMS[i][0] > left) continue;
      acc.push(DENOMS[i][1]); go(left - DENOMS[i][0], i, acc); acc.pop();
    }
  })(Math.round(Number(sum) || 0), 0, []);
  return best.list;
}

// Що надсилати за заявку. → масив id подарунків або null (лише вручну).
function planFor(a) {
  if (!a || a.status !== 'pending') return null;
  if (a.tierId === 'stars_payout') return giftsForSum(a.payoutStars);
  return tggifts.canSend(a.tierId) ? [a.tierId] : null;
}
const payable = (a) => !!planFor(a);

const inFlight = new Set();   // id заявок, що зараз виплачуються (подвійне натискання)

// Надіслати подарунок(и) і підтвердити заявку. → { ok, sent, via, error, partial }
async function pay(id) {
  const a = store.getApplication(id);
  if (!a) return { ok: false, error: 'not_found' };
  if (a.status !== 'pending') return { ok: false, error: 'not_pending', status: a.status };
  const plan = planFor(a);
  if (!plan) return { ok: false, error: 'manual_only' };
  // Прапорець — до першого await.
  if (inFlight.has(a.id)) return { ok: false, error: 'busy' };
  inFlight.add(a.id);
  try {
    const u = users.get(a.uid) || {};
    const text = '🎁 Виплата за заявкою #' + a.id + ' · StarForge';
    const done = (a.paidGifts || []).slice();
    const todo = plan.slice();
    for (const g of done) { const i = todo.indexOf(g); if (i !== -1) todo.splice(i, 1); }
    const via = [];
    for (const g of todo) {
      let r = await tggifts.send(a.uid, g, text);
      let how = 'bot';
      if (!r.ok && usergifts.accountReady()) {
        const r2 = await usergifts.send(u.username ? '@' + u.username : a.uid, g, text);
        if (r2.ok) { r = r2; how = 'account'; } else r = { ...r, error: 'бот: ' + r.error + ' · акаунт: ' + r2.error };
      }
      if (!r.ok) {
        a.paidGifts = done; a.payError = String(r.error || '').slice(0, 300); store.save();
        return { ok: false, error: 'send_failed', detail: a.payError, lowBalance: !!r.lowBalance, partial: done.length, plan };
      }
      done.push(g); via.push(how);
      a.paidGifts = done; store.save();
    }
    a.autoSent = true;
    a.paidVia = via.includes('account') ? (via.includes('bot') ? 'mixed' : 'account') : 'bot';
    delete a.payError;
    const r = applications.approve(a.id);
    return { ok: r.ok, sent: done, via: a.paidVia, app: a };
  } finally {
    inFlight.delete(a.id);
  }
}

// Найновіші невиплачені заявки, які бот може виплатити сам.
function newestPayable(n) {
  return store.listApplications('pending').filter(payable).sort((x, y) => y.createdAt - x.createdAt).slice(0, n);
}

module.exports = { pay, planFor, payable, giftsForSum, newestPayable, PLAN_MAX };
