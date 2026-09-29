// Головна: щоденне колесо одразу під рукою, далі — усе, що зараз актуально.
import { el, mount } from '../dom.js';
import { t } from '../i18n.js';
import * as api from '../api.js';
import { S } from '../state.js';
import { wheelCard } from './games.js';
import { section, list, row, bar, countdown, left, stars, tix, fmt, when, sheet, button, pill } from '../ui.js';

export function render(nav) {
  const me = S.me;
  const out = [];
  const hh = me.wheels.happyHour;
  if (hh && hh.active) {
    out.push(el('div', { class: 'banner gold' }, el('div', { class: 'bi' }, '🍀'),
      el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('home.happy')), el('div', { class: 'bs' }, t('home.happyLeft') + ' ', countdown(hh.end, left)))));
  }
  const r = me.risk;
  if (r && r.amount && (!r.expiresAt || r.expiresAt > Date.now())) {
    out.push(el('div', { class: 'banner gold' }, el('div', { class: 'bi' }, '🎲'),
      el('div', { class: 'bm' }, el('div', { class: 'bt' }, t('risk.bannerT', { a: fmt(r.amount) })),
        el('div', { class: 'bs' }, t('risk.bannerS'), ' ', r.expiresAt ? countdown(r.expiresAt, left, () => { S.me.risk = null; nav.rerender(); }) : null)),
      el('button', { class: 'btn small', type: 'button', onclick: () => nav.go('games', 'wheels') }, t('risk.try'))));
  }

  out.push(el('div', { class: 'sec-title' }, el('span', null, t('home.daily'))));
  out.push(wheelCard(nav, 'daily'));

  // Що зараз актуально.
  const rows = [];
  const b = me.bank;
  rows.push(row({
    icon: '🏦', iconClass: 'c-gold', title: b.active && b.status === 'open' ? t('home.bankToday') : t('home.bank'),
    sub: b.active && b.status === 'open' ? [t('bank.drawIn') + ' ', countdown(b.drawAt, left)] : t('home.bankSoon'),
    value: b.active && b.status === 'open' ? stars(b.stars) + (b.tickets ? ' + ' + tix(b.tickets) : '') : null, strong: true,
    onClick: () => nav.go('games', 'bank'),
  }));
  rows.push(row({
    icon: '🎫', iconClass: 'c-orange', title: t('home.tickets'), sub: t('home.ticketsSub', { n: me.wheels.wheels.referral ? me.wheels.wheels.referral.cost.tickets : 5 }),
    value: tix(me.balance.tickets), strong: true, onClick: () => nav.go('games', 'wheels'),
  }));
  const q = me.quests;
  rows.push(row({
    icon: '📋', iconClass: 'c-green', title: t('home.quests'), sub: q.quiz ? t('home.quizWaiting') : (q.all ? t('home.questsDone') : t('home.questsSub')),
    right: el('span', { class: 'badge ' + (q.all ? 'green' : 'grey') }, q.done + '/' + q.total), onClick: () => nav.go('progress', 'quests'),
  }));
  const p = me.pass;
  rows.push(row({
    icon: '🎟', title: t('home.pass', { n: p.level }), sub: p.premium ? t('home.passPrem') : t('home.passFree'),
    right: p.claimable ? el('span', { class: 'badge red' }, String(p.claimable)) : el('span', { class: 'row-val' }, p.level + '/' + p.maxLevel),
    onClick: () => nav.go('progress', 'pass'),
  }));
  if (me.league.enabled) {
    rows.push(row({ icon: '🏆', iconClass: 'c-gold', title: t('home.league'), sub: [t('home.leagueEnds') + ' ', countdown(me.league.endsAt, left)], value: me.league.rank ? '#' + me.league.rank : '—', strong: true, onClick: () => nav.go('progress', 'league') }));
  }
  rows.push(row({ icon: '👥', title: t('home.friends'), sub: t('home.friendsSub'), value: String(me.friends), onClick: () => import('./profile.js').then(m => m.openFriends(nav)) }));
  if (me.partner && me.partner.on && me.partner.status !== 'done') {
    rows.push(row({ icon: '🔐', iconClass: 'c-red', title: t('home.secret'), sub: me.partner.status === 'pending' ? t('quest.pending') : t('home.secretSub', { s: me.partner.reward.stars, t: me.partner.reward.tickets }), onClick: () => nav.go('progress', 'quests') }));
  }
  out.push(...section(t('home.now'), list(rows)));

  const g = me.goal;
  if (g && g.target) {
    out.push(...section(t('home.goal'), el('div', { class: 'card pad' },
      el('div', { class: 'kv', style: { marginTop: 0 } }, el('span', null, g.done ? t('home.goalDone') : t('home.goalText', { n: g.target })), el('span', { class: 'num' }, fmt(g.count) + '/' + g.target)),
      el('div', { class: 'mt8' }, bar(g.count / g.target * 100, 'green')),
      el('div', { class: 'kv' }, el('span', null, g.joined ? t('home.goalIn') : t('home.goalJoin')), el('span', null, t('home.goalPlayers', { n: g.participants }))))));
  }

  const feed = el('div', null, list(row({ icon: '⏳', title: t('common.loading') })));
  out.push(...section(t('home.live'), feed));
  api.get('/live').then(r => {
    if (!feed.isConnected) return;
    mount(feed, r.items.length ? list(r.items.slice(0, 8).map(it => row({
      icon: it.kind === 'prize' ? null : it.kind === 'tix' ? '🎫' : '⭐', img: it.kind === 'prize' ? it.img : null, iconClass: it.kind === 'prize' ? 'c-gold' : '',
      title: it.name + (it.me ? ' · ' + t('common.you') : ''), sub: (it.how ? it.how + ' · ' : '') + when(it.at), value: it.what,
    }))) : list(row({ icon: '✨', title: t('home.liveEmpty') })));
  }).catch(() => { if (feed.isConnected) mount(feed); });

  out.push(el('div', { class: 'gap8', style: { justifyContent: 'center', margin: '18px 16px 0' } },
    pill('📣 ' + t('home.channel')), pill('💬 ' + t('home.chat'))));
  const links = out[out.length - 1];
  links.children[0].style.cursor = links.children[1].style.cursor = 'pointer';
  links.children[0].addEventListener('click', () => import('../tg.js').then(m => m.openLink(me.links.channel)));
  links.children[1].addEventListener('click', () => import('../tg.js').then(m => m.openLink(me.links.chat)));
  return out;
}

// Разове вікно про секретне завдання (раніше — «нова функція»).
export function maybeFeature(nav) {
  const me = S.me;
  if (!me || !me.showFeature) return;
  api.post('/seen', { what: 'feature' }).catch(() => {});
  me.showFeature = false;
  sheet((s) => [
    el('div', { class: 'result' }, el('div', { class: 'big' }, '🔐'), el('div', { class: 't' }, t('feature.title')),
      el('div', { class: 's' }, t('feature.text', { s: me.partner.reward.stars, t: me.partner.reward.tickets, x: me.partner.reward.xp }))),
    el('div', { class: 'stack mt12' },
      button(t('feature.open'), () => { s.close(); nav.go('progress', 'quests'); }),
      button(t('common.later'), () => s.close(), 'plain')),
  ]);
}
