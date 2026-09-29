// Профіль: статистика, друзі й сходинки призів, заявки, чесність,
// налаштування, посилання й адмін-панель.
import { el, mount, img } from '../dom.js';
import { t, setLang, lang } from '../i18n.js';
import * as api from '../api.js';
import { S, emit, refresh, refreshSoon } from '../state.js';
import { openLink, share, copy, haptic } from '../tg.js';
import { section, list, row, button, toggleRow, empty, pill, toast, fail, sheet, fmt, stars, tix, when } from '../ui.js';

let prof = null;

export function render(nav) {
  const me = S.me;
  const body = el('div');
  const lv = me.progress.level;
  const out = [
    el('div', { class: 'card pad center', style: { marginTop: '8px' } },
      el('div', { class: 'avatar', style: { width: '72px', height: '72px', margin: '0 auto', fontSize: '28px' } },
        me.user.photo ? el('img', { src: me.user.photo, alt: '', referrerpolicy: 'no-referrer' }) : (me.user.name || '?').charAt(0).toUpperCase()),
      el('div', { style: { fontWeight: 700, fontSize: '19px', marginTop: '8px' } }, me.user.name || t('app.player')),
      me.user.username ? el('div', { class: 'muted' }, '@' + me.user.username) : el('div', { class: 'bad-text', style: { fontSize: '13px' } }, t('prof.noUsername')),
      el('div', { class: 'gap8 mt8', style: { justifyContent: 'center' } }, pill(lv.e + ' ' + lv.t + ' · ' + lv.n), me.user.anonymous ? pill('🕶 ' + t('prof.anon'), 'grey') : null)),
    body,
  ];
  load(nav, body);
  return out;
}

async function load(nav, body) {
  if (prof) draw(nav, body);
  else mount(body, empty(t('common.loading')));
  try { prof = await api.get('/profile'); if (body.isConnected) draw(nav, body); } catch (e) { if (body.isConnected && !prof) mount(body, empty(t('err.generic'))); }
}

function draw(nav, body) {
  const p = prof, st = p.stats, me = S.me;
  const pendingApps = p.applications.filter(a => a.status === 'pending').length;
  mount(body,
    el('div', { class: 'card mt12' }, el('div', { class: 'stat-grid' },
      el('div', null, el('b', null, fmt(st.spins)), el('span', null, t('prof.spins'))),
      el('div', null, el('b', null, fmt(st.prizes)), el('span', null, t('prof.prizes'))),
      el('div', null, el('b', null, fmt(st.earned)), el('span', null, t('prof.earned'))),
      el('div', null, el('b', null, String(st.bestStreak)), el('span', null, t('prof.bestStreak'))),
      el('div', null, el('b', null, fmt(st.games)), el('span', null, t('prof.games'))),
      el('div', null, el('b', null, st.bestWin || '—'), el('span', null, t('prof.bestWin'))))),
    ...section(null, list(
      row({ icon: '👥', title: t('prof.friends'), value: String(st.friends), onClick: () => openFriends(nav) }),
      row({ icon: '📦', title: t('prof.apps'), right: pendingApps ? el('span', { class: 'badge' }, String(pendingApps)) : el('span', { class: 'row-val' }, String(p.applications.length)), onClick: () => openApps(nav) }),
      row({ icon: '🕘', title: t('prof.history'), onClick: () => openHistory(nav) }),
      row({ icon: '🛡', title: t('fair.title'), onClick: () => openFair(nav) }))),
    ...section(t('prof.settings'), list(
      row({ icon: '🌐', title: t('prof.lang'), value: { uk: 'Українська', en: 'English', ru: 'Русский' }[lang()], onClick: () => langSheet(nav) }),
      toggleRow(t('prof.anon'), t('prof.anonS'), p.settings.anonymous, (v) => save(nav, { anonymous: v })),
      toggleRow(t('prof.remind'), t('prof.remindS'), p.settings.reminders, (v) => save(nav, { reminders: v })),
      toggleRow(t('prof.refNotify'), null, p.settings.notifyOnReferral, (v) => save(nav, { notifyOnReferral: v })))),
    ...section(t('prof.links'), list(
      row({ icon: '📣', title: t('home.channel'), onClick: () => openLink(me.links.channel) }),
      row({ icon: '💬', title: t('home.chat'), onClick: () => openLink(me.links.chat) }),
      row({ icon: '🆘', title: t('prof.support'), value: me.links.support, onClick: () => openLink('https://t.me/' + String(me.links.support).replace('@', '')) }),
      me.user.isAdmin ? row({ icon: '🛠', iconClass: 'c-red', title: t('admin.title'), onClick: () => openAdmin(nav) }) : null)),
    el('div', { class: 'sec-foot center', style: { margin: '18px 16px' } }, 'StarForge · ' + (me.build || '') + (p.since ? ' · ' + t('prof.since', { d: new Date(p.since).toLocaleDateString(lang() === 'en' ? 'en-GB' : lang() === 'ru' ? 'ru-RU' : 'uk-UA') }) : '')));
}

async function save(nav, patch) {
  try { prof = { ...(await api.post('/settings', patch)) }; toast(t('common.saved')); if (patch.lang || patch.anonymous !== undefined) { await refresh(); nav.rerender(); } }
  catch (e) { fail(e); }
}

function langSheet(nav) {
  sheet((s) => [el('h3', null, t('prof.lang')), list(
    [['uk', '🇺🇦 Українська'], ['en', '🇬🇧 English'], ['ru', '🇷🇺 Русский']].map(([id, name]) => row({
      title: name, value: id === lang() ? '✓' : null, strong: true,
      onClick: async () => { s.close(); setLang(id); S.me.user.lang = id; S.cache = {}; emit('lang'); await save(nav, { lang: id }); },
    })))]);
}

// ─── Друзі ──────────────────────────────────────────────────────────────
export function openFriends(nav) {
  nav.push(t('fr.title'), (n) => {
    const body = el('div');
    api.get('/friends').then(d => { if (body.isConnected) mount(body, friendsView(n, d, body)); }).catch(() => mount(body, empty(t('err.generic'))));
    mount(body, empty(t('common.loading')));
    return body;
  });
}
function friendsView(nav, d, body) {
  const L = d.ladder;
  const link = L.link || S.me.links.ref;
  return [
    el('div', { class: 'lead' }, t('fr.lead', { t: d.perFriend, x: d.xpPerFriend })),
    el('div', { class: 'card pad' },
      el('div', { class: 'center' }, el('div', { style: { fontSize: '34px', fontWeight: 800 } }, String(L.count)), el('div', { class: 'muted' }, t('fr.invited'))),
      link ? el('div', { class: 'field mt12' }, el('span', { class: 'mono', style: { flex: 1, padding: '12px 0' } }, link)) : null,
      link ? el('div', { class: 'btns mt8' },
        button(t('fr.share'), () => share(link, t('fr.shareText'))),
        button(t('fr.copy'), async () => { toast((await copy(link)) ? t('fr.copied') : link); }, 'tinted')) : null),
    ...section(t('fr.ladder'), list(L.steps.map(s => row({
      img: s.img, icon: s.img ? null : s.emoji, iconClass: 'c-gold',
      title: s.name, sub: s.state === 'locked' ? t('fr.need', { n: s.need, l: s.left }) : t('fr.needOk', { n: s.need }),
      right: s.state === 'claimable' ? el('button', { class: 'btn small ok', type: 'button', onclick: async () => {
        try { const r = await api.post('/friends/claim', { tier: s.id }); toast(t('fr.claimed', { id: r.applicationId }), 'success'); const nd = await api.get('/friends'); mount(body, friendsView(nav, nd, body)); }
        catch (e) { fail(e); }
      } }, t('pass.take'))
        : s.state === 'pending' ? pill('⏳', 'warn') : s.state === 'approved' ? pill('✓', 'ok') : s.state === 'rejected' ? pill('✕', 'bad') : el('span', { class: 'row-val' }, (L.count) + '/' + s.need),
    }))), t('fr.ladderFoot')),
    ...section(t('fr.list'), d.friends.length ? list(d.friends.map(f => row({ icon: f.active ? '🟢' : '⚪️', title: f.name, sub: f.joinedAt ? when(f.joinedAt) : null }))) : el('div', { class: 'card' }, empty(t('fr.none')))),
  ];
}

// ─── Заявки ─────────────────────────────────────────────────────────────
const APP_ST = { pending: ['⏳', 'warn'], approved: ['✓', 'ok'], rejected: ['✕', 'bad'], cancelled: ['🚫', 'grey'] };
export function openApps(nav) {
  nav.push(t('prof.apps'), () => {
    const body = el('div', null, empty(t('common.loading')));
    api.get('/profile').then(p => {
      prof = p;
      mount(body, p.applications.length ? list(p.applications.map(a => row({
        img: a.img, icon: a.img ? null : '⭐', iconClass: 'c-gold', title: '#' + a.id + ' · ' + a.title,
        sub: a.source + ' · ' + when(a.createdAt) + (a.reason ? ' · ' + a.reason : '') + (a.refunded ? ' · ↩️ ' + stars(a.refunded) : ''),
        right: pill(APP_ST[a.status][0] + ' ' + t('app.' + a.status), APP_ST[a.status][1]),
      }))) : el('div', { class: 'card' }, empty(t('apps.none'))), el('div', { class: 'sec-foot' }, t('apps.foot')));
    }).catch(() => mount(body, empty(t('err.generic'))));
    return body;
  });
}

function openHistory(nav) {
  nav.push(t('prof.history'), () => {
    const h = (prof && prof.history) || [];
    return h.length ? list(h.map(x => row({
      img: x.img, icon: x.img ? null : x.kind === 'tickets' ? '🎫' : x.kind === 'risk' ? '🎲' : '⭐',
      title: x.title, sub: t('wheel.' + x.wheel) + ' · ' + when(x.at) + (x.nonce !== undefined ? ' · #' + x.nonce : ''),
    }))) : el('div', { class: 'card' }, empty(t('hist.empty')));
  });
}

// ─── Чесність ───────────────────────────────────────────────────────────
async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function openFair(nav) {
  nav.push(t('fair.title'), (n) => {
    const body = el('div', null, empty(t('common.loading')));
    const draw = (f) => mount(body,
      el('div', { class: 'lead' }, t('fair.lead')),
      ...section(t('fair.current'), list(
        row({ icon: '🔒', title: t('fair.hash'), sub: el('span', { class: 'mono' }, f.hash) }),
        row({ icon: '🎲', title: t('fair.client'), sub: el('span', { class: 'mono' }, f.client) }),
        row({ icon: '#️⃣', title: t('fair.nonce'), value: String(f.nonce) })),
        t('fair.currentFoot')),
      el('div', { class: 'card pad mt12' }, button(t('fair.rotate'), async () => {
        try { const r = await api.post('/fair/rotate', {}); haptic('success'); toast(t('fair.rotated')); S.me.fairHash = r.current.hash; draw({ ...r.current }); }
        catch (e) { fail(e); }
      }, 'tinted')),
      ...section(t('fair.revealed'), f.history && f.history.length ? list(f.history.map(h => row({
        icon: '🔓', title: t('fair.seedN', { n: h.nonces }), sub: el('span', { class: 'mono' }, h.seed), onClick: () => verifySheet(h),
      }))) : el('div', { class: 'card' }, empty(t('fair.noHistory')))));
    api.get('/fair').then(draw).catch(() => mount(body, empty(t('err.generic'))));
    return body;
  });
}

function verifySheet(h) {
  sheet(() => {
    const nIn = el('input', { type: 'number', inputmode: 'numeric', min: 0, max: Math.max(0, h.nonces - 1), value: '0' });
    const out = el('div', { class: 'mt12' });
    const run = async () => {
      const nonce = Math.floor(Number(nIn.value) || 0);
      const hash = await sha256Hex(h.seed);
      const mac = await hmacHex(h.seed, h.client + ':' + nonce);
      const v = parseInt(mac.slice(0, 13), 16) / Math.pow(16, 13);
      mount(out, list(
        row({ icon: hash === h.hash ? '✅' : '❌', title: t('fair.hashOk'), sub: el('span', { class: 'mono' }, hash) }),
        row({ icon: '🔢', title: t('fair.value'), value: v.toFixed(8), strong: true }),
        row({ icon: '🎯', title: t('fair.dice'), value: String(1 + Math.min(5, Math.floor(v * 6))) })));
    };
    return [
      el('h3', null, t('fair.verify')),
      el('p', null, t('fair.verifyLead')),
      el('div', { class: 'label' }, t('fair.nonce') + ' (0–' + Math.max(0, h.nonces - 1) + ')'),
      el('div', { class: 'field' }, nIn),
      el('div', { class: 'mt12' }, button(t('fair.check'), run)),
      out,
    ];
  });
}

// ─── Адмін ──────────────────────────────────────────────────────────────
export function openAdmin(nav) {
  nav.push(t('admin.title'), (n) => {
    const holder = el('div', null, empty(t('common.loading')));
    import('./admin.js').then(m => mount(holder, m.render(n))).catch(() => mount(holder, empty(t('err.generic'))));
    return holder;
  });
}

export { refreshSoon };
