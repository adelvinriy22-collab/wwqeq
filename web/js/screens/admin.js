// Адмін-панель (лише для адмінів; сервер перевіряє права на кожен запит).
// Внутрішній інструмент — лише українською.
import { el, mount } from '../dom.js';
import * as api from '../api.js';
import { confirm } from '../tg.js';
import { section, list, row, button, seg, empty, pill, toast, fail, sheet, toggleRow, fmt, stars, tix, when, countdown, left } from '../ui.js';

let tab = 'overview';

export function render(nav) {
  const body = el('div');
  const pick = (id) => { tab = id; draw(nav, body, wrap); };
  const wrap = el('div');
  const draw = (n, b) => {
    mount(wrap, seg([['overview', 'Огляд'], ['apps', 'Заявки'], ['user', 'Гравець'], ['promo', 'Промо'], ['ops', 'Керування']], tab, pick), body);
    ({ overview, apps, user, promo, ops })[tab](nav, body);
  };
  draw(nav, body);
  return wrap;
}

async function overview(nav, body) {
  mount(body, empty('Завантаження…'));
  let o;
  try { o = await api.get('/admin/overview'); } catch (e) { mount(body, empty('Помилка: ' + e.code)); return; }
  mount(body,
    el('div', { class: 'card' }, el('div', { class: 'stat-grid' },
      el('div', null, el('b', null, fmt(o.users)), el('span', null, 'гравців')),
      el('div', null, el('b', null, fmt(o.active24)), el('span', null, 'активні 24 год')),
      el('div', null, el('b', null, fmt(o.newToday)), el('span', null, 'нових сьогодні')),
      el('div', null, el('b', null, fmt(o.balances.stars)), el('span', null, '⭐ на балансах')),
      el('div', null, el('b', null, fmt(o.balances.tickets)), el('span', null, '🎫 на балансах')),
      el('div', null, el('b', null, fmt(o.deposited)), el('span', null, '⭐ поповнено')))),
    ...section('Черга', list(
      row({ icon: '📦', title: 'Заявок у черзі', value: String(o.pending), strong: true, onClick: () => { tab = 'apps'; nav.rerender(); } }),
      row({ icon: '💸', title: 'До виплати зірками', value: stars(o.pendingPayout) }),
      ...Object.entries(o.pendingBySource).map(([k, n]) => row({ title: k, value: String(n) })))),
    ...section('Стан', list(
      row({ icon: '🏦', title: 'Банк', sub: o.bank ? ['розіграш через ', countdown(o.bank.drawAt, left)] : (o.bankAuto.enabled ? 'авто щодня о ' + o.bankAuto.hour + ':00' : 'не запущено'), value: o.bank ? stars(o.bank.pot) + ' · ' + o.bank.players : null }),
      row({ icon: '🛠', title: 'Техроботи', value: { off: 'вимкнено', withdraw: 'лише вивід', full: 'повні' }[o.maintenance.mode] }),
      row({ icon: '🏆', title: 'Ліга', value: o.league ? 'увімкнена' : 'вимкнена' }),
      row({ icon: '🔔', title: 'Сповіщення про спіни', value: o.spinNotify ? 'так' : 'ні' }))));
}

let appStatus = 'pending';
async function apps(nav, body) {
  mount(body, empty('Завантаження…'));
  let r;
  try { r = await api.get('/admin/apps?status=' + appStatus + '&limit=150'); } catch (e) { mount(body, empty('Помилка: ' + e.code)); return; }
  const stSeg = seg([['pending', 'Черга'], ['approved', 'Видані'], ['rejected', 'Відхилені']], appStatus, (s) => { appStatus = s; apps(nav, body); });
  mount(body, stSeg, r.items.length ? list(r.items.map(a => row({
    img: a.img, icon: a.img ? null : '⭐', iconClass: 'c-gold',
    title: '#' + a.id + ' · ' + a.title + (a.payout ? ' → ' + a.payout + '⭐' : ''),
    sub: (a.user.username ? '@' + a.user.username : a.user.name) + ' · ' + a.source + ' · ' + when(a.createdAt) + ' · друзів ' + a.user.friends + (a.reason ? ' · ' + a.reason : ''),
    onClick: a.status === 'pending' ? () => appSheet(nav, body, a) : null,
  }))) : el('div', { class: 'card' }, empty('Порожньо')));
}

function appSheet(nav, body, a) {
  sheet((s) => {
    const reason = el('input', { type: 'text', placeholder: 'Причина відхилення (необовʼязково)', maxlength: 300 });
    return [
      el('h3', null, '#' + a.id + ' · ' + a.title),
      el('p', null, (a.user.username ? '@' + a.user.username : a.user.name) + ' · id ' + a.uid + ' · ' + a.source + (a.paid ? ' · оплачено ' + a.paid + '⭐' : '')),
      a.payout ? el('div', { class: 'banner gold' }, el('div', { class: 'bi' }, '💸'), el('div', { class: 'bm' }, el('div', { class: 'bt' }, 'Надіслати ' + a.payout + '⭐'), el('div', { class: 'bs' }, 'Спершу надішли подарунок/зірки, потім підтверди'))) : null,
      el('div', { class: 'stack' },
        button('✅ Підтвердити (видано)', async () => { try { await api.post('/admin/apps/' + a.id + '/approve'); toast('Підтверджено'); s.close(); apps(nav, body); } catch (e) { fail(e); } }, 'ok'),
        el('div', { class: 'field' }, reason),
        button('❌ Відхилити', async () => {
          if (!(await confirm('Відхилити заявку #' + a.id + '? Оплачене повернеться.'))) return;
          try { const r = await api.post('/admin/apps/' + a.id + '/reject', { reason: reason.value.trim() }); toast('Відхилено' + (r.refunded ? ', повернуто ' + r.refunded + '⭐' : '')); s.close(); apps(nav, body); } catch (e) { fail(e); }
        }, 'danger')),
    ];
  });
}

let lastQuery = '';
function user(nav, body) {
  const q = el('input', { type: 'text', placeholder: '@нік або id', value: lastQuery });
  const out = el('div');
  const find = async () => {
    lastQuery = q.value.trim();
    if (!lastQuery) return;
    try { const r = await api.get('/admin/user?q=' + encodeURIComponent(lastQuery)); drawUser(out, r.user, find); }
    catch (e) { mount(out, el('div', { class: 'card' }, empty(e.code === 'not_found' ? 'Не знайдено' : 'Помилка: ' + e.code))); }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  mount(body, el('div', { class: 'card pad' }, el('div', { class: 'btns' }, el('div', { class: 'field', style: { flex: 2 } }, q), button('Знайти', find))), out);
  if (lastQuery) find();
}
function drawUser(out, u, again) {
  const sIn = el('input', { type: 'number', placeholder: '±⭐' });
  const tIn = el('input', { type: 'number', placeholder: '±🎫' });
  const note = el('input', { type: 'text', placeholder: 'Причина (у журнал)', maxlength: 120 });
  mount(out,
    ...section(u.name + (u.username ? ' @' + u.username : ''), list(
      row({ icon: '🆔', title: 'id', value: u.id }),
      row({ icon: '⭐', title: 'Баланс', value: stars(u.stars) + ' · ' + tix(u.tickets), strong: true }),
      row({ icon: u.level.e, title: 'Рівень ' + u.level.n + ' · ' + u.level.t, value: fmt(u.xp) + ' XP' }),
      row({ icon: '👥', title: 'Друзів', value: String(u.friends), sub: u.referredBy ? 'запросив ' + u.referredBy : null }),
      row({ icon: '🎰', title: 'Спінів', value: String(u.spins), sub: 'бонусних ' + u.freeSpins + ' · подарованих платних ' + u.gifted }),
      row({ icon: '💳', title: 'Поповнень', value: u.deposits + ' · ' + stars(u.deposited) }),
      row({ icon: '🕘', title: 'Активність', value: when(u.lastActiveAt), sub: 'з ' + when(u.joinedAt) + (u.remindersOff ? ' · нагадування вимкнено' : '') }))),
    ...section('Коригування', el('div', { class: 'card pad' },
      el('div', { class: 'btns' }, el('div', { class: 'field' }, sIn), el('div', { class: 'field' }, tIn)),
      el('div', { class: 'field mt8' }, note),
      el('div', { class: 'btns mt8' },
        button('Застосувати', async () => {
          const s = Number(sIn.value) || 0, t = Math.trunc(Number(tIn.value) || 0);
          if (!s && !t) return toast('Вкажи суму');
          if (!(await confirm('Змінити баланс ' + (u.username ? '@' + u.username : u.id) + ': ' + (s ? s + '⭐ ' : '') + (t ? t + '🎫' : '') + '?'))) return;
          try { await api.post('/admin/user/adjust', { uid: u.id, stars: s, tickets: t, note: note.value }); toast('Готово'); again(); } catch (e) { fail(e); }
        }),
        button('+1 спін', async () => { try { await api.post('/admin/user/spins', { uid: u.id, free: 1, gifted: 0 }); toast('+1 бонусний спін'); again(); } catch (e) { fail(e); } }, 'tinted')))),
    ...section('Останні рухи', u.tx.length ? list(u.tx.map(x => row({ title: x.r + (x.m && x.m.note ? ' · ' + x.m.note : ''), sub: when(x.ts), value: [x.s ? (x.s > 0 ? '+' : '') + x.s + '⭐' : null, x.t ? (x.t > 0 ? '+' : '') + x.t + '🎫' : null].filter(Boolean).join(' ') }))) : el('div', { class: 'card' }, empty('Порожньо'))),
    ...section('Заявки', u.apps.length ? list(u.apps.map(a => row({ title: '#' + a.id + ' · ' + a.title, sub: a.source + ' · ' + when(a.createdAt), value: a.status }))) : el('div', { class: 'card' }, empty('Немає'))));
}

async function promo(nav, body) {
  const code = el('input', { type: 'text', placeholder: 'КОД', autocapitalize: 'characters' });
  const s = el('input', { type: 'number', placeholder: '⭐' });
  const t = el('input', { type: 'number', placeholder: '🎫' });
  const sp = el('input', { type: 'number', placeholder: 'спіни' });
  const uses = el('input', { type: 'number', placeholder: 'активацій (порожньо = ∞)' });
  const listBox = el('div', null, empty('Завантаження…'));
  const reload = async () => {
    try {
      const r = await api.get('/admin/promo');
      mount(listBox, r.items.length ? list(r.items.map(p => row({ icon: '🎟', title: p.code, sub: p.what + ' · ' + p.used + '/' + (p.limit || '∞'),
        onClick: async () => { if (await confirm('Видалити ' + p.code + '?')) { await api.post('/admin/promo/delete', { code: p.code }).catch(fail); reload(); } } }))) : el('div', { class: 'card' }, empty('Кодів немає')));
    } catch (e) { mount(listBox, empty('Помилка')); }
  };
  mount(body,
    el('div', { class: 'card pad' },
      el('div', { class: 'field' }, code),
      el('div', { class: 'btns mt8' }, el('div', { class: 'field' }, s), el('div', { class: 'field' }, t), el('div', { class: 'field' }, sp)),
      el('div', { class: 'field mt8' }, uses),
      el('div', { class: 'mt12' }, button('Створити', async () => {
        try { const r = await api.post('/admin/promo', { code: code.value, stars: s.value, tickets: t.value, spins: sp.value, uses: uses.value }); toast('Створено ' + r.code); code.value = s.value = t.value = sp.value = uses.value = ''; reload(); }
        catch (e) { fail(e); }
      }))),
    ...section('Коди (натисни, щоб видалити)', listBox));
  reload();
}

async function ops(nav, body) {
  mount(body, empty('Завантаження…'));
  let o;
  try { o = await api.get('/admin/overview'); } catch (e) { mount(body, empty('Помилка')); return; }
  const m = o.maintenance;
  const mText = el('input', { type: 'text', placeholder: 'Текст для гравців', value: m.text || '' });
  const mMin = el('input', { type: 'number', placeholder: 'хвилин (порожньо — без таймера)' });
  const setMaint = (mode) => async () => {
    try { await api.post('/admin/maint', { mode, text: mText.value, minutes: mMin.value }); toast('Техроботи: ' + mode); ops(nav, body); } catch (e) { fail(e); }
  };
  const d = new Date(Date.now() + 3 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  const at = el('input', { type: 'text', value: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' 21:00', placeholder: 'РРРР-ММ-ДД ГГ:ХХ (Київ)' });
  const autoHour = el('input', { type: 'number', min: 0, max: 23, value: String(o.bankAuto.hour || 21) });
  mount(body,
    ...section('Техроботи · зараз: ' + m.mode, el('div', { class: 'card pad' },
      el('div', { class: 'field' }, mText), el('div', { class: 'field mt8' }, mMin),
      el('div', { class: 'btns mt12' }, button('Вимкнути', setMaint('off'), 'ok'), button('Вивід', setMaint('withdraw'), 'tinted'), button('Повні', setMaint('full'), 'danger')))),
    ...section('Банк', el('div', { class: 'card pad' },
      o.bank ? el('div', null, 'Відкрито: ' + stars(o.bank.pot) + ' · ' + o.bank.players + ' гравців · розіграш ' + when(o.bank.drawAt)) : el('div', { class: 'muted' }, 'Зараз банку немає'),
      !o.bank ? el('div', null, el('div', { class: 'label' }, 'Час розіграшу (Київ)'), el('div', { class: 'field' }, at),
        el('div', { class: 'mt8' }, button('Запустити банк', async () => { try { await api.post('/admin/bank/start', { at: at.value }); toast('Банк запущено'); ops(nav, body); } catch (e) { fail(e); } }))) :
        el('div', { class: 'mt12' }, button('Скасувати банк (повернути ставки)', async () => { if (!(await confirm('Скасувати банк і повернути всі ставки?'))) return; try { await api.post('/admin/bank/cancel'); toast('Скасовано'); ops(nav, body); } catch (e) { fail(e); } }, 'danger')),
      el('div', { class: 'label' }, 'Автобанк щодня о (год)'), el('div', { class: 'btns' }, el('div', { class: 'field' }, autoHour),
        button(o.bankAuto.enabled ? 'Вимкнути авто' : 'Увімкнути авто', async () => { try { await api.post('/admin/bank/auto', { enabled: !o.bankAuto.enabled, hour: autoHour.value }); ops(nav, body); } catch (e) { fail(e); } }, 'tinted')))),
    ...section('Перемикачі', list(
      toggleRow('Ліга тижня', 'Коштує реальних призів щотижня', o.league, async (v) => { try { await api.post('/admin/league', { on: v }); toast(v ? 'Ліга увімкнена' : 'Ліга вимкнена'); } catch (e) { fail(e); } }),
      toggleRow('Сповіщення про спіни', 'Повідомлення адміну про кожен спін', o.spinNotify, async (v) => { try { await api.post('/admin/spin-notify', { on: v }); } catch (e) { fail(e); } }))),
    el('div', { class: 'sec-foot' }, 'Розсилки, розіграші, чат і джекпот — командами в боті: /admin'));
}
