// ==========================================================================
// API застосунку. Кожен запит підписаний initData від Telegram (заголовок
// X-Init-Data). Сервер — єдине джерело правди: застосунок лише показує.
// ==========================================================================
const express = require('express');
const config = require('../config');
const E = require('../economy');
const users = require('../core/users');
const progress = require('../core/progress');
const rng = require('../core/rng');
const subscription = require('../core/subscription');
const notify = require('../core/notify');
const auth = require('./auth');
const wheels = require('../features/wheels');
const games = require('../features/games');
const bank = require('../features/bank');
const pass = require('../features/pass');
const league = require('../features/league');
const wallet = require('../features/wallet');
const quests = require('../features/quests');
const referrals = require('../features/referrals');
const promo = require('../features/promo');
const profile = require('../features/profile');
const live = require('../features/live');
const goal = require('../features/goal');
const maintenance = require('../features/maintenance');
const admin = require('../features/admin');
const applications = require('../features/applications');
const store = require('../store');
const time = require('../lib/time');

const router = express.Router();

// Обгортка: помилки й «зайнято» не валять сервер і повертаються зрозуміло.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (res.headersSent) return;
    if (out && out.ok === false) return res.status(out.status || 400).json(out);
    res.json(out || { ok: true });
  } catch (e) {
    if (e && e.code === 'busy') return res.status(429).json({ ok: false, error: 'busy' });
    console.error('API', req.method, req.path, e && e.stack || e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
  }
};

function langOf(u, tgUser) {
  if (u && u.lang) return u.lang;
  const c = String((tgUser && tgUser.language_code) || '').slice(0, 2);
  return c === 'ru' ? 'ru' : c === 'en' ? 'en' : 'uk';
}

// Авторизація + запис гравця. Застосунок може відкритись раніше за /start —
// тоді створюємо гравця тут, з мовою Telegram.
function withUser(req, res, next) {
  const a = auth.fromRequest(req);
  if (!a) return res.status(401).json({ ok: false, error: 'unauthorized' });
  let u = users.get(a.uid);
  const isNew = !u;
  u = users.ensure(a.user);
  const patch = {};
  if (!u.lastActiveAt || Date.now() - u.lastActiveAt > 60000) patch.lastActiveAt = Date.now();
  if (!u.lang) patch.lang = langOf(u, a.user);
  const photo = typeof a.user.photo_url === 'string' && /^https:\/\//.test(a.user.photo_url) ? a.user.photo_url : null;
  if (photo !== (u.photo || null)) patch.photo = photo;
  if (a.user.is_premium !== undefined && !!a.user.is_premium !== !!u.isPremium) patch.isPremium = !!a.user.is_premium;
  if (Object.keys(patch).length) users.patch(a.uid, patch);
  if (isNew && a.startParam && /^ref_\d+$/.test(a.startParam)) referrals.setPending(a.uid, a.startParam.slice(4));
  req.uid = a.uid;
  req.tgUser = a.user;
  req.u = users.get(a.uid);
  req.lang = req.u.lang || 'uk';
  next();
}
function adminOnly(req, res, next) {
  if (!users.isAdmin(req.uid)) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}
// Дії, що рухають гроші, — лише з підпискою на канал.
async function subscribed(req, res, next) {
  const ok = await subscription.isSubscribed(req.uid);
  if (!ok) return res.status(403).json({ ok: false, error: 'not_subscribed', channel: config.CHANNEL_USERNAME, channelUrl: config.CHANNEL_URL });
  referrals.attributeIfPending(req.uid);
  next();
}
// Техроботи «full» блокують дії на сервері, а не лише екраном.
function notInMaintenance(req, res, next) {
  const m = maintenance.state();
  if (m.mode === 'full' && !users.isAdmin(req.uid)) return res.status(503).json({ ok: false, error: 'maintenance', message: m.text, until: m.until });
  next();
}
const spinGap = new Map();
function spinThrottle(req, res, next) {
  const prev = spinGap.get(req.uid) || 0;
  if (Date.now() - prev < config.SPIN_MIN_GAP_MS) return res.status(429).json({ ok: false, error: 'too_fast' });
  spinGap.set(req.uid, Date.now());
  next();
}

function maintView(uid) {
  const m = maintenance.state();
  if (users.isAdmin(uid) && m.mode !== 'off') return { ...m, mode: 'off', adminBypass: true, realMode: m.mode };
  return m;
}

// ─── Стан для головного екрана ──────────────────────────────────────────
function bootstrap(req) {
  const u = users.get(req.uid);
  const lang = u.lang || 'uk';
  const b = bank.get();
  const pv = pass.view(u, lang);
  const lv = league.enabled() ? league.view(req.uid, lang) : null;
  const dq = quests.dailyView(u, lang);
  const f = store.getFeatureFlags() || {};
  return {
    ok: true, build: req.app.locals.build, serverNow: Date.now(),
    user: { id: u.id, name: u.name || '', username: u.username || null, lang, photo: u.photo || null, isAdmin: users.isAdmin(req.uid), anonymous: !!u.anonymous },
    bot: notify.tg.botUsername || null,
    balance: { stars: users.stars(u), tickets: users.tickets(u) },
    progress: progress.view(u, lang),
    wheels: wheels.view(u),
    risk: games.riskState(u),
    bank: b && b.status !== 'cancelled' ? { active: true, status: b.status, pot: bank.core.totalPot(b), stars: b.stars != null ? b.stars : bank.core.totalPot(b), tickets: b.tickets || 0,
      drawAt: b.drawAt, players: b.order.length, mine: (b.bets || {})[req.uid] || 0, chance: bank.core.chance(b, req.uid) } : { active: false },
    pass: { level: pv.level, maxLevel: pv.maxLevel, xpInLevel: pv.xpInLevel, levelXp: pv.levelXp, claimable: pv.claimable, premium: pv.premium, endsAt: pv.endsAt },
    league: lv ? { enabled: true, rank: lv.me.rank, xp: lv.me.xp, players: lv.players, endsAt: lv.endsAt } : { enabled: false },
    quests: { done: dq.items.filter(i => i.done).length, total: dq.items.length, all: dq.all, quiz: u.quizDay !== quests.quizToday().day },
    partner: quests.partnerView(u),
    goal: goal.view(req.uid),
    withdraw: wallet.withdrawInfo(u),
    topup: wallet.topupInfo(u),
    maintenance: maintView(req.uid),
    fairHash: rng.view(req.uid).hash,
    autowd: Math.max(0, Math.min(100, ((f.autowd || {}).pct) || 0)),
    showFeature: (u.featurePopupVer || 0) < 7 && quests.partnerView(u).on && !u.partnerStatus,
    links: { channel: config.CHANNEL_URL, chat: 'https://t.me/' + String(config.CHAT_USERNAME).replace('@', ''), support: config.SUPPORT, ref: referrals.link(req.uid) },
    friends: (u.invitedIds || []).length,
    tiers: E.TIERS.map(t => ({ id: t.id, emoji: t.emoji, img: t.img, name: t.name[lang] || t.name.uk, value: t.price })),
  };
}

// ─── Маршрути ───────────────────────────────────────────────────────────
router.use(withUser);

router.get('/me', h(async (req) => {
  const out = bootstrap(req);
  out.subscribed = await subscription.isSubscribed(req.uid);
  if (out.subscribed) referrals.attributeIfPending(req.uid);
  out.channel = config.CHANNEL_USERNAME;
  return out;
}));
router.post('/subscription/check', h(async (req) => {
  subscription.forget(req.uid);
  const ok = await subscription.isSubscribed(req.uid);
  if (ok) referrals.attributeIfPending(req.uid);
  return { ok: true, subscribed: ok };
}));

router.post('/spin', notInMaintenance, subscribed, spinThrottle, h(async (req) => wheels.spin(req.uid, String(req.body.wheel || ''))));
router.post('/risk', notInMaintenance, subscribed, h(async (req) => games.risk(req.uid)));

router.get('/games', h(async (req) => ({ ok: true, games: games.catalog(req.lang), bet: E.GAME_BET, balance: users.stars(users.get(req.uid)), fair: rng.view(req.uid) })));
router.post('/games/play', notInMaintenance, subscribed, spinThrottle, h(async (req) => games.play(req.uid, String(req.body.game || ''), String(req.body.bet || ''), req.body.stake)));

router.get('/bank', h(async (req) => ({ ok: true, ...bank.view(req.uid) })));
router.post('/bank/bet', notInMaintenance, subscribed, h(async (req) => bank.bet(req.uid, req.body.stars, req.body.tickets)));

router.get('/wallet', h(async (req) => {
  const u = users.get(req.uid);
  return { ok: true, balance: { stars: users.stars(u), tickets: users.tickets(u) }, withdraw: wallet.withdrawInfo(u), topup: wallet.topupInfo(u),
           exchange: { tickets: E.TICKETS.exchangeTickets, stars: E.TICKETS.exchangeStars }, shop: wallet.shopView(u, req.lang), history: wallet.history(u) };
}));
router.post('/wallet/withdraw', notInMaintenance, subscribed, h(async (req) => wallet.withdraw(req.uid, req.body.amount)));
router.post('/wallet/exchange', notInMaintenance, h(async (req) => wallet.exchange(req.uid, req.body.tickets)));
router.post('/wallet/topup', h(async (req) => wallet.invoiceLink(req.uid, 'topup', req.body.amount)));
router.post('/shop/buy', notInMaintenance, subscribed, h(async (req) => wallet.shopBuy(req.uid, String(req.body.item || ''))));

router.get('/progress', h(async (req) => {
  const u = users.get(req.uid);
  return {
    ok: true, xp: progress.view(u, req.lang), levels: E.LEVELS.map((L, i) => ({ n: i + 1, at: L.at, e: L.e, t: L.t[req.lang] || L.t.uk, reward: E.levelReward(i).tickets })),
    pass: pass.view(u, req.lang), league: league.view(req.uid, req.lang),
    daily: quests.dailyView(u, req.lang), quiz: quests.quizView(u, req.lang),
    tasks: quests.tasksView(u), partner: quests.partnerView(u),
    xpSources: E.XP, xpRates: E.XP_RATES,
  };
}));
router.post('/pass/claim', notInMaintenance, h(async (req) => pass.claim(req.uid, req.body.level === 'all' ? 'all' : parseInt(req.body.level, 10), req.body.track)));
router.post('/pass/buy', notInMaintenance, h(async (req) => pass.buy(req.uid)));
router.post('/pass/invoice', h(async (req) => wallet.invoiceLink(req.uid, 'pass')));
router.post('/quiz/answer', notInMaintenance, h(async (req) => quests.quizAnswer(req.uid, req.body.choice)));
router.post('/tasks/proof', notInMaintenance, h(async (req) => quests.taskProof(req.uid, String(req.body.taskId || ''), req.body.photo)));
router.post('/partner/claim', notInMaintenance, h(async (req) => quests.partnerClaim(req.uid)));
router.post('/promo', notInMaintenance, h(async (req) => {
  const r = await promo.redeem(req.uid, req.body.code);
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  return r;
}));

router.get('/friends', h(async (req) => {
  const u = users.get(req.uid);
  return { ok: true, ladder: referrals.ladder(u, req.lang), friends: referrals.friendsList(u), perFriend: E.TICKETS.perFriend, xpPerFriend: E.XP.friend.per };
}));
router.post('/friends/claim', notInMaintenance, subscribed, h(async (req) => referrals.claimLadder(req.uid, String(req.body.tier || ''))));

router.get('/profile', h(async (req) => ({ ok: true, ...profile.view(users.get(req.uid), req.lang) })));
router.post('/settings', h(async (req) => ({ ok: true, ...profile.updateSettings(req.uid, req.body || {}) })));
router.post('/seen', h(async (req) => {
  if (req.body.what === 'feature') users.patch(req.uid, { featurePopupVer: 7 });
  return { ok: true };
}));
router.get('/live', h(async (req) => ({ ok: true, items: live.feed(req.uid, req.lang) })));
router.get('/fair', h(async (req) => ({ ok: true, ...rng.view(req.uid) })));
router.post('/fair/rotate', h(async (req) => ({ ok: true, ...rng.rotate(req.uid, req.body.client) })));

// ─── Адмін ──────────────────────────────────────────────────────────────
const A = express.Router();
A.use(adminOnly);
A.get('/overview', h(async () => ({ ok: true, ...admin.overview() })));
A.get('/apps', h(async (req) => ({ ok: true, items: admin.appsList(String(req.query.status || 'pending'), parseInt(req.query.limit, 10) || 100) })));
A.post('/apps/:id/approve', h(async (req) => applications.approve(req.params.id)));
A.post('/apps/:id/reject', h(async (req) => applications.reject(req.params.id, String(req.body.reason || '').slice(0, 300) || null)));
A.get('/user', h(async (req) => { const r = admin.userInfo(req.query.q); return r ? { ok: true, user: r } : { ok: false, status: 404, error: 'not_found' }; }));
A.post('/user/adjust', h(async (req) => admin.adjust(String(req.body.uid), req.body.stars, req.body.tickets, req.body.note)));
A.post('/user/spins', h(async (req) => admin.giveSpins(String(req.body.uid), req.body.free, req.body.gifted)));
A.get('/promo', h(async () => ({ ok: true, items: promo.list() })));
A.post('/promo', h(async (req) => promo.create(req.body.code, { stars: parseInt(req.body.stars, 10) || 0, tickets: parseInt(req.body.tickets, 10) || 0, spins: parseInt(req.body.spins, 10) || 0, uses: parseInt(req.body.uses, 10) || null })));
A.post('/promo/delete', h(async (req) => ({ ok: promo.remove(req.body.code) })));
A.post('/maint', h(async (req) => {
  const mode = ['off', 'withdraw', 'full'].includes(req.body.mode) ? req.body.mode : undefined;
  const patch = {};
  if (mode) patch.mode = mode;
  if (typeof req.body.text === 'string' && req.body.text.trim()) patch.text = req.body.text.trim().slice(0, 500);
  const mins = parseInt(req.body.minutes, 10);
  if (mode && mode !== 'off') patch.until = mins > 0 ? Date.now() + mins * 60000 : 0;
  return { ok: true, state: maintenance.set(patch) };
}));
A.post('/bank/start', h(async (req) => {
  const ts = time.parseKyiv(String(req.body.at || ''));
  const r = bank.start(ts);
  return r.ok ? { ok: true, seedHash: r.bank.seedHash, drawAt: r.bank.drawAt } : { ok: false, status: 400, error: r.error };
}));
A.post('/bank/cancel', h(async () => bank.cancel('')));
A.post('/bank/auto', h(async (req) => ({ ok: true, auto: bank.setAuto({ enabled: !!req.body.enabled, hour: Math.max(0, Math.min(23, parseInt(req.body.hour, 10) || 21)), minute: 0, everyDays: 1 }) })));
A.post('/league', h(async (req) => { league.setEnabled(!!req.body.on); return { ok: true, on: league.enabled() }; }));
A.post('/spin-notify', h(async (req) => ({ ok: true, on: admin.setSpinNotify(!!req.body.on) })));
router.use('/admin', A);

module.exports = { router, bootstrap };
