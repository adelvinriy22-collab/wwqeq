// ==========================================================================
// КЛАНИ + КЛАНОВА ВІЙНА. Війна — подія на кілька днів (E.CLANS.eventDays):
// XP, які учасники набирають під час неї, — очки їхнього клану. У фіналі
// топ-3 клани отримують призи, власник №1 — справжній подарунок Telegram.
// Перша війна стартує сама після оновлення; наступну запускає адмін (/clanwar start).
//
// Навмисно просто: один вхід /clan — далі все кнопками (повідомлення
// редагується на місці, а не сиплеться в чат). Ролі: лідер і учасники,
// вступ вільний або за заявкою. Дані — featureFlags.clans, у гравця — u.clanId.
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
const { esc, plural } = require('../lib/util');

const C = E.CLANS;
const LINE = '━━━━━━━━━━━━━━';
const MEDAL = ['{:goldMedal}', '{:silverMedal}', '{:bronzeMedal}'];
const HOUR = 3600e3;

// ─── Дані ───────────────────────────────────────────────────────────────
function data() {
  const f = store.getFeatureFlags() || {};
  if (!f.clans || !f.clans.list) store.setFeatureFlags({ clans: { list: {}, event: null, lastWar: null } });
  return store.getFeatureFlags().clans;
}
const save = (d) => store.setFeatureFlags({ clans: d });
const r2 = (n) => Math.round(n * 100) / 100;
const running = (d) => !!(d.event && d.event.status === 'active');
const counting = (d) => running(d) && Date.now() < d.event.endsAt;
// Очки клану в поточній (або щойно завершеній) війні.
function score(d, c) {
  const id = d.event ? d.event.id : null;
  if (!c.ev || c.ev.id !== id) c.ev = { id, pts: 0, contrib: {} };
  return c.ev;
}
function clanOfUser(d, uid) {
  const u = users.get(uid);
  const c = u && u.clanId ? d.list[u.clanId] : null;
  return c && c.members.includes(String(uid)) ? c : null;
}
function findClan(d, q) {
  const w = String(q || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!w) return null;
  return Object.values(d.list).find(c => c.id === w || c.tag.toLowerCase() === w || c.name.toLowerCase() === w) || null;
}
function plainWho(uid) { const u = users.get(uid) || {}; return u.username ? '@' + u.username : (u.name || 'гравець'); }
const whoOf = (uid) => esc(plainWho(uid));
const registered = (uid) => { const u = users.get(uid); return !!(u && u.lang); };
const clanTitle = (c) => `${c.emoji} <b>${esc(c.name)}</b> [${esc(c.tag)}]`;
// Усі клани за очками; у заліку війни — від C.minMembers учасників.
function standings(d) {
  return Object.values(d.list).map(c => ({ c, pts: score(d, c).pts, contrib: score(d, c).contrib }))
    .sort((a, b) => b.pts - a.pts || a.c.createdAt - b.c.createdAt);
}
const ranked = (d) => standings(d).filter(r => r.c.members.length >= C.minMembers);
const rankOf = (d, c) => ranked(d).findIndex(r => r.c.id === c.id) + 1;

function makeTag(d, name) {
  const letters = (String(name).match(/[\p{L}\p{N}]/gu) || []).join('').toUpperCase();
  const base = letters.slice(0, 4) || 'CLAN';
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
  users.patch(uid, { clanId: c.id });
}
function removeMember(c, uid) {
  uid = String(uid);
  c.members = c.members.filter(x => x !== uid);
  users.patch(uid, { clanId: null, clanLeftAt: Date.now() });
}

// ─── Війна: старт і фінал ───────────────────────────────────────────────
function startEvent(d, days) {
  const now = Date.now();
  const n = Math.max(1, Math.min(30, Math.floor(Number(days)) || C.eventDays));
  const first = !d.event;
  d.event = { id: 'E' + now.toString(36), startAt: now, endsAt: Math.ceil((now + n * 24 * HOUR) / HOUR) * HOUR, days: n, status: 'active' };
  for (const c of Object.values(d.list)) {
    // Клани з попередньої версії (тижнева війна): очки цього тижня зберігаємо,
    // різницю за створення (було 100🎫) і скарбницю повертаємо лідеру.
    const carry = first && c.week && c.week.id === time.weekKey(now) ? c.week : null;
    c.ev = { id: d.event.id, pts: carry ? carry.pts : 0, contrib: carry ? { ...carry.contrib } : {} };
    if (first && c.cost == null) {
      const back = Math.max(0, 100 - C.createCost) + (c.treasury || 0);
      if (back > 0) users.move(c.owner, { tickets: back }, 'clan_refund', { clan: c.id });
      c.cost = C.createCost;
    }
    delete c.week; delete c.prevWeek; delete c.contribAll; delete c.deputies; delete c.treasury; delete c.total;
  }
  save(d);
  return d.event;
}
// Перша війна стартує сама (після оновлення бота).
function ensureEvent(d) {
  if (d.event) return false;
  startEvent(d, C.eventDays);
  say(startText(d.event), { reply_markup: { inline_keyboard: [[btn('КЛАНОВА ВІЙНА', 'cl:h', 'danger', 'trophy')]] } });
  return true;
}

let finalizing = false;
async function finish() {
  const d = data();
  if (finalizing || !running(d)) return null;
  finalizing = true;
  try {
    const ev = d.event;
    const rows = ranked(d).filter(r => r.pts > 0).slice(0, C.rewards.length);
    ev.status = 'ended'; ev.endedAt = Date.now();      // до await — повторний виклик не нагородить двічі
    save(d);
    const result = { event: ev.id, at: Date.now(), top: [] };
    for (let i = 0; i < rows.length; i++) {
      const { c, pts, contrib } = rows[i];
      const rw = C.rewards[i];
      const act = c.members.filter(uid => (contrib[uid] || 0) >= C.activeMin);
      const giftName = (lang) => rw.ownerGift ? `${E.getTier(rw.ownerGift).emoji} <b>${esc(E.tierName(rw.ownerGift, lang || 'uk'))}</b>` : '';
      for (const uid of act) {
        users.move(uid, { stars: rw.stars, tickets: rw.tickets }, 'clan_war', { clan: c.id, place: rw.place, event: ev.id });
        if (rw.xp) progress.addXp(uid, 'clan', rw.xp, { silent: true });
        const u = users.get(uid) || {};
        notify.dm(uid, withEmoji(`{:trophy} <b>КЛАНОВА ВІЙНА — ${rw.place} МІСЦЕ!</b>\n${LINE}\nТвій клан ${clanTitle(c)} — <b>${Math.floor(pts)}</b> очок.\n\n` +
          `{:giftBox} Твій приз: <b>+${rw.stars}⭐ +${rw.tickets}🎫 +${rw.xp} XP</b> — уже на балансі` +
          (uid === c.owner && rw.ownerGift ? `\n{:crown} А як власнику — ще й ${giftName(u.lang)} справжнім подарунком Telegram!` : '')));
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
        if (!act.includes(c.owner)) {
          const ou = users.get(c.owner) || {};
          notify.dm(c.owner, withEmoji(`{:trophy} <b>КЛАНОВА ВІЙНА — ${rw.place} МІСЦЕ!</b>\n${LINE}\nТвій клан ${clanTitle(c)} на п’єдесталі. {:crown} Як власнику — ${giftName(ou.lang)}!\n\n` +
            `<i>Особисті призи (+${rw.stars}⭐ +${rw.tickets}🎫) — тим, хто набрав від ${C.activeMin} очок.</i>`));
        }
      }
      if (i === 0) c.wins = (c.wins || 0) + 1;
      const mvp = Object.entries(contrib).filter(([uid]) => c.members.includes(uid)).sort((a, b) => b[1] - a[1])[0];
      result.top.push({ id: c.id, name: c.name, emoji: c.emoji, tag: c.tag, pts: Math.floor(pts), rewarded: act.length, place: rw.place, gift, mvp: mvp ? mvp[0] : null });
    }
    d.lastWar = result;
    save(d);
    say(resultText(result));
    return result;
  } finally { finalizing = false; }
}

async function tick() {
  const d = data();
  ensureEvent(d);
  if (running(d) && Date.now() >= d.event.endsAt) return finish();
  return null;
}

// ─── Дії гравців ────────────────────────────────────────────────────────
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
  const c = { id, name, tag: makeTag(d, name), emoji, owner: uid, members: [], open: true, requests: [], cost: C.createCost, wins: 0, createdAt: Date.now(), ev: null };
  d.list[id] = c;
  addMember(c, uid);
  save(d);
  return { ok: true, clan: c };
}

function join(uid, clanId) {
  uid = String(uid);
  const d = data();
  if (!registered(uid)) return { ok: false, error: 'not_registered' };
  const cur = clanOfUser(d, uid);
  if (cur) return { ok: false, error: cur.id === clanId ? 'already_member' : 'already_in_clan' };
  const c = d.list[clanId];
  if (!c) return { ok: false, error: 'no_clan' };
  const u = users.get(uid) || {};
  const wait = (u.clanLeftAt || 0) + C.rejoinHours * HOUR - Date.now();
  if (wait > 0) return { ok: false, error: 'cooldown', left: wait };
  if (c.members.length >= C.cap) return { ok: false, error: 'full' };
  if (!c.open) {
    if ((c.requests || []).some(r => r.uid === uid)) return { ok: false, error: 'already_requested' };
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
  if (c.owner !== String(byUid)) return { ok: false, error: 'owner_only' };
  if (!(c.requests || []).some(r => r.uid === String(uid))) return { ok: false, error: 'no_request' };
  c.requests = c.requests.filter(r => r.uid !== String(uid));
  if (accept) {
    if (clanOfUser(d, uid)) { save(d); return { ok: false, error: 'in_other_clan' }; }
    if (c.members.length >= C.cap) { save(d); return { ok: false, error: 'full' }; }
    addMember(c, uid);
  }
  save(d);
  return { ok: true, clan: c };
}

function leave(uid) {
  uid = String(uid);
  const d = data();
  const c = clanOfUser(d, uid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  removeMember(c, uid);
  if (c.owner === uid) {
    if (!c.members.length) { delete d.list[c.id]; save(d); return { ok: true, clan: c, disbanded: true }; }
    // Лідерство — тому, хто найбільше приніс клану у війні.
    const s = score(d, c);
    c.owner = c.members.slice().sort((a, b) => (s.contrib[b] || 0) - (s.contrib[a] || 0))[0];
    notify.dm(c.owner, withEmoji(`{:crown} Тепер ти лідер клану ${clanTitle(c)}!`));
    save(d);
    return { ok: true, clan: c, newOwner: c.owner };
  }
  save(d);
  return { ok: true, clan: c };
}

function kick(byUid, target) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (c.owner !== String(byUid)) return { ok: false, error: 'owner_only' };
  target = String(target);
  if (target === String(byUid)) return { ok: false, error: 'self' };
  if (!c.members.includes(target)) return { ok: false, error: 'not_member' };
  removeMember(c, target);
  save(d);
  return { ok: true, clan: c };
}

function setOpen(byUid, open) {
  const d = data();
  const c = clanOfUser(d, byUid);
  if (!c) return { ok: false, error: 'no_clan_member' };
  if (c.owner !== String(byUid)) return { ok: false, error: 'owner_only' };
  c.open = !!open;
  save(d);
  return { ok: true, clan: c };
}

// ─── Очки: XP учасників під час війни ───────────────────────────────────
function onXp(uid, src, gain) {
  if (!gain || src === 'clan' || src === 'admin') return;
  const u = users.get(uid);
  if (!u || !u.clanId) return;
  const d = data();
  if (!counting(d)) return;
  const c = d.list[u.clanId];
  if (!c || !c.members.includes(String(uid))) return;
  const s = score(d, c);
  s.pts = r2(s.pts + gain);
  s.contrib[uid] = r2((s.contrib[uid] || 0) + gain);
  save(d);
}

// ─── Тексти ─────────────────────────────────────────────────────────────
const card = (icon, title, lines, foot) => withEmoji(icon + ' <b>' + title + '</b>\n' + LINE + '\n' +
  lines.filter(l => l !== null && l !== undefined && l !== false).join('\n') + (foot ? '\n\n<i>' + foot + '</i>' : ''));
function btn(text, data, style, icon) {
  const b = { text, callback_data: data };
  if (style) b.style = style;
  if (icon && EMOJI[icon] && EMOJI[icon].id) b.icon_custom_emoji_id = EMOJI[icon].id;
  return b;
}
const daysWord = (n) => n + ' ' + plural(n, 'день', 'дні', 'днів');
const whenText = (ts) => time.fmtKyiv(ts, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function prizeLines() {
  return C.rewards.map((rw, i) => MEDAL[i] + ' ' +
    (rw.ownerGift ? `власнику ${E.getTier(rw.ownerGift).emoji} ${E.getTier(rw.ownerGift).price}⭐ · ` : '') +
    `кожному <b>+${rw.stars}⭐ +${rw.tickets}🎫</b> +${rw.xp} XP`);
}
function myLine(d, uid) {
  const c = uid ? clanOfUser(d, uid) : null;
  if (!c) return 'Ти ще без клану — вступай або створи свій 👇';
  const r = rankOf(d, c), need = C.minMembers - c.members.length;
  return `Твій клан: ${clanTitle(c)} · ` + (r ? `<b>#${r}</b> · ${Math.floor(score(d, c).pts)} очок` : `ще ${need} учасн. — і клан у заліку`);
}

function startText(ev) {
  return card('{:trophy}', `СТАРТУЄ КЛАНОВА ВІЙНА — ${daysWord(ev.days).toUpperCase()}!`, [
    'Об’єднуйтесь у клани: <b>кожен XP учасника — очко для клану.</b>',
    `{:clockIcon} Фінал: <b>${whenText(ev.endsAt)}</b> (Київ)`,
    '',
    '{:giftBox} <b>Призи топ-3 кланам:</b>',
    ...prizeLines(),
    '',
    `👉 /clan — вступити або створити свій (${C.createCost}🎫)`,
  ]);
}

function hubText(uid) {
  const d = data();
  const top = ranked(d).filter(r => r.pts > 0).slice(0, 3);
  if (running(d)) {
    return card('{:trophy}', 'КЛАНОВА ВІЙНА', [
      `{:clockIcon} До фіналу: <b>${time.humanLeft(d.event.endsAt - Date.now())}</b>`,
      '',
      '{:giftBox} <b>Призи топ-3 кланам:</b>',
      ...prizeLines(),
      '',
      top.length ? '{:lightning} <b>Зараз лідирують:</b>' : '{:lightning} Поки ніхто не набрав очок — перше місце вільне!',
      ...top.map((r, i) => `${MEDAL[i]} ${clanTitle(r.c)} — <b>${Math.floor(r.pts)}</b>`),
      '',
      myLine(d, uid),
    ], 'Очки клану — XP учасників: пиши в чаті, грай, крути колесо');
  }
  const lw = d.lastWar;
  return card('{:trophy}', 'КЛАНОВА ВІЙНА ЗАВЕРШЕНА', [
    ...(lw && lw.top.length ? lw.top.map((t, i) => `${MEDAL[i]} ${t.emoji} <b>${esc(t.name)}</b> — ${t.pts}`) : ['Цього разу жоден клан не потрапив у залік.']),
    '',
    lw && lw.top.length ? '{:check} Призи вже видано переможцям.' : null,
    'Наступна війна — скоро, стеж за чатом!',
    '',
    myLine(d, uid),
  ]);
}
function hubKb(uid, priv) {
  const mine = uid && clanOfUser(data(), uid);
  const rows = [
    [mine ? btn('МІЙ КЛАН', 'cl:my', 'success', 'crown') : btn('СТВОРИТИ КЛАН', 'cl:new', 'success', 'lightning'), btn('УСІ КЛАНИ', 'cl:l', 'primary', 'statsIcon')],
    [btn('ЯК ЦЕ ПРАЦЮЄ', 'cl:help', null, 'infoIcon')],
  ];
  if (priv) rows.push([btn('НАЗАД', 'back_to_menu', null, 'back')]);
  return { inline_keyboard: rows };
}

function clanText(c) {
  const d = data();
  const s = score(d, c);
  const r = rankOf(d, c), need = C.minMembers - c.members.length;
  const rows = c.members.slice().sort((a, b) => (s.contrib[b] || 0) - (s.contrib[a] || 0));
  return card(c.emoji, esc(c.name.toUpperCase()) + ' [' + esc(c.tag) + ']', [
    '{:trophy} ' + (r ? `<b>#${r}</b> у війні · <b>${Math.floor(s.pts)}</b> очок` : `<b>${Math.floor(s.pts)}</b> очок · ще ${need} учасн. — і клан у заліку`),
    `👥 ${c.members.length}/${C.cap} · ` + (c.open ? '{:greenCircle} вступ вільний' : '{:lockIcon} вступ за заявкою'),
    `{:crown} Лідер: ${whoOf(c.owner)}`,
    '',
    ...rows.slice(0, 10).map((uid, i) => `${i < 3 ? MEDAL[i] : (i + 1) + '.'} ${whoOf(uid)} — ${Math.floor(s.contrib[uid] || 0)}` + ((s.contrib[uid] || 0) >= C.activeMin ? ' {:check}' : '')),
    rows.length > 10 ? `…і ще ${rows.length - 10}` : null,
  ], `{:check} — набрав ${C.activeMin}+ очок: отримає приз, якщо клан у топ-3`);
}
function clanKb(c, uid) {
  const rows = [];
  if (!c.members.includes(String(uid))) rows.push([btn(c.open ? 'ВСТУПИТИ' : 'ПОДАТИ ЗАЯВКУ', 'cl:j:' + c.id, 'success', 'lightning')]);
  rows.push([btn('ДО ВІЙНИ', 'cl:h', null, 'back'), btn('УСІ КЛАНИ', 'cl:l', 'primary', 'statsIcon')]);
  return { inline_keyboard: rows };
}

function listText() {
  const all = standings(data());
  if (!all.length) return card('{:statsIcon}', 'УСІ КЛАНИ', ['Поки жодного клану — стань першим!', '', `<code>/clan_create Назва</code> — ${C.createCost}🎫`]);
  const lines = all.slice(0, 15).map(({ c, pts }, i) => `${i + 1}. ${clanTitle(c)} — <b>${Math.floor(pts)}</b> · 👥 ${c.members.length}/${C.cap} ` + (c.open ? '{:greenCircle}' : '{:lockIcon}'));
  if (all.length > 15) lines.push(`…і ще ${all.length - 15}`);
  return card('{:statsIcon}', 'УСІ КЛАНИ · ' + all.length, lines, '{:greenCircle} вступ вільний · {:lockIcon} за заявкою. Обери клан кнопкою 👇');
}
function listKb() {
  const b = standings(data()).slice(0, 8).map(({ c }) => btn(`${c.emoji} ${c.name}`, 'cl:v:' + c.id));
  const rows = [];
  for (let i = 0; i < b.length; i += 2) rows.push(b.slice(i, i + 2));
  rows.push([btn('ДО ВІЙНИ', 'cl:h', null, 'back')]);
  return { inline_keyboard: rows };
}

function helpText() {
  const d = data();
  return card('{:infoIcon}', 'ЯК ПРАЦЮЮТЬ КЛАНИ', [
    '1️⃣ Вступи в клан — «Усі клани» або <code>/clan_join ТЕГ</code>',
    `2️⃣ Або створи свій: <code>/clan_create Назва</code> — ${C.createCost}🎫 (з ${C.minLevel}-го рівня)`,
    '3️⃣ Кожен твій XP — очко для клану: пиши в чаті, грай, крути колесо',
    `4️⃣ ${running(d) ? 'Фінал через <b>' + time.humanLeft(d.event.endsAt - Date.now()) + '</b>' : 'У фіналі'}: топ-3 клани отримують призи`,
    '',
    `Приз отримує кожен, хто набрав від <b>${C.activeMin}</b> очок. У заліку — клани від ${C.minMembers} учасників.`,
    '',
    'Вийти: <code>/clan_leave</code>',
    'Лідеру: <code>/clan_close</code> — вступ за заявкою · <code>/clan_kick @нік</code>',
  ]);
}
const helpKb = () => ({ inline_keyboard: [[btn('ДО ВІЙНИ', 'cl:h', null, 'back'), btn('УСІ КЛАНИ', 'cl:l', 'primary', 'statsIcon')]] });

function resultText(res) {
  const lines = res.top.map((t, i) => `${MEDAL[i]} ${t.emoji} <b>${esc(t.name)}</b> — ${t.pts} очок · призи: ${t.rewarded}` + (t.mvp ? ` · MVP ${whoOf(t.mvp)}` : ''));
  if (!lines.length) lines.push('Цього разу жоден клан не потрапив у залік.');
  else lines.push('', '{:giftBox} Нагороди вже на балансах переможців!');
  return card('{:trophy}', 'ФІНАЛ КЛАНОВОЇ ВІЙНИ', lines, 'Дякуємо всім кланам! Наступна війна — скоро');
}

const ERR = {
  not_registered: 'Спершу запусти бота — і повертайся 🙂', already_in_clan: 'Ти вже в клані. Спершу /clan_leave', already_member: 'Ти вже в цьому клані 🙂',
  low_level: 'Створити клан можна з {need}-го рівня (у тебе {have}). Поки вступи в наявний — /clans',
  bad_name: `Назва — від ${C.nameMin} до ${C.nameMax} символів: літери, цифри, пробіл. Приклад: /clan_create Вовки`,
  name_taken: 'Клан із такою назвою вже є.', create_cost: 'Створення клану коштує {need}🎫 (у тебе {have}).',
  no_clan: 'Такого клану немає. /clans — усі клани', cooldown: 'Після виходу з клану вступити в інший можна через {left}.',
  full: `У клані вже ${C.cap}/${C.cap} — місць немає.`, already_requested: 'Заявку вже надіслано — чекай рішення лідера.',
  owner_only: 'Це може лише лідер клану.', no_request: 'Такої заявки вже немає.', in_other_clan: 'Гравець уже в іншому клані.',
  no_clan_member: 'Ти не в клані. /clans — знайди свій', not_member: 'Цей гравець не в твоєму клані.', self: 'Себе вигнати не можна 🙂 /clan_leave',
  no_target: 'Кого? Вкажи @нік або відповідай на повідомлення людини.',
};
function errText(r) {
  let t = ERR[r.error] || 'Не вийшло 🤔';
  if (r.left != null) t = t.replace('{left}', Math.ceil(r.left / HOUR) + ' год');
  return t.replace(/\{(\w+)\}/g, (m, k) => (r[k] != null ? r[k] : m));
}

// ─── Команди (чат і приват) ─────────────────────────────────────────────
const COMMANDS = ['/clan', '/clans', '/clan_top', '/clan_war', '/clan_help', '/clan_info', '/clan_members', '/clan_create', '/clan_join',
  '/clan_requests', '/clan_accept', '/clan_reject', '/clan_leave', '/clan_kick', '/clan_open', '/clan_close'];
const isClanCommand = (cmd) => COMMANDS.includes(cmd);

function targetOf(ctx, arg) {
  const reply = ctx.message && ctx.message.reply_to_message;
  if (reply && reply.from && !reply.from.is_bot) return String(reply.from.id);
  const u = arg ? users.findByUsernameOrId(arg) : null;
  return u ? String(u.id) : null;
}
function say(text, extra) { const chat = notify.tg.chat; if (chat && chat.say) chat.say(text, extra).catch(() => {}); }

async function command(ctx, cmd) {
  const uid = String(ctx.from.id);
  const text = String(ctx.message.text || '');
  const argText = text.replace(/^\/\S+\s*/, '').trim();
  const group = ctx.chat && ctx.chat.type !== 'private';
  const reply = (t, kb) => ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true,
    ...(group ? { reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true } : {}), ...(kb ? { reply_markup: kb } : {}) }).catch(() => {});
  const fail = (r) => reply(withEmoji('{:warn} ') + esc(typeof r === 'string' ? r : errText(r)));
  const ok = (t) => reply(withEmoji('{:check} ' + t));
  const d = data();
  ensureEvent(d);
  const mine = clanOfUser(d, uid);

  switch (cmd) {
    case '/clan': case '/clan_top': case '/clan_war': {
      const c = argText && cmd === '/clan' ? findClan(d, argText) : null;
      if (argText && cmd === '/clan' && !c) return fail(ERR.no_clan);
      return c ? reply(clanText(c), clanKb(c, uid)) : reply(hubText(uid), hubKb(uid, !group));
    }
    case '/clans': return reply(listText(), listKb());
    case '/clan_help': return reply(helpText(), helpKb());
    case '/clan_info': case '/clan_members': {
      const c = argText ? findClan(d, argText) : mine;
      return c ? reply(clanText(c), clanKb(c, uid)) : fail(argText ? ERR.no_clan : ERR.no_clan_member);
    }
    case '/clan_create': {
      if (!argText) return fail(ERR.bad_name);
      const r = create(uid, argText);
      if (!r.ok) return fail(r);
      if (!group) say(withEmoji(`{:lightning} Новий клан: ${clanTitle(r.clan)}! Лідер — ${whoOf(uid)}. Вступай: <code>/clan_join ${esc(r.clan.tag)}</code>`));
      return ok(`Клан ${clanTitle(r.clan)} створено! Ти — лідер {:crown}\nКлич друзів: <code>/clan_join ${esc(r.clan.tag)}</code>` +
        `\n<i>У залік війни клан потрапить із ${C.minMembers} учасників.</i>`);
    }
    case '/clan_join': {
      const c = findClan(d, argText);
      if (!c) return argText ? fail(ERR.no_clan) : reply(listText(), listKb());
      return afterJoin(uid, join(uid, c.id), reply, group);
    }
    case '/clan_requests': {
      if (!mine) return fail(ERR.no_clan_member);
      if (mine.owner !== uid) return fail(ERR.owner_only);
      const reqs = mine.requests || [];
      if (!reqs.length) return ok('Заявок немає.');
      return reply(card('{:applicationsIcon}', 'ЗАЯВКИ В КЛАН', reqs.slice(0, 8).map((q, i) => `${i + 1}. ${whoOf(q.uid)}`)),
        { inline_keyboard: reqs.slice(0, 8).map(q => [btn('✅ ' + plainWho(q.uid), `cl:a:${mine.id}:${q.uid}`, 'success'), btn('❌', `cl:r:${mine.id}:${q.uid}`, 'danger')]) });
    }
    case '/clan_accept': case '/clan_reject': {
      if (!mine) return fail(ERR.no_clan_member);
      const t = targetOf(ctx, argText.split(/\s+/)[0]);
      if (!t) return fail(ERR.no_target);
      const r = decide(uid, mine.id, t, cmd === '/clan_accept');
      if (!r.ok) return fail(r);
      notifyDecision(mine, t, cmd === '/clan_accept');
      return ok(cmd === '/clan_accept' ? `${whoOf(t)} тепер у клані ${clanTitle(mine)}!` : 'Заявку відхилено.');
    }
    case '/clan_leave': {
      const r = leave(uid);
      if (!r.ok) return fail(r);
      if (r.disbanded) return ok(`Ти вийшов — клан ${clanTitle(r.clan)} розпущено.`);
      return ok(`Ти вийшов із клану ${clanTitle(r.clan)}.` + (r.newOwner ? ` Новий лідер — ${whoOf(r.newOwner)}.` : ''));
    }
    case '/clan_kick': {
      const t = targetOf(ctx, argText.split(/\s+/)[0]);
      if (!t) return fail(ERR.no_target);
      const r = kick(uid, t);
      if (!r.ok) return fail(r);
      notify.dm(t, withEmoji(`{:warn} Тебе виключили з клану ${clanTitle(r.clan)}.`));
      return ok(`${whoOf(t)} більше не в клані.`);
    }
    case '/clan_open': case '/clan_close': {
      const r = setOpen(uid, cmd === '/clan_open');
      if (!r.ok) return fail(r);
      return ok(cmd === '/clan_open' ? 'Клан відкритий — вступ вільний {:greenCircle}' : 'Тепер вступ лише за заявкою {:lockIcon} — заявки приходитимуть тобі в бота');
    }
    default: return reply(hubText(uid), hubKb(uid, !group));
  }
}

async function afterJoin(uid, r, reply, inGroup) {
  if (!r.ok) return reply(withEmoji('{:warn} ') + esc(errText(r)));
  const c = r.clan;
  if (r.request) {
    const lv = progress.levelInfo(progress.xpOf(users.get(uid)).total);
    notify.dm(c.owner, withEmoji(`{:applicationsIcon} <b>Заявка в клан</b> ${clanTitle(c)}\nВід ${whoOf(uid)} · ${lv.e} ${esc(lv.t)}, рівень ${lv.n}`),
      { reply_markup: { inline_keyboard: [[btn('ПРИЙНЯТИ', `cl:a:${c.id}:${uid}`, 'success', 'check'), btn('ВІДХИЛИТИ', `cl:r:${c.id}:${uid}`, 'danger', 'redCircle')]] } });
    return reply(withEmoji(`{:pendingIcon} Заявку в клан ${clanTitle(c)} надіслано — лідер вирішить найближчим часом.`));
  }
  const t = withEmoji(`{:lightning} ${whoOf(uid)} вступив у клан ${clanTitle(c)}! 👥 ${c.members.length}/${C.cap}`);
  if (!inGroup) say(t);                                          // вступ через бота — чат теж бачить
  return reply(t);
}
function notifyDecision(c, uid, accepted) {
  notify.dm(uid, withEmoji(accepted ? `{:check} Тебе прийнято в клан ${clanTitle(c)}! /clan — кланова війна` : `{:redCircle} Заявку в клан ${clanTitle(c)} відхилено.`));
}

// Кнопки (повідомлення редагується на місці):
//   cl:h війна · cl:l усі клани · cl:v:<id> клан · cl:my мій клан · cl:help як це працює
//   cl:new як створити · cl:j:<id> вступ · cl:a|r:<id>:<uid> прийняти / відхилити заявку
async function callback(ctx) {
  const [, act, id, target] = String(ctx.callbackQuery.data || '').split(':');
  const uid = String(ctx.from.id);
  const priv = !ctx.chat || ctx.chat.type === 'private';
  const d = data();
  ensureEvent(d);
  const show = async (t, kb) => {
    try { await ctx.editMessageText(t, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb }); }
    catch (e) {
      if (/not modified/i.test(String((e && (e.description || e.message)) || ''))) return;
      await ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb }).catch(() => {});
    }
  };
  const send = (t) => ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});

  if (act === 'j') {
    const r = join(uid, id);
    if (!r.ok) return ctx.answerCbQuery(errText(r), { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery(r.request ? '📝 Заявку надіслано' : '✅ Ти в клані!').catch(() => {});
    await show(clanText(r.clan), clanKb(r.clan, uid));
    return afterJoin(uid, r, send, !priv);
  }
  if (act === 'a' || act === 'r') {
    const c = d.list[id];
    const r = decide(uid, id, target, act === 'a');
    if (!r.ok) return ctx.answerCbQuery(errText(r), { show_alert: true }).catch(() => {});
    await ctx.answerCbQuery(act === 'a' ? '✅ Прийнято' : '❌ Відхилено').catch(() => {});
    notifyDecision(c, target, act === 'a');
    await ctx.editMessageText(withEmoji(`${act === 'a' ? '{:check} Прийнято' : '{:redCircle} Відхилено'}: ${whoOf(target)} — клан ${clanTitle(c)}`), { parse_mode: 'HTML' }).catch(() => {});
    if (act === 'a') say(withEmoji(`{:lightning} ${whoOf(target)} вступив у клан ${clanTitle(c)}! 👥 ${c.members.length}/${C.cap}`));
    return null;
  }
  if (act === 'new') {
    const lv = registered(uid) ? progress.levelInfo(progress.xpOf(users.get(uid)).total).n : 0;
    return ctx.answerCbQuery(`Напиши в чат:\n/clan_create Назва\n\nЦіна — ${C.createCost}🎫, з ${C.minLevel}-го рівня` +
      (lv && lv < C.minLevel ? ` (у тебе ${lv}). Поки вступи в наявний клан!` : '. Можна з емодзі: /clan_create 🐺 Вовки'), { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
  if (act === 'h') return show(hubText(uid), hubKb(uid, priv));
  if (act === 'l') return show(listText(), listKb());
  if (act === 'help') return show(helpText(), helpKb());
  if (act === 'v') { const c = d.list[id]; return c ? show(clanText(c), clanKb(c, uid)) : show(listText(), listKb()); }
  if (act === 'my') { const c = clanOfUser(d, uid); return c ? show(clanText(c), clanKb(c, uid)) : show(hubText(uid), hubKb(uid, priv)); }
  return null;
}

// ─── Адмін: /clanwar ────────────────────────────────────────────────────
function adminDelete(q) {
  const d = data();
  const c = findClan(d, q);
  if (!c) return { ok: false, error: 'no_clan' };
  for (const uid of c.members.slice()) removeMember(c, uid);
  delete d.list[c.id];
  save(d);
  return { ok: true, clan: c };
}
async function adminCommand(ctx) {
  const [sub, ...rest] = String(ctx.message.text || '').split(/\s+/).slice(1);
  const reply = (t) => ctx.reply(t, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  const d = data();
  ensureEvent(d);
  if (sub === 'finish') {
    if (!running(d)) return reply('Війна зараз не йде. /clanwar start — запустити нову.');
    const r = await finish();
    if (!r) return reply('⏳ Підсумки вже підбиваються.');
    if (!r.top.length) return reply(`🏁 Війну завершено. Нікого нагороджувати: жоден клан від ${C.minMembers} учасників не набрав очок.`);
    return reply('🏁 Підсумки війни підбито:\n' + r.top.map(t => `${t.place}. ${t.emoji} ${esc(t.name)} — ${t.pts} очок · призи: ${t.rewarded}` +
      (t.gift ? ` · подарунок власнику: ${t.gift === 'sent' ? 'надіслано' : 'заявка'}` : '')).join('\n'));
  }
  if (sub === 'start') {
    if (running(d)) return reply(`Війна вже йде — фінал ${whenText(d.event.endsAt)}. /clanwar finish — завершити зараз.`);
    const ev = startEvent(d, rest[0] || C.eventDays);
    say(startText(ev), { reply_markup: { inline_keyboard: [[btn('КЛАНОВА ВІЙНА', 'cl:h', 'danger', 'trophy')]] } });
    return reply(`⚔️ Нова кланова війна стартувала на ${daysWord(ev.days)} — фінал ${whenText(ev.endsAt)}. Оголошення в чаті надіслано.`);
  }
  if (sub === 'delete') {
    const r = adminDelete(rest.join(' '));
    return reply(r.ok ? `🗑 Клан ${clanTitle(r.clan)} видалено.` : errText(r));
  }
  const n = Object.keys(d.list).length;
  const members = Object.values(d.list).reduce((a, c) => a + c.members.length, 0);
  return reply(hubText(null) + `\n\n<b>Адміну:</b> кланів ${n}, у кланах ${members} гравців.\n` +
    '/clanwar finish — завершити війну зараз і видати призи\n/clanwar start 3 — нова війна на 3 дні\n/clanwar delete ТЕГ — видалити клан');
}

// Для таблиць і профілю в чаті.
function badgeOf(uid) { const c = clanOfUser(data(), uid); return c ? c.emoji : ''; }
function summaryOf(uid) { const c = clanOfUser(data(), uid); return c ? { emoji: c.emoji, name: c.name, tag: c.tag, owner: c.owner === String(uid) } : null; }

module.exports = {
  create, join, decide, leave, kick, setOpen, onXp, tick, finish, startEvent, adminDelete, adminCommand,
  command, callback, isClanCommand, badgeOf, summaryOf, standings, data, COMMANDS,
};
