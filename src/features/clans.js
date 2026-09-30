// ==========================================================================
// КЛАНИ. Створення, вступ (відкритий клан — одразу, закритий — заявкою, яку
// підтверджує лідер або заступник), ролі (лідер, заступники, учасники),
// скарбниця білетів, лідерборди (клани між собою й гравці всередині клану)
// і щотижнева кланова війна з призами. Налаштування — E.CLANS у economy.js.
//
// Очки клану — XP, які учасники набирають ПІСЛЯ вступу (хук progress.onXp),
// тож перехід у сильний клан не переносить старих очок.
//
// Команди працюють і в чаті (через модуль чату), і в приваті з ботом.
// Дані — featureFlags.clans = { list: { id: клан }, week, lastWar }; у гравця — u.clanId.
// ==========================================================================
const crypto = require('crypto');
const E = require('../economy');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const time = require('../lib/time');
const tggifts = require('./tggifts');
const applications = require('./applications');
const { withEmoji, EMOJI } = require('../emoji');
const { esc } = require('../lib/util');

const C = E.CLANS;
const LINE = '━━━━━━━━━━━━━━';
const ICON = { owner: '{:crown}', deputy: '{:starIcon}', member: '👤' };
const MEDAL = ['{:goldMedal}', '{:silverMedal}', '{:bronzeMedal}'];

// ─── Дані ───────────────────────────────────────────────────────────────
function data() {
  const d = (store.getFeatureFlags() || {}).clans;
  return d && d.list ? d : { list: {}, week: null, lastWar: null };
}
function save(d) { store.setFeatureFlags({ clans: d }); }
const curWeek = () => time.weekKey(Date.now());
const r2 = (n) => Math.round(n * 100) / 100;
const levelOf = (c) => E.clanLevel(c.total || 0);
const capOf = (c) => E.clanCap(levelOf(c));
function roll(c) {
  const w = curWeek();
  if (!c.week || c.week.id !== w) { if (c.week && c.week.pts > 0) c.prevWeek = c.week; c.week = { id: w, pts: 0, contrib: {} }; }
  if (!c.contribAll) c.contribAll = {};
  return c;
}
function clanOfUser(d, uid) {
  const u = users.get(uid);
  const c = u && u.clanId ? d.list[u.clanId] : null;
  return c && c.members.includes(String(uid)) ? c : null;
}
const roleOf = (c, uid) => (c.owner === String(uid) ? 'owner' : (c.deputies || []).includes(String(uid)) ? 'deputy' : 'member');
const canManage = (c, uid) => roleOf(c, uid) !== 'member';
function findClan(d, q) {
  const w = String(q || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!w) return null;
  return Object.values(d.list).find(c => c.id === w || c.tag.toLowerCase() === w || c.name.toLowerCase() === w) || null;
}
function whoOf(uid) { return esc(plainWho(uid)); }
function plainWho(uid) { const u = users.get(uid) || {}; return u.username ? '@' + u.username : (u.name || 'гравець'); }
function registered(uid) { const u = users.get(uid); return !!(u && u.lang); }

function makeTag(d, name) {
  const letters = (String(name).match(/[\p{L}\p{N}]/gu) || []).join('').toUpperCase();
  const base = (letters.slice(0, 4) || 'CLAN');
  const taken = new Set(Object.values(d.list).map(c => c.tag));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(base.slice(0, 3) + i)) return base.slice(0, 3) + i;
  return base + crypto.randomBytes(1).toString('hex').toUpperCase();
}
const EMOJI_RE = /^(\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*)\s*/u;

function addMember(c, uid) {
  uid = String(uid);
  if (!c.members.includes(uid)) c.members.push(uid);
  c.requests = (c.requests || []).filter(r => r.uid !== uid);
  roll(c);
  if (c.week.contrib[uid] == null) c.week.contrib[uid] = 0;
  users.patch(uid, { clanId: c.id });
}
function removeMember(c, uid) {
  uid = String(uid);
  c.members = c.members.filter(x => x !== uid);
  c.deputies = (c.deputies || []).filter(x => x !== uid);
  users.patch(uid, { clanId: null, clanLeftAt: Date.now() });
}

// ─── Дії ────────────────────────────────────────────────────────────────
function create(uid, rawName) {
  uid = String(uid);
  const d = data();
  if (!registered(uid)) return { ok: false, error: 'not_registered' };
  if (clanOfUser(d, uid)) return { ok: false, error: 'already_in_clan' };
  const lv = progress.levelInfo(progress.xpOf(users.get(uid)).total).n;
  if (lv < C.minLevel && !users.isAdmin(uid)) return { ok: false, error: 'low_level', need: C.minLevel, have: lv };
  let text = String(rawName || '').trim();
  let emoji = '⚔️';
  const em = text.match(EMOJI_RE);
  if (em) { emoji = em[1]; text = text.slice(em[0].length).trim(); }
  const name = text.replace(/\s+/g, ' ');
  if (name.length < C.nameMin || name.length > C.nameMax || !/^[\p{L}\p{N} _\-'’.!]+$/u.test(name)) return { ok: false, error: 'bad_name' };
  if (Object.values(d.list).some(c => c.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: 'name_taken' };
  const m = users.move(uid, { tickets: -C.createCost }, 'clan_create', { name });
  if (!m.ok) return { ok: false, error: 'create_cost', need: C.createCost, have: users.tickets(users.get(uid)) };
  const id = crypto.randomBytes(4).toString('hex');
  const c = { id, name, tag: makeTag(d, name), emoji, owner: uid, deputies: [], members: [], open: true, requests: [], treasury: 0, total: 0, wins: 0, createdAt: Date.now(), week: null, contribAll: {} };
  d.list[id] = c;
  if (!d.week) d.week = curWeek();     // з цього тижня кланова війна вже рахується
  addMember(c, uid);
  save(d);
  return { ok: true, clan: c };
}

function join(uid, clanId) {
  uid = String(uid);
  const d = data();
  if (!registered(uid)) return { ok: false, error: 'not_registered' };
  const cur = clanOfUser(d, uid);
  if (cur) return { ok: false, error: cur.id === clanId ? 'already_member' : 'already_in_clan', clan: cur };
  const c = d.list[clanId];
  if (!c) return { ok: false, error: 'no_clan' };
  const u = users.get(uid) || {};
  const wait = (u.clanLeftAt || 0) + C.rejoinHours * 3600e3 - Date.now();
  if (wait > 0) return { ok: false, error: 'cooldown', left: wait };
  if (c.members.length >= capOf(c)) return { ok: false, error: 'full', cap: capOf(c) };
  if (!c.open) {
    if ((c.requests || []).some(r => r.uid === uid)) return { ok: false, error: 'already_requested', clan: c };
    c.requests = (c.requests || []).concat([{ uid, at: Date.now() }]).slice(-50);
    save(d);
    return { ok: true, request: true, clan: c };
  }
  addMember(c, uid);
  save(d);
  return { ok: true, clan: c };
}

function decide(byUid, clanId, uid, accept) {
  const d = data();
  const c = d.list[clanId];
  if (!c) return { ok: false, error: 'no_clan' };
  if (!canManage(c, byUid)) return { ok: false, error: 'no_rights' };
  const had = (c.requests || []).some(r => r.uid === String(uid));
  if (!had) return { ok: false, error: 'no_request' };
  c.requests = c.requests.filter(r => r.uid !== String(uid));
  if (accept) {
    if (clanOfUser(d, uid)) { save(d); return { ok: false, error: 'in_other_clan' }; }
    if (c.members.length >= capOf(c)) { save(d); return { ok: false, error: 'full', cap: capOf(c) }; }
    addMember(c, uid);
  }
  save(d);
  return { ok: true, clan: c };
}

// Найкращий наступник лідера: заступник, інакше той, хто найбільше приніс клану.
function successor(c, except) {
  const rest = c.members.filter(x => x !== except);
  if (!rest.length) return null;
  const dep = (c.deputies || []).find(x => x !== except && rest.includes(x));
  if (dep) return dep;
  const all = c.contribAll || {};
  return rest.slice().sort((a, b) => (all[b] || 0) - (all[a] || 0))[0];
}

function disbandClan(d, c) {
  // Скарбниця — порівну всім учасникам, щоб білети не згоріли.
  const share = c.members.length ? Math.floor((c.treasury || 0) / c.members.length) : 0;
  for (const uid of c.members.slice()) {
    if (share > 0) users.move(uid, { tickets: share }, 'clan_disband', { clan: c.id });
    removeMember(c, uid);
  }
  delete d.list[c.id];
  return share;
}

function leave(uid) {
  uid = String(uid);
  const d = data();
  const c = clanOfUser(d, uid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (c.owner === uid) {
    const next = successor(c, uid);
    if (!next) { const share = disbandClan(d, c); save(d); return { ok: true, disbanded: true, clan: c, share }; }
    c.owner = next;
    c.deputies = (c.deputies || []).filter(x => x !== next);
    removeMember(c, uid);
    save(d);
    return { ok: true, clan: c, newOwner: next };
  }
  removeMember(c, uid);
  save(d);
  return { ok: true, clan: c };
}

function kick(byUid, target) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  target = String(target);
  if (!c.members.includes(target)) return { ok: false, error: 'not_member' };
  if (target === String(byUid)) return { ok: false, error: 'self' };
  const r = roleOf(c, byUid), t = roleOf(c, target);
  if (r === 'member' || t === 'owner' || (r === 'deputy' && t === 'deputy')) return { ok: false, error: 'no_rights' };
  removeMember(c, target);
  save(d);
  return { ok: true, clan: c };
}

function setDeputy(byUid, target) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (roleOf(c, byUid) !== 'owner') return { ok: false, error: 'owner_only' };
  target = String(target);
  if (!c.members.includes(target) || target === c.owner) return { ok: false, error: 'not_member' };
  c.deputies = c.deputies || [];
  let on;
  if (c.deputies.includes(target)) { c.deputies = c.deputies.filter(x => x !== target); on = false; }
  else { if (c.deputies.length >= C.maxDeputies) return { ok: false, error: 'max_deputies', max: C.maxDeputies }; c.deputies.push(target); on = true; }
  save(d);
  return { ok: true, clan: c, on };
}

function transfer(byUid, target) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (roleOf(c, byUid) !== 'owner') return { ok: false, error: 'owner_only' };
  target = String(target);
  if (!c.members.includes(target) || target === c.owner) return { ok: false, error: 'not_member' };
  c.deputies = (c.deputies || []).filter(x => x !== target).concat([String(byUid)]).slice(0, C.maxDeputies);
  c.owner = target;
  save(d);
  return { ok: true, clan: c };
}

function settings(byUid, patch) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (roleOf(c, byUid) !== 'owner') return { ok: false, error: 'owner_only' };
  if (patch.open !== undefined) c.open = !!patch.open;
  if (patch.emoji !== undefined) {
    const em = String(patch.emoji).trim().match(EMOJI_RE);
    if (!em) return { ok: false, error: 'bad_emoji' };
    c.emoji = em[1];
  }
  save(d);
  return { ok: true, clan: c };
}

function donate(uid, n) {
  n = Math.floor(Number(n) || 0);
  if (n < 1) return { ok: false, error: 'bad_amount' };
  const d = data();
  const c = clanOfUser(d, uid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  const m = users.move(String(uid), { tickets: -n }, 'clan_donate', { clan: c.id });
  if (!m.ok) return { ok: false, error: 'not_enough_tickets' };
  c.treasury = (c.treasury || 0) + n;
  save(d);
  return { ok: true, clan: c, n };
}

function give(byUid, target, n) {
  n = Math.floor(Number(n) || 0);
  if (n < 1) return { ok: false, error: 'bad_amount' };
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (roleOf(c, byUid) !== 'owner') return { ok: false, error: 'owner_only' };
  target = String(target);
  if (!c.members.includes(target)) return { ok: false, error: 'not_member' };
  if ((c.treasury || 0) < n) return { ok: false, error: 'treasury_low', have: c.treasury || 0 };
  c.treasury -= n;
  users.move(target, { tickets: n }, 'clan_give', { clan: c.id });
  save(d);
  return { ok: true, clan: c, n };
}

function disband(byUid) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (roleOf(c, byUid) !== 'owner') return { ok: false, error: 'owner_only' };
  const share = disbandClan(d, c);
  save(d);
  return { ok: true, clan: c, share };
}

// ─── Очки: XP учасників після вступу ────────────────────────────────────
function onXp(uid, src, gain) {
  if (!gain || src === 'clan' || src === 'admin') return;
  const u = users.get(uid);
  if (!u || !u.clanId) return;
  const d = data();
  const c = d.list[u.clanId];
  if (!c || !c.members.includes(String(uid))) return;
  roll(c);
  c.week.pts = r2(c.week.pts + gain);
  c.week.contrib[uid] = r2((c.week.contrib[uid] || 0) + gain);
  c.contribAll[uid] = r2((c.contribAll[uid] || 0) + gain);
  c.total = r2((c.total || 0) + gain);
  save(d);
}

// Таблиця тижня: клани, що беруть участь у війні, за очками.
function standings(d, weekId) {
  const wk = weekId || curWeek();
  return Object.values(d.list).map(c => {
    const w = c.week && c.week.id === wk ? c.week : (c.prevWeek && c.prevWeek.id === wk ? c.prevWeek : null);
    return { c, pts: w ? w.pts : 0, contrib: w ? w.contrib : {} };
  }).sort((a, b) => b.pts - a.pts || (b.c.total || 0) - (a.c.total || 0));
}
const eligible = (row) => row.pts > 0 && row.c.members.length >= C.minMembers;

// ─── Кланова війна: підсумки тижня (щопонеділка) ────────────────────────
let finalizing = false;
async function tick() {
  const d = data();
  const cur = curWeek();
  if (!d.week) { d.week = cur; save(d); return null; }
  if (d.week === cur || finalizing) return null;
  const prev = d.week;
  d.week = cur;                  // спершу фіксуємо — повторний tick не нагородить двічі
  save(d);
  finalizing = true;
  try { return await finalize(prev); } finally { finalizing = false; }
}

// opts.reset — достроковий раунд (адмін /clanwar finish): після нагород очки тижня
// обнуляються, тож у понеділок рахується лише набране після цього.
async function finalize(weekId, opts) {
  const d = data();
  const rows = standings(d, weekId).filter(eligible).slice(0, C.rewards.length);
  const result = { week: weekId, at: Date.now(), top: [] };
  for (let i = 0; i < rows.length; i++) {
    const { c, pts, contrib } = rows[i];
    const rw = C.rewards[i];
    const active = c.members.filter(uid => (contrib[uid] || 0) >= C.activeMin);
    for (const uid of active) {
      users.move(uid, { stars: rw.stars, tickets: rw.tickets }, 'clan_war', { clan: c.id, place: rw.place, week: weekId });
      if (rw.xp) progress.addXp(uid, 'clan', rw.xp, { silent: true });
      const u = users.get(uid) || {};
      notify.dm(uid, withEmoji(`{:trophy} <b>КЛАНОВА ВІЙНА — ${rw.place} МІСЦЕ!</b>\n${LINE}\nТвій клан ${c.emoji} <b>${esc(c.name)}</b> набрав <b>${Math.floor(pts)}</b> очок за тиждень.\n\n{:giftBox} Твоя нагорода: <b>+${rw.stars}⭐ +${rw.tickets}🎫 +${rw.xp} XP</b> — уже на балансі` +
        (uid === c.owner && rw.ownerGift ? `\n{:crown} Як власнику клану — ще й ${E.getTier(rw.ownerGift).emoji} <b>${esc(E.tierName(rw.ownerGift, u.lang || 'uk'))}</b> справжнім подарунком Telegram!` : '')));
    }
    let gift = null;
    if (rw.ownerGift) {
      const g = await tggifts.send(c.owner, rw.ownerGift, `🏆 ${rw.place} місце у клановій війні StarForge — клан ${c.name}!`);
      if (g.ok) gift = 'sent';
      else {
        applications.create(c.owner, rw.ownerGift, 'clan_war', { note: 'клан ' + c.name + ', ' + rw.place + ' місце' });
        gift = 'request';
        notify.admin(`⚠️ Кланова війна: подарунок власнику ${whoOf(c.owner)} (${esc(c.name)}) не надіслано автоматично — створено заявку.\n<code>${esc(g.error || '')}</code>`);
      }
      if (!active.includes(c.owner)) {
        const ou = users.get(c.owner) || {};
        notify.dm(c.owner, withEmoji(`{:trophy} <b>КЛАНОВА ВІЙНА — ${rw.place} МІСЦЕ!</b>\n${LINE}\nТвій клан ${c.emoji} <b>${esc(c.name)}</b> на п’єдесталі. {:crown} Як власнику — ${E.getTier(rw.ownerGift).emoji} <b>${esc(E.tierName(rw.ownerGift, ou.lang || 'uk'))}</b>!\n\n<i>Особисті призи (+${rw.stars}⭐ +${rw.tickets}🎫) — лише активним: від ${C.activeMin} очок за тиждень.</i>`));
      }
    }
    if (i === 0) c.wins = (c.wins || 0) + 1;
    const mvp = Object.entries(contrib).filter(([uid]) => c.members.includes(uid)).sort((a, b) => b[1] - a[1])[0];
    result.top.push({ id: c.id, name: c.name, emoji: c.emoji, tag: c.tag, pts: Math.floor(pts), rewarded: active.length, place: rw.place, gift, mvp: mvp ? mvp[0] : null });
  }
  if (opts && opts.reset) {
    for (const c of Object.values(d.list)) if (c.week && c.week.id === weekId) c.week = { id: weekId, pts: 0, contrib: {} };
    result.early = true;
  }
  d.lastWar = result;
  save(d);
  if (result.top.length) {
    const chat = notify.tg.chat;
    if (chat && chat.say) chat.say(warResultText(result)).catch(() => {});
  }
  return result;
}

// Адмін: підбити підсумки зараз (не чекаючи понеділка).
async function finishNow() {
  if (finalizing) return null;
  finalizing = true;
  try { return await finalize(curWeek(), { reset: true }); } finally { finalizing = false; }
}
// Адмін: прибрати клан (наприклад, за образливу назву). Скарбниця — учасникам.
function adminDelete(q) {
  const d = data();
  const c = findClan(d, q);
  if (!c) return { ok: false, error: 'no_clan' };
  const share = disbandClan(d, c);
  save(d);
  return { ok: true, clan: c, share };
}
async function adminCommand(ctx) {
  const [sub, ...rest] = String(ctx.message.text || '').split(/\s+/).slice(1);
  const reply = (t) => ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  if (sub === 'finish') {
    const r = await finishNow();
    if (!r) return reply('⏳ Підсумки вже підбиваються.');
    if (!r.top.length) return reply(`Нікого нагороджувати: жоден клан від ${C.minMembers} учасників не набрав очок.`);
    return reply('✅ Підсумки війни підбито, очки тижня обнулено:\n' + r.top.map(t => `${t.place}. ${t.emoji} ${esc(t.name)} — ${t.pts} очок · нагороджено ${t.rewarded}` + (t.gift ? ` · подарунок власнику: ${t.gift === 'sent' ? 'надіслано' : 'заявка'}` : '')).join('\n'));
  }
  if (sub === 'delete') {
    const r = adminDelete(rest.join(' '));
    if (!r.ok) return reply(errText(r));
    return reply(`🗑 Клан ${clanTitle(r.clan)} видалено` + (r.share ? ` · учасникам по ${r.share}🎫 зі скарбниці` : '') + '.');
  }
  const d = data();
  const n = Object.keys(d.list).length;
  const members = Object.values(d.list).reduce((a, c) => a + c.members.length, 0);
  return reply(warText() + `\n\n<b>Адміну:</b> кланів ${n}, у кланах ${members} гравців.\n/clanwar finish — підбити підсумки зараз (очки тижня обнуляться)\n/clanwar delete ТЕГ — видалити клан`);
}

// ─── Тексти ─────────────────────────────────────────────────────────────
const card = (icon, title, lines, foot) => withEmoji(icon + ' <b>' + title + '</b>\n' + LINE + '\n' + lines.filter(l => l !== null && l !== undefined && l !== false).join('\n') + (foot ? '\n\n<i>' + foot + '</i>' : ''));
const clanTitle = (c) => `${c.emoji} <b>${esc(c.name)}</b> [${esc(c.tag)}]`;
function leftToWeekEnd() {
  const ms = Math.max(0, time.weekEnd(Date.now()) - Date.now());
  const dd = Math.floor(ms / 86400e3), hh = Math.floor((ms % 86400e3) / 3600e3), mm = Math.floor((ms % 3600e3) / 60e3);
  return (dd ? dd + ' дн ' : '') + hh + ' год' + (dd ? '' : ' ' + mm + ' хв');
}
function prizeLines() {
  return C.rewards.map((rw, i) => `${MEDAL[i]} +${rw.stars}⭐ +${rw.tickets}🎫 +${rw.xp} XP кожному активному` +
    (rw.ownerGift ? ` · власнику ${E.getTier(rw.ownerGift).emoji} ${E.tierName(rw.ownerGift, 'uk')} (${E.getTier(rw.ownerGift).price}⭐)` : ''));
}

function clanCard(c, viewer) {
  roll(c);
  const d = data();
  const rank = standings(d).findIndex(r => r.c.id === c.id) + 1;
  const topW = Object.entries(c.week.contrib).filter(([u]) => c.members.includes(u)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const deps = (c.deputies || []).map(whoOf);
  const me = viewer && c.members.includes(String(viewer)) ? roleOf(c, viewer) : null;
  const lines = [
    `{:crown} Рівень <b>${levelOf(c)}</b> · учасників <b>${c.members.length}/${capOf(c)}</b> · ${c.open ? '{:greenCircle} відкритий' : '{:lockIcon} за заявкою'}`,
    `{:lightning} Цього тижня: <b>${Math.floor(c.week.pts)}</b> очок` + (rank ? ` · <b>#${rank}</b> серед кланів` : ''),
    `{:inventoryBag} Скарбниця: <b>${c.treasury || 0}🎫</b>` + (c.wins ? ` · {:trophy} перемог у війні: <b>${c.wins}</b>` : ''),
    '',
    `{:crown} Лідер: ${whoOf(c.owner)}`,
    deps.length ? `{:starIcon} Заступники: ${deps.join(', ')}` : null,
    topW.length ? '{:almost} Топ тижня: ' + topW.map(([u, p], i) => `${i + 1}. ${whoOf(u)} — ${Math.floor(p)}`).join(' · ') : null,
    me ? '' : null,
    me ? `Ти в клані: <b>${{ owner: 'лідер', deputy: 'заступник', member: 'учасник' }[me]}</b> · твій внесок цього тижня: <b>${Math.floor(c.week.contrib[String(viewer)] || 0)}</b>` : null,
  ];
  return card(c.emoji, 'КЛАН «' + esc(c.name.toUpperCase()) + '» [' + esc(c.tag) + ']', lines, 'Очки клану — XP учасників: чат, ігри, спіни, завдання. /clan_top — кланова війна тижня');
}
function clanKeyboard(c, viewer) {
  const inClan = viewer && c.members.includes(String(viewer));
  const rows = [];
  if (!inClan) rows.push([btn(c.open ? 'ВСТУПИТИ' : 'ПОДАТИ ЗАЯВКУ', 'cl:j:' + c.id, 'success', 'lightning')]);
  rows.push([btn('УЧАСНИКИ', 'cl:m:' + c.id, 'primary', 'statsIcon'), btn('ВІЙНА ТИЖНЯ', 'cl:t', 'danger', 'trophy')]);
  return { inline_keyboard: rows };
}
function btn(text, data, style, icon) {
  const b = { text, callback_data: data };
  if (style) b.style = style;
  if (icon && EMOJI[icon] && EMOJI[icon].id) b.icon_custom_emoji_id = EMOJI[icon].id;
  return b;
}

function listText() {
  const d = data();
  const rows = standings(d);
  if (!rows.length) return card('⚔️', 'КЛАНИ', ['Поки немає жодного клану.', '', `Створи перший: <code>/clan_create 🐺 Назва</code> (${C.createCost}🎫, з ${C.minLevel}-го рівня)`]);
  const lines = rows.slice(0, 20).map(({ c, pts }, i) =>
    `${i < 3 ? MEDAL[i] : (i + 1) + '.'} ${clanTitle(c)} · рів. ${levelOf(c)} · ${c.members.length}/${capOf(c)} ${c.open ? '{:greenCircle}' : '{:lockIcon}'} · ⚔️ ${Math.floor(pts)}`);
  if (rows.length > 20) lines.push(`…і ще ${rows.length - 20}`);
  lines.push('', 'Вступити: <code>/clan_join ТЕГ</code> · деталі: <code>/clan_info ТЕГ</code>');
  return card('⚔️', 'КЛАНИ · ' + rows.length, lines, '{:greenCircle} відкритий — одразу · {:lockIcon} — за заявкою');
}
function listKeyboard() {
  const rows = standings(data()).slice(0, 6).map(({ c }) => btn(`${c.emoji} ${c.name}`, 'cl:v:' + c.id));
  const kb = [];
  for (let i = 0; i < rows.length; i += 2) kb.push(rows.slice(i, i + 2));
  kb.push([btn('ВІЙНА ТИЖНЯ', 'cl:t', 'danger', 'trophy')]);
  return { inline_keyboard: kb };
}

function warText() {
  const d = data();
  const rows = standings(d).filter(eligible);
  const lines = [`{:clockIcon} До підсумків: <b>${leftToWeekEnd()}</b> (понеділок 00:00, Київ)`, ''];
  if (!rows.length) lines.push(`Поки жоден клан не набрав очок. У війні беруть участь клани від ${C.minMembers} учасників.`);
  rows.slice(0, 10).forEach(({ c, pts }, i) => lines.push(`${i < 3 ? MEDAL[i] : (i + 1) + '.'} ${clanTitle(c)} — <b>${Math.floor(pts)}</b>`));
  lines.push('', '{:giftBox} <b>Призи тижня:</b>', ...prizeLines());
  lines.push(`<i>Активний учасник — від ${C.activeMin} очок за тиждень.</i>`);
  const lw = d.lastWar;
  if (lw && lw.top && lw.top.length) lines.push('', '{:trophy} Минулого тижня: ' + lw.top.map(t => `${t.place}. ${t.emoji} ${esc(t.name)} (${t.pts})`).join(' · '));
  return card('{:trophy}', 'КЛАНОВА ВІЙНА ТИЖНЯ', lines, 'Очки — XP учасників. Будь активним — і твій клан на п’єдесталі!');
}
function warResultText(res) {
  const lines = res.top.map((t, i) => `${MEDAL[i]} ${t.emoji} <b>${esc(t.name)}</b> — ${t.pts} очок · нагороджено: ${t.rewarded}` + (t.mvp ? ` · MVP ${whoOf(t.mvp)}` : ''));
  lines.push('', '{:giftBox} Нагороди вже на балансах переможців!', ...prizeLines());
  return card('{:trophy}', 'ПІДСУМКИ КЛАНОВОЇ ВІЙНИ', lines, 'Новий тиждень — нова війна. /clan_top — таблиця');
}

function membersText(c) {
  roll(c);
  const all = c.contribAll || {};
  const rows = c.members.slice().sort((a, b) => (c.week.contrib[b] || 0) - (c.week.contrib[a] || 0) || (all[b] || 0) - (all[a] || 0));
  const lines = rows.map((uid, i) => `${i < 3 ? MEDAL[i] : (i + 1) + '.'} ${ICON[roleOf(c, uid)]} ${whoOf(uid)} — <b>${Math.floor(c.week.contrib[uid] || 0)}</b> за тиждень · ${Math.floor(all[uid] || 0)} усього` +
    ((c.week.contrib[uid] || 0) >= C.activeMin ? ' {:check}' : ''));
  return card(c.emoji, 'ЛІДЕРБОРД КЛАНУ «' + esc(c.name.toUpperCase()) + '»', lines, `{:check} — активний цього тижня (від ${C.activeMin} очок): отримає приз, якщо клан у топ-3`);
}

function helpText() {
  return card('⚔️', 'КЛАНИ — ЯК ЦЕ ПРАЦЮЄ', [
    'Об’єднуйся з друзями, набирай очки й вигравай кланову війну щотижня!',
    '',
    '{:lightning} <b>Очки клану</b> — XP учасників: чат, ігри, спіни, завдання.',
    `{:trophy} <b>Війна тижня</b> — щопонеділка топ-3 клани отримують призи:`,
    ...prizeLines(),
    '',
    '<b>Команди:</b>',
    '<code>/clans</code> — усі клани · <code>/clan_top</code> — війна тижня',
    '<code>/clan</code> — мій клан · <code>/clan_members</code> — лідерборд клану',
    `<code>/clan_create 🐺 Назва</code> — створити (${C.createCost}🎫, з ${C.minLevel}-го рівня)`,
    '<code>/clan_join ТЕГ</code> — вступити або подати заявку · <code>/clan_leave</code> — вийти',
    '<code>/clan_donate 10</code> — білети в скарбницю',
    '',
    '<b>Лідеру:</b> <code>/clan_requests</code> · <code>/clan_open</code> / <code>/clan_close</code> · <code>/clan_kick @нік</code> · <code>/clan_deputy @нік</code> · <code>/clan_leader @нік</code> · <code>/clan_give @нік 10</code> · <code>/clan_emoji 🦁</code> · <code>/clan_disband так</code>',
  ], `Після виходу з клану вступити в інший можна через ${C.rejoinHours} год`);
}

const ERR = {
  not_registered: 'Спершу запусти бота — і повертайся 🙂', already_in_clan: 'Ти вже в клані. Спершу /clan_leave.', already_member: 'Ти вже в цьому клані 🙂',
  low_level: 'Створити клан можна з {need}-го рівня (у тебе {have}). /level у боті',
  bad_name: `Назва — від ${C.nameMin} до ${C.nameMax} символів: літери, цифри, пробіл. Приклад: /clan_create 🐺 Вовки`,
  name_taken: 'Клан із такою назвою вже є.', not_enough_tickets: 'Замало білетів.',
  create_cost: 'Створення клану коштує {need}🎫 (у тебе {have}). Білети — за друзів, квести й активність у чаті.', no_clan: 'Такого клану немає. /clans — усі клани',
  cooldown: 'Після виходу з клану вступити в інший можна через {left}.', full: 'У клані немає місць ({cap}/{cap}).',
  already_requested: 'Заявку вже надіслано — чекай рішення лідера.', no_rights: 'Недостатньо прав.', no_request: 'Такої заявки вже немає.',
  in_other_clan: 'Гравець уже в іншому клані.', no_clan_member: 'Ти не в клані. /clans — знайди свій', not_member: 'Цей гравець не в твоєму клані.',
  self: 'Себе вигнати не можна 🙂 /clan_leave', owner_only: 'Це може лише лідер клану.', max_deputies: `Заступників — не більше ${C.maxDeputies}.`,
  bad_emoji: 'Надішли одне емодзі, напр. /clan_emoji 🦁', bad_amount: 'Вкажи кількість числом.', treasury_low: 'У скарбниці лише {have}🎫.',
  no_target: 'Кого? Вкажи @нік або відповідай на повідомлення людини.',
};
function errText(r) {
  let t = ERR[r.error] || 'Не вийшло 🤔';
  if (r.left != null) { const h = Math.ceil(r.left / 3600e3); t = t.replace('{left}', h + ' год'); }
  return t.replace(/\{(\w+)\}/g, (m, k) => (r[k] != null ? r[k] : m));
}

// ─── Команди (чат і приват) ─────────────────────────────────────────────
function targetOf(ctx, arg) {
  const reply = ctx.message && ctx.message.reply_to_message;
  if (reply && reply.from && !reply.from.is_bot) return String(reply.from.id);
  const u = arg ? users.findByUsernameOrId(arg) : null;
  return u ? String(u.id) : null;
}

async function command(ctx, cmd) {
  const uid = String(ctx.from.id);
  const text = String(ctx.message.text || '');
  const args = text.split(/\s+/).slice(1);
  const argText = text.replace(/^\/\S+\s*/, '');
  const group = ctx.chat && ctx.chat.type !== 'private';
  const reply = (t, kb) => ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true, ...(group ? { reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true } : {}), ...(kb ? { reply_markup: kb } : {}) }).catch(() => {});
  const plain = (t) => reply(withEmoji('{:warn} ') + esc(t));
  const ok = (t) => reply(withEmoji('{:check} ') + t);
  const d = data();
  const mine = clanOfUser(d, uid);

  switch (cmd) {
    case '/clan':
      if (args[0]) { const c = findClan(d, argText); return c ? reply(clanCard(c, uid), clanKeyboard(c, uid)) : plain(ERR.no_clan); }
      return mine ? reply(clanCard(mine, uid), clanKeyboard(mine, uid)) : reply(helpText(), listKeyboard());
    case '/clan_help': return reply(helpText(), listKeyboard());
    case '/clans': return reply(listText(), listKeyboard());
    case '/clan_top': case '/clan_war': return reply(warText());
    case '/clan_info': { const c = findClan(d, argText); return c ? reply(clanCard(c, uid), clanKeyboard(c, uid)) : plain(ERR.no_clan); }
    case '/clan_members': { const c = argText ? findClan(d, argText) : mine; return c ? reply(membersText(c)) : plain(argText ? ERR.no_clan : ERR.no_clan_member); }
    case '/clan_create': {
      if (!argText) return plain(ERR.bad_name);
      const r = create(uid, argText);
      if (!r.ok) return plain(errText(r));
      await ok(`Клан ${clanTitle(r.clan)} створено! Ти — лідер {:crown}\nЗапрошуй друзів: <code>/clan_join ${esc(r.clan.tag)}</code>`);
      if (!group && notify.tg.chat && notify.tg.chat.say) notify.tg.chat.say(withEmoji(`{:lightning} Новий клан у чаті: ${clanTitle(r.clan)}! Лідер — ${whoOf(uid)}. Вступай: <code>/clan_join ${esc(r.clan.tag)}</code>`)).catch(() => {});
      return null;
    }
    case '/clan_join': {
      const c = findClan(d, argText);
      if (!c) return plain(argText ? ERR.no_clan : 'Вкажи тег клану: /clan_join ТЕГ · /clans — усі клани');
      return afterJoin(ctx, uid, join(uid, c.id), reply, group);
    }
    case '/clan_requests': {
      if (!mine) return plain(ERR.no_clan_member);
      if (!canManage(mine, uid)) return plain(ERR.no_rights);
      const reqs = mine.requests || [];
      if (!reqs.length) return reply(withEmoji('{:check} Заявок немає.'));
      return reply(card('{:applicationsIcon}', 'ЗАЯВКИ В КЛАН', reqs.map((q, i) => `${i + 1}. ${whoOf(q.uid)}`)),
        { inline_keyboard: reqs.slice(0, 8).map(q => [btn('✅ ' + plainWho(q.uid), `cl:a:${mine.id}:${q.uid}`, 'success'), btn('❌', `cl:r:${mine.id}:${q.uid}`, 'danger')]) });
    }
    case '/clan_accept': case '/clan_reject': {
      if (!mine) return plain(ERR.no_clan_member);
      const t = targetOf(ctx, args[0]);
      if (!t) return plain(ERR.no_target);
      const r = decide(uid, mine.id, t, cmd === '/clan_accept');
      if (!r.ok) return plain(errText(r));
      notifyDecision(mine, t, cmd === '/clan_accept');
      return ok(cmd === '/clan_accept' ? `${whoOf(t)} тепер у клані ${clanTitle(mine)}!` : 'Заявку відхилено.');
    }
    case '/clan_leave': {
      const r = leave(uid);
      if (!r.ok) return plain(errText(r));
      if (r.disbanded) return ok(`Ти вийшов — клан ${clanTitle(r.clan)} розпущено` + (r.share ? ` (скарбниця розділена: по ${r.share}🎫)` : '') + '.');
      return ok(`Ти вийшов із клану ${clanTitle(r.clan)}.` + (r.newOwner ? ` Новий лідер — ${whoOf(r.newOwner)}.` : ''));
    }
    case '/clan_kick': {
      const t = targetOf(ctx, args[0]);
      if (!t) return plain(ERR.no_target);
      const r = kick(uid, t);
      if (!r.ok) return plain(errText(r));
      notify.dm(t, withEmoji(`{:warn} Тебе виключили з клану ${clanTitle(r.clan)}.`));
      return ok(`${whoOf(t)} більше не в клані.`);
    }
    case '/clan_deputy': {
      const t = targetOf(ctx, args[0]);
      if (!t) return plain(ERR.no_target);
      const r = setDeputy(uid, t);
      if (!r.ok) return plain(errText(r));
      return ok(r.on ? `${whoOf(t)} — тепер заступник {:starIcon}` : `${whoOf(t)} більше не заступник.`);
    }
    case '/clan_leader': {
      const t = targetOf(ctx, args[0]);
      if (!t) return plain(ERR.no_target);
      const r = transfer(uid, t);
      if (!r.ok) return plain(errText(r));
      notify.dm(t, withEmoji(`{:crown} Тепер ти лідер клану ${clanTitle(r.clan)}!`));
      return ok(`Лідерство передано ${whoOf(t)} {:crown}`);
    }
    case '/clan_open': case '/clan_close': {
      const r = settings(uid, { open: cmd === '/clan_open' });
      if (!r.ok) return plain(errText(r));
      return ok(cmd === '/clan_open' ? 'Клан відкритий — вступ одразу {:greenCircle}' : 'Клан закритий — вступ лише за заявкою {:lockIcon}');
    }
    case '/clan_emoji': {
      const r = settings(uid, { emoji: argText });
      if (!r.ok) return plain(errText(r));
      return ok(`Новий значок клану: ${r.clan.emoji}`);
    }
    case '/clan_donate': {
      const r = donate(uid, args[0]);
      if (!r.ok) return plain(errText(r));
      return ok(`+${r.n}🎫 у скарбницю клану ${clanTitle(r.clan)} · тепер там <b>${r.clan.treasury}🎫</b>`);
    }
    case '/clan_give': {
      const t = targetOf(ctx, args[0]);
      const n = args.find(a => /^\d+$/.test(a));
      if (!t) return plain(ERR.no_target);
      const r = give(uid, t, n);
      if (!r.ok) return plain(errText(r));
      notify.dm(t, withEmoji(`{:giftBox} Лідер клану ${clanTitle(r.clan)} видав тобі <b>+${r.n}🎫</b> зі скарбниці!`));
      return ok(`${whoOf(t)} отримав <b>+${r.n}🎫</b> зі скарбниці. Лишилось: ${r.clan.treasury}🎫`);
    }
    case '/clan_disband': {
      if (!mine) return plain(ERR.no_clan_member);
      if (roleOf(mine, uid) !== 'owner') return plain(ERR.owner_only);
      if (!/^(так|yes|да)$/i.test(args[0] || '')) return plain(`Точно розпустити клан «${mine.name}»? Скарбниця розділиться між учасниками порівну. Напиши: /clan_disband так`);
      const r = disband(uid);
      if (!r.ok) return plain(errText(r));
      return ok(`Клан ${clanTitle(r.clan)} розпущено` + (r.share ? ` · кожен учасник отримав ${r.share}🎫 зі скарбниці` : '') + '.');
    }
    default: return reply(helpText(), listKeyboard());
  }
}

async function afterJoin(ctx, uid, r, reply, inGroup) {
  if (!r.ok) return reply(withEmoji('{:warn} ') + esc(errText(r)));
  const c = r.clan;
  if (r.request) {
    // Лідеру й заступникам — заявка з кнопками в особисті.
    const lv = progress.levelInfo(progress.xpOf(users.get(uid)).total);
    for (const m of [c.owner].concat(c.deputies || [])) {
      notify.dm(m, withEmoji(`{:applicationsIcon} <b>Заявка в клан</b> ${clanTitle(c)}\nВід ${whoOf(uid)} · ${lv.e} ${esc(lv.t)}, рівень ${lv.n}`),
        { reply_markup: { inline_keyboard: [[btn('ПРИЙНЯТИ', `cl:a:${c.id}:${uid}`, 'success', 'check'), btn('ВІДХИЛИТИ', `cl:r:${c.id}:${uid}`, 'danger', 'redCircle')]] } });
    }
    return reply(withEmoji(`{:pendingIcon} Заявку в клан ${clanTitle(c)} надіслано — лідер вирішить найближчим часом.`));
  }
  const t = withEmoji(`{:lightning} ${whoOf(uid)} вступив у клан ${clanTitle(c)}! Учасників: ${c.members.length}/${capOf(c)}`);
  if (!inGroup && notify.tg.chat && notify.tg.chat.say) notify.tg.chat.say(t).catch(() => {});   // вступ через бота — чат теж бачить
  return reply(t);
}

function notifyDecision(c, uid, accepted) {
  notify.dm(uid, withEmoji(accepted ? `{:check} Тебе прийнято в клан ${clanTitle(c)}! /clan — картка клану` : `{:redCircle} Заявку в клан ${clanTitle(c)} відхилено.`));
}

// Кнопки: cl:v:<id> картка · cl:j:<id> вступ · cl:m:<id> лідерборд · cl:t війна · cl:l список · cl:my мій клан
//         cl:a/r:<id>:<uid> прийняти/відхилити заявку
async function callback(ctx) {
  const data0 = String(ctx.callbackQuery.data || '');
  const [, act, id, target] = data0.split(':');
  const uid = String(ctx.from.id);
  const d = data();
  const send = (t, kb) => ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }).catch(() => {});
  if (act === 'j') {
    const r = join(uid, id);
    if (!r.ok) return ctx.answerCbQuery(errText(r), { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery(r.request ? '📝 Заявку надіслано' : '✅ Ти в клані!').catch(() => {});
    return afterJoin(ctx, uid, r, (t) => send(t), ctx.chat && ctx.chat.type !== 'private');
  }
  if (act === 'a' || act === 'r') {
    const c = d.list[id];
    const r = decide(uid, id, target, act === 'a');
    if (!r.ok) return ctx.answerCbQuery(errText(r), { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery(act === 'a' ? '✅ Прийнято' : '❌ Відхилено').catch(() => {});
    notifyDecision(c, target, act === 'a');
    await ctx.editMessageText(withEmoji(`${act === 'a' ? '{:check} Прийнято' : '{:redCircle} Відхилено'}: ${whoOf(target)} — клан ${clanTitle(c)}`), { parse_mode: 'HTML' }).catch(() => {});
    if (act === 'a' && notify.tg.chat && notify.tg.chat.say) notify.tg.chat.say(withEmoji(`{:lightning} ${whoOf(target)} вступив у клан ${clanTitle(c)}!`)).catch(() => {});
    return null;
  }
  await ctx.answerCbQuery().catch(() => {});
  if (act === 'v') { const c = d.list[id]; return c ? send(clanCard(c, uid), clanKeyboard(c, uid)) : null; }
  if (act === 'm') { const c = d.list[id]; return c ? send(membersText(c)) : null; }
  if (act === 't') return send(warText());
  if (act === 'l') return send(listText(), listKeyboard());
  if (act === 'my') { const c = clanOfUser(d, uid); return c ? send(clanCard(c, uid), clanKeyboard(c, uid)) : send(helpText(), listKeyboard()); }
  return null;
}

const COMMANDS = ['/clan', '/clans', '/clan_help', '/clan_top', '/clan_war', '/clan_info', '/clan_members', '/clan_create', '/clan_join', '/clan_requests',
  '/clan_accept', '/clan_reject', '/clan_leave', '/clan_kick', '/clan_deputy', '/clan_leader', '/clan_open', '/clan_close', '/clan_emoji', '/clan_donate', '/clan_give', '/clan_disband'];
const isClanCommand = (cmd) => COMMANDS.includes(cmd);
// Значок клану для таблиць у чаті.
function badgeOf(uid) {
  const d = data();
  const c = clanOfUser(d, uid);
  return c ? c.emoji : '';
}
function summaryOf(uid) {
  const d = data();
  const c = clanOfUser(d, uid);
  return c ? { emoji: c.emoji, name: c.name, tag: c.tag, role: roleOf(c, uid) } : null;
}

module.exports = {
  create, join, decide, leave, kick, setDeputy, transfer, settings, donate, give, disband,
  onXp, tick, finalize, finishNow, adminDelete, adminCommand, standings, command, callback, isClanCommand, badgeOf, summaryOf,
  listText, warText, helpText, clanCard, membersText, data, COMMANDS,
};
