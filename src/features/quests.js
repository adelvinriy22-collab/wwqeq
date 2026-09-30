// ==========================================================================
// ЗАВДАННЯ:
//   • Завдання дня — три прості дії щодня (одна завжди «щоденний спін»),
//     за кожну +1🎫 і XP, за всі три — ще бонус.
//   • Питання дня — правильна відповідь дає бонусний спін.
//   • Партнерські завдання й секретне завдання — з перевіркою адміном.
// ==========================================================================
const config = require('../config');
const store = require('../store');
const users = require('../core/users');
const progress = require('../core/progress');
const notify = require('../core/notify');
const time = require('../lib/time');
const { esc } = require('../lib/util');

// ─── Завдання дня ───────────────────────────────────────────────────────
const DAILY_POOL = {
  spin_daily:   { need: 1, t: { uk: 'Крутни щоденне колесо', en: 'Spin the daily wheel', ru: 'Крутни ежедневное колесо' }, go: 'wheel:daily' },
  quiz:         { need: 1, t: { uk: 'Відповідай на питання дня', en: 'Answer the question of the day', ru: 'Ответь на вопрос дня' }, go: 'quests' },
  game:         { need: 3, t: { uk: 'Зіграй 3 гри', en: 'Play 3 games', ru: 'Сыграй 3 игры' }, go: 'games' },
  spin_tickets: { need: 1, t: { uk: 'Крутни колесо білетів', en: 'Spin the ticket wheel', ru: 'Крутни колесо билетов' }, go: 'wheel:referral' },
  spin_paid:    { need: 1, t: { uk: 'Крутни колесо «За зірки»', en: 'Spin the stars wheel', ru: 'Крутни колесо «За звёзды»' }, go: 'wheel:paid' },
  bank:         { need: 1, t: { uk: 'Зроби ставку в банк', en: 'Bet in the bank', ru: 'Сделай ставку в банк' }, go: 'bank' },
  risk:         { need: 1, t: { uk: 'Ризикни ×2 після спіну', en: 'Try risk ×2 after a spin', ru: 'Рискни ×2 после спина' }, go: 'wheel:daily' },
};
const DAILY_REWARD = { tickets: 1, xp: 10 };
const DAILY_ALL = { tickets: 3, xp: 30 };

function dailySet(day) {
  let h = 0; for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const extra = ['game', 'spin_tickets', 'bank', 'risk', 'spin_paid'];
  return ['spin_daily', 'quiz', extra[h % extra.length]];
}
function dailyState(u, day) {
  return u.dq && u.dq.day === day ? u.dq : { day, p: {}, d: {}, all: false };
}

// Прогрес дії. Нагорода нараховується одразу, щойно завдання виконано.
function track(uid, key, n) {
  const u = users.get(uid);
  if (!u || !u.lang) return;
  const day = time.dayKey(Date.now());
  const set = dailySet(day);
  if (!set.includes(key)) return;
  const s = dailyState(u, day);
  if (s.d[key]) return;
  const q = DAILY_POOL[key];
  s.p = { ...s.p, [key]: (s.p[key] || 0) + (n || 1) };
  let doneNow = false;
  if (s.p[key] >= q.need) { s.d = { ...s.d, [key]: true }; doneNow = true; }
  const allNow = !s.all && set.every(k => s.d[k]);
  if (allNow) s.all = true;
  users.patch(uid, { dq: s });
  if (doneNow) { users.move(uid, { tickets: DAILY_REWARD.tickets }, 'quest', { q: key }); progress.addXp(uid, 'quest', DAILY_REWARD.xp); }
  if (allNow) { users.move(uid, { tickets: DAILY_ALL.tickets }, 'quest', { q: 'all' }); progress.addXp(uid, 'quest', DAILY_ALL.xp); }
}

function dailyView(u, lang) {
  const day = time.dayKey(Date.now());
  const s = dailyState(u, day);
  return {
    day, all: s.all, reward: DAILY_REWARD, allReward: DAILY_ALL,
    items: dailySet(day).map(k => ({ key: k, title: DAILY_POOL[k].t[lang] || DAILY_POOL[k].t.uk, need: DAILY_POOL[k].need,
      progress: Math.min(DAILY_POOL[k].need, s.p[k] || 0), done: !!s.d[k], go: DAILY_POOL[k].go })),
    endsAt: time.parseKyiv(time.dayKey(Date.now() + time.DAY_MS) + ' 00:00'),
  };
}

// ─── Питання дня ────────────────────────────────────────────────────────
const QUIZ = [
  { q: { uk: 'Скільки секторів на щоденному колесі?', en: 'How many sectors does the daily wheel have?', ru: 'Сколько секторов на ежедневном колесе?' }, a: ['10', '12', '14'], ok: 2 },
  { q: { uk: 'Який шанс виграти в ризик-грі ×2?', en: 'What is the chance to win risk ×2?', ru: 'Какой шанс выиграть в риск ×2?' }, a: ['45%', '50%', '60%'], ok: 0 },
  { q: { uk: 'Скільки коштує спін колеса «За зірки»?', en: 'How much is a stars-wheel spin?', ru: 'Сколько стоит спин колеса «За звёзды»?' }, a: ['10⭐', '15⭐', '25⭐'], ok: 1 },
  { q: { uk: 'Через скільки годин оновлюється безкоштовний спін?', en: 'How many hours until the free spin refreshes?', ru: 'Через сколько часов обновляется бесплатный спин?' }, a: ['12', '24', '48'], ok: 1 },
  { q: { uk: 'Скільки друзів треба запросити для виводу зірок?', en: 'How many friends are needed to withdraw?', ru: 'Сколько друзей нужно для вывода?' }, a: ['1', '3', '5'], ok: 1 },
  { q: { uk: 'Яка комісія на вивід зірок?', en: 'What is the withdrawal fee?', ru: 'Какая комиссия на вывод?' }, a: ['5%', '10%', '15%'], ok: 0 },
  { q: { uk: 'Скільки білетів коштує спін колеса білетів?', en: 'How many tickets is a ticket-wheel spin?', ru: 'Сколько билетов стоит спин колеса билетов?' }, a: ['3', '5', '10'], ok: 1 },
  { q: { uk: 'Скільки разів поспіль можна подвоїти виграш?', en: 'How many times in a row can you double?', ru: 'Сколько раз подряд можно удвоить выигрыш?' }, a: ['2', '3', '5'], ok: 1 },
  { q: { uk: 'Який приз найдорожчий у боті?', en: 'Which prize is the most valuable?', ru: 'Какой приз самый дорогой?' }, a: ['Evil Eye', 'Diamond Ring', 'Трофей'], ok: 1 },
  { q: { uk: 'Скільки білетів дають 2⭐ при обміні?', en: 'How many tickets make 2⭐ in exchange?', ru: 'Сколько билетов дают 2⭐ при обмене?' }, a: ['5', '10', '20'], ok: 1 },
  { q: { uk: 'Що дає кожен запрошений друг?', en: 'What does each invited friend give?', ru: 'Что даёт каждый приглашённый друг?' }, a: ['1⭐', '1🎫', '5🎫'], ok: 1 },
  { q: { uk: 'Що отримує кожен учасник банку, навіть програвши?', en: 'What does every bank player get, even when losing?', ru: 'Что получает каждый участник банка, даже проиграв?' }, a: ['Нічого', 'Утішні білети', 'Зірку'], ok: 1 },
];

function quizToday() {
  const day = time.dayKey(Date.now());
  let h = 0; for (const ch of day) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return { day, idx: h % QUIZ.length, ...QUIZ[h % QUIZ.length] };
}
function quizView(u, lang) {
  const q = quizToday();
  const answered = u.quizDay === q.day;
  return { question: q.q[lang] || q.q.uk, answers: q.a, answered, right: answered ? !!u.quizRight : null, correct: answered ? q.ok : null, reward: 'spin' };
}
async function quizAnswer(uid, choice) {
  return users.withLock(uid, () => {
    const u = users.get(uid);
    if (!u) return { ok: false, status: 400, error: 'no_user' };
    const q = quizToday();
    if (u.quizDay === q.day) return { ok: false, status: 429, error: 'already_answered' };
    const right = Number(choice) === q.ok;
    const patch = { quizDay: q.day, quizRight: right };
    // Бонусний спін окремим лічильником — серія днів не ламається.
    if (right) patch.freeSpins = (u.freeSpins || 0) + 1;
    users.patch(uid, patch);
    if (right) progress.addXp(uid, 'quest', 20, { why: 'quiz' });
    track(uid, 'quiz');
    return { ok: true, right, correct: q.ok, freeSpins: users.get(uid).freeSpins || 0 };
  });
}

// ─── Партнерські завдання ───────────────────────────────────────────────
// hidden — прибрано зі списку, але старі заявки обробляються далі.
const TASKS = {
  temu:  { reward: 0, bears: 3, label: 'Встановити Temu', link: config.LINKS.temu, managerOnly: true, hidden: true },
  agent: { reward: 2, bonusSpin: true, label: 'Перейти в Agent301', link: config.LINKS.agent, proof: true, hidden: true },
};
function tasksView(u) {
  const done = u.taskDone || {};
  return Object.entries(TASKS).filter(([, t]) => !t.hidden).map(([id, t]) => ({
    id, label: t.label, reward: t.reward, bears: t.bears || 0, link: t.link, proof: !!t.proof, managerOnly: !!t.managerOnly,
    done: !!done[id], contact: config.SUPPORT,
  }));
}
async function taskProof(uid, taskId, photoBase64) {
  const t = Object.prototype.hasOwnProperty.call(TASKS, taskId) ? TASKS[taskId] : null;
  if (!t || !t.proof || t.hidden) return { ok: false, status: 400, error: 'unknown_task' };
  const u = users.get(uid) || {};
  if ((u.taskDone || {})[taskId]) return { ok: false, status: 429, error: 'already_done' };
  if (Date.now() - (u.taskProofAt || 0) < 10 * 60000) return { ok: false, status: 429, error: 'wait' };
  if (!notify.tg.telegram || !config.ADMIN_CHAT_ID) return { ok: false, status: 503, error: 'no_admin' };
  users.patch(uid, { taskProofAt: Date.now() });
  try {
    const buf = Buffer.from(String(photoBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (buf.length < 100) return { ok: false, status: 400, error: 'no_photo' };
    await notify.tg.telegram.sendPhoto(config.ADMIN_CHAT_ID, { source: buf, filename: 'proof.jpg' }, {
      caption: `🤖 ${t.label}\n${u.name || '—'} ${u.username ? '@' + u.username : ''} · id ${uid}\nНагорода: +${t.reward}⭐${t.bonusSpin ? ' + бонусний спін' : ''}`,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Зарахувати', callback_data: `tproof_ok_${taskId}_${uid}` },
        { text: '❌ Відхилити', callback_data: `tproof_no_${uid}` },
      ]] },
    });
    return { ok: true };
  } catch (e) { return { ok: false, status: 500, error: 'send_failed' }; }
}
// Зарахування завдання адміном (кнопка під скріном або /accept).
function taskAccept(uid, taskId) {
  const t = TASKS[taskId];
  const u = users.get(uid);
  if (!t || !u) return { ok: false, error: 'not_found' };
  if ((u.taskDone || {})[taskId]) return { ok: false, error: 'already' };
  users.patch(uid, { taskDone: { ...(u.taskDone || {}), [taskId]: Date.now() } });
  if (t.reward) users.move(uid, { stars: t.reward }, 'task', { task: taskId });
  if (t.bonusSpin) users.patch(uid, { freeSpins: (users.get(uid).freeSpins || 0) + 1 });
  const apps = [];
  const applications = require('./applications');
  for (let i = 0; i < (t.bears || 0); i++) apps.push(applications.create(uid, 'bear', taskId, {}, { silent: true }).id);
  progress.addXp(uid, 'quest', 50, { why: 'task' });
  notify.dm(uid, `✅ <b>${esc(t.label)}</b> — зараховано!` + (t.reward ? `\n⭐ +${t.reward}` : '') +
    (t.bonusSpin ? '\n🎰 +1 бонусний спін' : '') + (apps.length ? `\n🧸 Заявки: #${apps.join(', #')}` : ''));
  return { ok: true, apps };
}

// ─── Секретне завдання партнера ─────────────────────────────────────────
// Прибране: за замовчуванням сховане в застосунку (головна, «Завдання», спливаюче
// вікно) і не приймає заявок. Повернути — адмін /partner_on, сховати — /partner_off.
const PARTNER = { on: true, name: 'GramTon Drop', link: config.LINKS.partner, stars: 3, tickets: 15, xp: 50, earlyCount: 20 };
function partnerFlags() { return (store.getFeatureFlags() || {}).partner || {}; }
function partnerView(u) {
  const f = partnerFlags();
  const approved = f.approved || 0;
  const mult = approved < PARTNER.earlyCount ? 2 : 1;
  return {
    on: PARTNER.on && f.enabled === true, name: PARTNER.name, link: PARTNER.link,
    reward: { stars: PARTNER.stars * mult, tickets: PARTNER.tickets * mult, xp: PARTNER.xp * mult },
    early: mult > 1, earlyLeft: Math.max(0, PARTNER.earlyCount - approved),
    status: u.partnerStatus || null,
  };
}
function partnerClaim(uid) {
  const u = users.get(uid);
  if (!u) return { ok: false, status: 400, error: 'no_user' };
  const s = partnerView(u);
  if (!s.on) return { ok: false, status: 403, error: 'off' };
  if (s.status === 'done' || s.status === 'pending') return { ok: false, status: 429, error: s.status };
  if (u.partnerAt && Date.now() - u.partnerAt < 30 * 60000) return { ok: false, status: 429, error: 'wait' };
  users.patch(uid, { partnerStatus: 'pending', partnerAt: Date.now() });
  notify.admin(`🔐 Секретне завдання (${PARTNER.name}) — на перевірку\n${esc(u.name || '—')} ${u.username ? '@' + u.username : ''} · id <code>${uid}</code>`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Зарахувався', callback_data: 'pk_ok_' + uid, style: 'success' },
      { text: '❌ Ні', callback_data: 'pk_no_' + uid, style: 'danger' },
    ]] } });
  return { ok: true, status: 'pending' };
}
function partnerDecide(uid, ok) {
  const u = users.get(uid);
  if (!u) return { ok: false, error: 'not_found' };
  if (u.partnerStatus === 'done') return { ok: false, error: 'already' };
  if (!ok) {
    users.patch(uid, { partnerStatus: 'rejected' });
    notify.dm(uid, '🔒 <b>Секретне завдання поки не зараховано.</b>\n\nНайчастіше причина — підписка не на всіх спонсорів або ти вже був у тому боті раніше. Перевір і подай ще раз.');
    return { ok: true, approved: false };
  }
  const f = partnerFlags();
  const approved = f.approved || 0;
  const mult = approved < PARTNER.earlyCount ? 2 : 1;
  store.setFeatureFlags({ partner: { ...f, approved: approved + 1 } });
  users.patch(uid, { partnerStatus: 'done' });
  users.move(uid, { stars: PARTNER.stars * mult, tickets: PARTNER.tickets * mult }, 'partner', {});
  progress.addXp(uid, 'quest', PARTNER.xp * mult, { why: 'partner' });
  notify.dm(uid, `🔓 <b>Секретне завдання виконано!</b>${mult > 1 ? '\n🔥 Ти серед перших — усе ×2!' : ''}\n\n⭐ +${PARTNER.stars * mult}\n🎫 +${PARTNER.tickets * mult}\n✨ +${PARTNER.xp * mult} XP`);
  return { ok: true, approved: true, mult, count: approved + 1 };
}

module.exports = {
  track, dailyView, quizView, quizAnswer, quizToday, QUIZ,
  TASKS, tasksView, taskProof, taskAccept,
  PARTNER, partnerView, partnerClaim, partnerDecide, partnerFlags,
};
