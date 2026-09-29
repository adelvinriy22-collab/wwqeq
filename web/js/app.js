// StarForge — застосунок. Шапка з балансом, нижні вкладки, екрани.
import { ready, setBack, startParam, tg } from './tg.js';
import { el, mount, img } from './dom.js';
import { t, setLang, lang } from './i18n.js';
import { S, refresh, onChange, onLevelUp } from './state.js';
import * as api from './api.js';
import { button, errText, sheet, closeSheet, sheetOpen, onSheetClose, toast, left, fmt } from './ui.js';
import * as home from './screens/home.js';
import * as games from './screens/games.js';
import * as progress from './screens/progress.js';
import * as wallet from './screens/wallet.js';
import * as profile from './screens/profile.js';

const TABS = [
  { id: 'home', icon: '🏠', screen: home },
  { id: 'games', icon: '🎰', screen: games },
  { id: 'progress', icon: '⭐', screen: progress },
  { id: 'wallet', icon: '💸', screen: wallet },
  { id: 'profile', icon: '👤', screen: profile },
];

const root = document.getElementById('app');
const top = el('header', { class: 'top' });
const main = el('main');
const tabbar = el('nav', { class: 'tabbar' });

// ── Навігація ───────────────────────────────────────────────────────────
export function go(tab, view) {
  S.stack = [];
  S.route = { tab, view: view || null };
  closeSheet();
  render();
  window.scrollTo(0, 0);
}
export function push(title, renderFn) {
  S.stack.push({ title, render: renderFn });
  render();
  window.scrollTo(0, 0);
}
export function back() {
  if (sheetOpen()) { closeSheet(); return; }
  if (S.stack.length) { S.stack.pop(); render(); return; }
  if (S.route.tab !== 'home') go('home');
}
const nav = { go, push, back, rerender: () => render() };

// Глибокі посилання: ?tab=... або start_param застосунку.
function applyStart(p) {
  const map = {
    wheel: ['games', 'wheels'], wheels: ['games', 'wheels'], bank: ['games', 'bank'], games: ['games', 'dice'], dice: ['games', 'dice'],
    pass: ['progress', 'pass'], league: ['progress', 'league'], quests: ['progress', 'quests'], tasks: ['progress', 'quests'],
    wallet: ['wallet'], topup: ['wallet', 'topup'], withdraw: ['wallet', 'withdraw'], shop: ['wallet', 'shop'],
    friends: ['profile', 'friends'], profile: ['profile'], apps: ['profile', 'apps'], admin: ['profile', 'admin'],
  };
  const m = map[String(p || '').replace(/^tab_/, '')];
  if (m) S.route = { tab: m[0], view: m[1] || null };
}

// ── Шапка ───────────────────────────────────────────────────────────────
function renderTop() {
  const me = S.me;
  if (!me) return mount(top);
  const lv = me.progress.level;
  const initial = (me.user.name || me.user.username || '?').trim().charAt(0).toUpperCase();
  mount(top,
    el('button', { class: 'me', type: 'button', onclick: () => go('profile') },
      el('div', { class: 'avatar' }, me.user.photo ? el('img', { src: me.user.photo, alt: '', referrerpolicy: 'no-referrer' }) : initial),
      el('div', { class: 'me-text' },
        el('div', { class: 'me-name' }, me.user.name || (me.user.username ? '@' + me.user.username : t('app.player'))),
        el('div', { class: 'me-level' }, lv.e + ' ' + lv.t + ' · ' + lv.n, el('div', { class: 'lvlbar' }, el('i', { style: { width: lv.pct + '%' } }))))),
    el('div', { class: 'chips' },
      el('button', { class: 'chip', type: 'button', onclick: () => go('wallet') }, '⭐', el('b', null, fmtShort(me.balance.stars))),
      el('button', { class: 'chip', type: 'button', onclick: () => go('games', 'wheels') }, '🎫', el('b', null, fmtShort(me.balance.tickets)))));
}
function fmtShort(n) {
  const v = Number(n) || 0;
  if (v >= 100000) return Math.round(v / 1000) + 'k';
  if (v >= 10000) return (Math.round(v / 100) / 10) + 'k';
  return fmt(v);
}

function renderTabs() {
  const me = S.me || {};
  const dots = {
    home: me.wheels && me.wheels.wheels && me.wheels.wheels.daily && me.wheels.wheels.daily.ready ? '1' : null,
    progress: ((me.pass && me.pass.claimable) || 0) + (me.quests && me.quests.quiz ? 1 : 0) || null,
  };
  mount(tabbar, TABS.map(tb => el('button', {
    class: 'tab' + (S.route.tab === tb.id && !S.stack.length ? ' on' : S.route.tab === tb.id ? ' on' : ''), type: 'button',
    onclick: () => go(tb.id),
  }, el('span', { class: 'ti' }, tb.icon), el('span', null, t('tab.' + tb.id)), dots[tb.id] ? el('span', { class: 'dot' }, String(dots[tb.id])) : null)));
}

// ── Гейти ───────────────────────────────────────────────────────────────
function gateSubscribe() {
  const me = S.me;
  return el('div', { class: 'gate' },
    el('div', { class: 'gi' }, '📣'),
    el('h2', null, t('gate.subTitle')),
    el('p', null, t('gate.subText', { channel: me.channel || '' })),
    button(t('gate.subscribe'), () => { import('./tg.js').then(m => m.openLink(me.links.channel)); }),
    button(t('gate.check'), async () => {
      const r = await api.post('/subscription/check').catch(() => ({ subscribed: false }));
      if (r.subscribed) { await refresh(); render(); } else toast(t('gate.notYet'), 'error');
    }, 'tinted'));
}
function gateMaint(m) {
  return el('div', { class: 'gate' },
    el('div', { class: 'gi' }, '🛠'),
    el('h2', null, t('gate.maintTitle')),
    el('p', null, m.text || ''),
    m.left ? el('p', null, t('gate.maintLeft', { left: left(m.left) })) : null,
    el('p', null, t('gate.maintSafe')),
    button(t('gate.retry'), async () => { await refresh().catch(() => {}); render(); }, 'tinted'));
}

// ── Відмальовка ─────────────────────────────────────────────────────────
let renderSeq = 0;
function render() {
  const me = S.me;
  if (!me) return;
  document.documentElement.lang = lang();
  renderTop();
  renderTabs();
  const seq = ++renderSeq;
  homeDirty = false;
  const m = me.maintenance || {};
  if (m.mode === 'full') { setBack(null); mount(main, gateMaint(m)); return; }
  if (me.subscribed === false) { setBack(null); mount(main, gateSubscribe()); return; }
  const tab = TABS.find(x => x.id === S.route.tab) || TABS[0];
  let node;
  if (S.stack.length) {
    const top1 = S.stack[S.stack.length - 1];
    node = el('div', { class: 'screen' }, top1.title ? el('div', { class: 'h1' }, top1.title) : null, top1.render(nav));
  } else {
    node = el('div', { class: 'screen' }, tab.screen.render(nav, S.route.view));
  }
  if (seq !== renderSeq) return;
  mount(main, node);
  setBack(S.stack.length || S.route.tab !== 'home' ? back : null);
}

// Баланс і шапка оновлюються одразу. Головну (там лише огляд стану)
// перемальовуємо з новими даними — але не під час спіну, не поверх
// відкритої шторки й не посеред введення тексту.
let homeDirty = false;
function canRedrawHome() {
  const a = document.activeElement;
  return S.route.tab === 'home' && !S.stack.length && !sheetOpen() && !games.busy() && !(a && /INPUT|TEXTAREA|SELECT/.test(a.tagName));
}
function redrawHome() {
  if (!homeDirty) return;
  if (canRedrawHome()) { homeDirty = false; const y = window.scrollY; render(); window.scrollTo(0, y); }
}
onChange((what) => {
  renderTop(); renderTabs();
  if (what === 'lang') { render(); return; }
  if (what === 'me') { homeDirty = true; redrawHome(); }
});
onSheetClose(() => setTimeout(redrawHome, 0));
onLevelUp((lv) => {
  sheet(() => [
    el('div', { class: 'result' }, el('div', { class: 'big' }, lv.e), el('div', { class: 't' }, t('lvl.up', { n: lv.n })), el('div', { class: 's' }, lv.t)),
    el('div', { class: 'mt12' }, button(t('common.great'), () => closeSheet())),
  ]);
});

// Повернулись у застосунок — оновити стан.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.me) refresh().catch(() => {});
});

// Нова версія на сервері — тихо перезавантажитись між діями.
function checkBuild() {
  if (S.me && S.me.build && window.__BUILD__ && !/%BUILD%/.test(window.__BUILD__) && S.me.build !== window.__BUILD__ && !sheetOpen()) location.reload();
}

async function boot() {
  ready();
  applyStart(startParam());
  try {
    await refresh();
  } catch (e) {
    const unauthorized = e && (e.code === 'unauthorized' || e.status === 401);
    mount(root, el('div', { class: 'gate' },
      el('div', { class: 'gi' }, unauthorized ? '🔒' : '📡'),
      el('h2', null, unauthorized ? t('gate.openInTg') : t('gate.offline')),
      el('p', null, unauthorized ? t('gate.openInTgText') : errText(e)),
      unauthorized ? null : button(t('gate.retry'), () => location.reload())));
    return;
  }
  setLang(S.me.user.lang);
  mount(root, top, main, tabbar);
  render();
  if (S.route.view === 'admin' && S.me.user.isAdmin) profile.openAdmin(nav);
  if (S.route.view === 'friends') profile.openFriends(nav);
  if (S.route.view === 'apps') profile.openApps(nav);
  home.maybeFeature(nav);
  setInterval(() => { if (document.visibilityState === 'visible') refresh().then(checkBuild).catch(() => {}); }, 45000);
}

export { nav };
boot();
