// Спільні елементи інтерфейсу: рядки списків, секції, шторки, тости, формати.
import { el, clear } from './dom.js';
import { t, lang } from './i18n.js';
import { haptic } from './tg.js';

export const fmt = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString(lang() === 'en' ? 'en-US' : 'uk-UA', { maximumFractionDigits: 2 });
};
export const stars = (n) => fmt(n) + '⭐';
export const tix = (n) => fmt(n) + '🎫';

export function left(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (d) return t('time.dh', { d, h });
  if (h) return t('time.hm', { h, m });
  if (m) return t('time.ms', { m, s: sec });
  return t('time.s', { s: sec });
}
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}
export function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const loc = lang() === 'en' ? 'en-GB' : lang() === 'ru' ? 'ru-RU' : 'uk-UA';
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(loc, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
}

// Живі таймери: оновлюються раз на секунду, поки елемент у документі.
const timers = new Set();
export function countdown(to, render, onEnd) {
  const n = el('span', { class: 'num' });
  const tick = () => {
    const ms = to - Date.now();
    n.textContent = render ? render(ms) : left(ms);
    return ms > 0;
  };
  tick();
  const item = { n, tick, onEnd };
  timers.add(item);
  return n;
}
setInterval(() => {
  for (const it of timers) {
    if (!it.n.isConnected) { if (it.seen) timers.delete(it); continue; }
    it.seen = true;
    if (!it.tick() && it.onEnd) { timers.delete(it); it.onEnd(); }
  }
}, 1000);

// ── Будівельні блоки ────────────────────────────────────────────────────
export function section(title, body, foot, action) {
  return [
    title ? el('div', { class: 'sec-title' }, el('span', null, title), action || null) : null,
    body,
    foot ? el('div', { class: 'sec-foot' }, foot) : null,
  ];
}
export function list(...rows) { return el('div', { class: 'list' }, rows); }

// row({ icon, iconClass, img, title, sub, value, strong, onClick, chevron, right })
export function row(o) {
  const tag = o.onClick ? 'button' : (o.href ? 'a' : 'div');
  const ico = o.icon || o.img ? el('div', { class: 'ico ' + (o.iconClass || '') }, o.img ? el('img', { src: '/img/' + o.img + '.png', alt: '' }) : o.icon) : null;
  return el(tag, {
    class: 'row' + (ico ? '' : ' noicon') + (o.onClick && o.chevron !== false ? ' chev' : ''),
    onclick: o.onClick ? (e) => { haptic('select'); o.onClick(e); } : null,
    href: o.href || null, type: o.onClick ? 'button' : null,
  },
  ico,
  el('div', { class: 'row-main' },
    el('div', { class: 'row-title' }, o.title),
    o.sub ? el('div', { class: 'row-sub' }, o.sub) : null),
  o.right || (o.value !== undefined && o.value !== null ? el('div', { class: 'row-val' + (o.strong ? ' strong' : '') }, o.value) : null));
}

export function toggleRow(title, sub, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked, onchange: (e) => { haptic('select'); onChange(e.target.checked); } });
  return el('label', { class: 'row noicon' }, el('div', { class: 'row-main' }, el('div', { class: 'row-title' }, title), sub ? el('div', { class: 'row-sub' }, sub) : null),
    el('span', { class: 'switch' }, input, el('span')));
}

export function button(text, onClick, cls, sub) {
  const b = el('button', { class: 'btn ' + (cls || ''), type: 'button' }, el('span', null, text), sub ? el('span', { class: 'sub' }, sub) : null);
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    haptic('light');
    b.disabled = true;
    try { await onClick(b); } finally { if (b.isConnected) b.disabled = !!b.dataset.keepDisabled; }
  });
  return b;
}

export function seg(items, active, onPick) {
  return el('div', { class: 'seg' }, items.map(([id, label]) =>
    el('button', { class: id === active ? 'on' : '', type: 'button', onclick: () => { if (id !== active) { haptic('select'); onPick(id); } } }, label)));
}

export function bar(pct, cls) {
  return el('div', { class: 'bar ' + (cls || '') }, el('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } }));
}

export function empty(text) { return el('div', { class: 'empty' }, text); }

export function pill(text, cls) { return el('span', { class: 'pill ' + (cls || '') }, text); }

// ── Тост і шторка ───────────────────────────────────────────────────────
let toastEl = null, toastTimer = null;
export function toast(text, kind) {
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  toastEl = el('div', { class: 'toast', role: 'status' }, text);
  document.body.appendChild(toastEl);
  if (kind) haptic(kind);
  toastTimer = setTimeout(() => { if (toastEl) toastEl.remove(); toastEl = null; }, 2600);
}

let sheetEl = null;
export function sheet(build) {
  closeSheet();
  const box = el('div', { class: 'sheet', role: 'dialog' }, el('div', { class: 'grab' }));
  const bg = el('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) closeSheet(); } }, box);
  sheetEl = bg;
  const body = el('div');
  box.appendChild(body);
  const api = { close: closeSheet, body, set: (...kids) => { clear(body); kids.flat().forEach(k => k && body.appendChild(k instanceof Node ? k : document.createTextNode(String(k)))); } };
  const content = build(api);
  if (content) api.set(content);
  document.body.appendChild(bg);
  return api;
}
const closeSubs = new Set();
export const onSheetClose = (fn) => closeSubs.add(fn);
export function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; closeSubs.forEach(f => { try { f(); } catch (e) {} }); } }
export const sheetOpen = () => !!sheetEl;

// Помилка сервера → зрозумілий текст.
export function errText(e) {
  const code = (e && e.code) || 'server_error';
  const d = (e && e.data) || {};
  const key = 'err.' + code;
  const s = t(key, { need: d.need, have: d.have, min: d.min, max: d.max, channel: d.channel, step: d.step });
  return s === key ? t('err.generic') : s;
}
export function fail(e) { toast(errText(e), 'error'); }
