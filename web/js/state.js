// Спільний стан застосунку.
import * as api from './api.js';

export const S = {
  me: null,                    // відповідь /api/me
  route: { tab: 'home', view: null },
  stack: [],                   // вкладені сторінки: [{ title, render }]
  cache: {},                   // дані екранів: { progress, wallet, games, ... }
};

const subs = new Set();
export const onChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const emit = (what) => subs.forEach((f) => { try { f(what); } catch (e) { console.error(e); } });

const levelSubs = new Set();
export const onLevelUp = (fn) => levelSubs.add(fn);

export async function refresh() {
  const prev = S.me;
  const me = await api.get('/me');
  S.me = me;
  if (prev && prev.progress && me.progress && me.progress.level.n > prev.progress.level.n) levelSubs.forEach(f => f(me.progress.level));
  emit('me');
  return me;
}
// Швидке оновлення балансу з відповіді дії (без чекання /me).
export function setBalance(stars, tickets) {
  if (!S.me) return;
  if (typeof stars === 'number') S.me.balance.stars = stars;
  if (typeof tickets === 'number') S.me.balance.tickets = tickets;
  emit('balance');
}
// Після дії: баланс одразу, решта — фоном.
let pending = null;
export function refreshSoon() {
  clearTimeout(pending);
  pending = setTimeout(() => refresh().catch(() => {}), 350);
}
