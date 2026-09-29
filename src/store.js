// ==========================================================================
// СХОВИЩЕ. Уся база — у пам'яті, на диск пишеться відкладено й атомарно
// (tmp → rename). Плюс:
//   • резервна копія раз на 5 хв і денні знімки (зберігаються 7 днів);
//   • журнал транзакцій ledger-YYYY-MM.jsonl — кожен рух зірок і білетів;
//   • міграції схеми з резервною копією перед кожною.
//
// ВАЖЛИВО для Railway: задай DATA_DIR на підключений Volume, інакше база
// лежить у папці проєкту й стирається при кожному деплої.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = config.DATA_DIR;
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_BACKUP = path.join(DATA_DIR, 'db.backup.json');
const SCHEMA = 3;

function emptyDb() {
  return {
    meta: { schema: SCHEMA, createdAt: Date.now() },
    users: {},
    giveaways: {},
    applications: [],
    nextApplicationId: 1,
    featureFlags: { eventUnlocked: false },
    event: null,
    passwordChallenge: null,
    externalRefPool: null,
    wheelLog: [],
    promoCodes: {},
  };
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!v || typeof v !== 'object') throw new Error('bad shape');
  return v;
}

let cache;
if (!fs.existsSync(DB_FILE)) {
  cache = emptyDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(cache));
} else {
  try {
    cache = readJson(DB_FILE);
  } catch (e) {
    console.error('⚠️ db.json не читається:', e.message);
    try {
      cache = readJson(DB_BACKUP);
      console.error('✅ Відновлено з резервної копії');
    } catch (e2) {
      // Порожню базу поверх зіпсованої НЕ пишемо — зберігаємо зіпсований файл
      // поруч, щоб його можна було відновити вручну.
      const broken = DB_FILE + '.broken-' + Date.now();
      try { fs.copyFileSync(DB_FILE, broken); } catch (e3) {}
      console.error('⚠️ Резервної копії теж немає — стартуємо з порожньої бази. Зіпсований файл: ' + broken);
      cache = emptyDb();
    }
  }
}
// Старі бази (v2) не мають meta — позначаємо їх ДО підстановки типових полів,
// інакше вони отримали б schema 3 і міграція не запустилась би.
if (!cache.meta) cache.meta = { schema: 2 };
const defaults = emptyDb();
for (const key of Object.keys(defaults)) if (!(key in cache)) cache[key] = defaults[key];
if (cache.featureFlags && !('eventUnlocked' in cache.featureFlags)) cache.featureFlags.eventUnlocked = false;

console.log('📁 База даних: ' + DB_FILE + (process.env.DATA_DIR ? '' : '  ⚠️ DATA_DIR не задано'));

// ─── Запис на диск ──────────────────────────────────────────────────────
const FLUSH_DELAY_MS = 150;
const MAX_DEFER_MS = 500;
let flushTimer = null, dirty = false, firstDirtyAt = 0, lastBackupAt = 0;

function flushNow() {
  clearTimeout(flushTimer);
  flushTimer = null; dirty = false; firstDirtyAt = 0;
  const json = JSON.stringify(cache);
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
    const now = Date.now();
    if (now - lastBackupAt > 5 * 60000) {
      lastBackupAt = now;
      fs.writeFile(DB_BACKUP, json, () => {});
      const day = new Date(now).toISOString().slice(0, 10);
      const snap = path.join(DATA_DIR, 'db.' + day + '.json');
      if (!fs.existsSync(snap)) { fs.writeFile(snap, json, () => {}); pruneSnapshots(); }
    }
  } catch (e) {
    console.error('❌ Не вдалось зберегти базу:', e.message);
  }
}
function pruneSnapshots() {
  try {
    const snaps = fs.readdirSync(DATA_DIR).filter(f => /^db\.\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of snaps.slice(0, -7)) fs.unlink(path.join(DATA_DIR, f), () => {});
  } catch (e) {}
}
function persist() {
  dirty = true;
  if (!firstDirtyAt) firstDirtyAt = Date.now();
  if (Date.now() - firstDirtyAt >= MAX_DEFER_MS) return flushNow();
  if (flushTimer) return;
  flushTimer = setTimeout(() => { if (dirty) flushNow(); }, FLUSH_DELAY_MS);
}
function flush() { if (dirty || flushTimer) flushNow(); }
process.on('exit', () => { if (dirty) flushNow(); });

// ─── Журнал транзакцій ──────────────────────────────────────────────────
let ledgerBuf = [], ledgerTimer = null;
function ledgerFile(ts) { return path.join(DATA_DIR, 'ledger-' + new Date(ts).toISOString().slice(0, 7) + '.jsonl'); }
function writeLedger() {
  ledgerTimer = null;
  if (!ledgerBuf.length) return;
  const byFile = {};
  for (const e of ledgerBuf) (byFile[ledgerFile(e.ts)] = byFile[ledgerFile(e.ts)] || []).push(JSON.stringify(e));
  ledgerBuf = [];
  for (const [f, lines] of Object.entries(byFile)) {
    try { fs.appendFileSync(f, lines.join('\n') + '\n'); } catch (e) { console.error('ledger write:', e.message); }
  }
}
function appendLedger(entry) {
  ledgerBuf.push(entry);
  if (!ledgerTimer) ledgerTimer = setTimeout(writeLedger, 300);
}
process.on('exit', writeLedger);

// ─── Міграції ───────────────────────────────────────────────────────────
function backupBeforeMigration(from) {
  const f = path.join(DATA_DIR, `db.pre-v${SCHEMA}-from-v${from}-${Date.now()}.json`);
  try { fs.copyFileSync(DB_FILE, f); console.log('💾 Резервна копія перед міграцією: ' + f); } catch (e) {}
}

const migrations = {
  // v2 → v3: одна валюта білетів замість формули, єдиний досвід замість
  // трьох окремих лічильників (очки чату, XP пасу, XP ліги).
  3(db, ctx) {
    const passCfg = ctx.pass;
    const curSeason = ctx.seasonId(Date.now());
    const curWeek = ctx.weekKey(Date.now());
    let n = 0;
    for (const [uid, u] of Object.entries(db.users || {})) {
      if (!u || typeof u !== 'object') continue;
      if (u.v >= 3) continue;
      if (!u.id) u.id = uid;
      // Білети: раніше tickets + кількість друзів − витрачені. Тепер — одне число.
      const legacyTickets = Math.max(0, (u.tickets || 0) + (u.invitedIds || []).length - (u.ticketsUsed || 0));
      u.tickets = legacyTickets;
      delete u.ticketsUsed;
      // Пас. Старий бот (pass.js) звав сезони «s9» (лік з нуля), рахував
      // 250 XP на рівень і тримав забрані нагороди в claimed[] і claimedPrem[].
      // Сезони ті самі 30-денні вікна від 1 січня 2026, тож поточний упізнаємо
      // за номером, а XP перераховуємо так, щоб рівень пасу в людини не змінився.
      const p = u.pass && typeof u.pass === 'object' ? u.pass : null;
      const idx = Math.floor((Date.now() - passCfg.epoch) / (passCfg.seasonDays * 86400000));
      const oldFmt = !!(p && typeof p.season === 'string' && /^s\d+$/.test(p.season));
      const isCurrent = !!(p && (p.season === curSeason || (oldFmt && p.season === 's' + idx)));
      const oldLevelXp = oldFmt ? 250 : passCfg.levelXp;
      const seasonXp = isCurrent ? Math.round(Math.max(0, Number(p.xp) || 0) * passCfg.levelXp / oldLevelXp * 100) / 100 : 0;
      const weekXp = u.league && u.league.week === curWeek ? Math.max(0, Number(u.league.xp) || 0) : 0;
      // Досвід: очки чату стають загальним досвідом (титули зберігаються).
      u.xp = {
        total: Math.max(0, Number(u.chatPts) || 0),
        season: { id: curSeason, xp: seasonXp },
        week: { id: curWeek, xp: weekXp },
        day: null,
      };
      if (isCurrent) {
        const lvl = Math.min(passCfg.maxLevel, 1 + Math.floor(seasonXp / passCfg.levelXp));
        const all = []; for (let i = 1; i <= lvl; i++) all.push(i);
        const nums = (a) => (Array.isArray(a) ? a : []).map(Number).filter(n => n > 0);
        let claimed;
        if (Array.isArray(p.claimed)) claimed = { free: nums(p.claimed), prem: nums(p.claimedPrem) };
        else if (p.claimed && Array.isArray(p.claimed.free) && Array.isArray(p.claimed.prem)) claimed = { free: nums(p.claimed.free), prem: nums(p.claimed.prem) };
        // Формат невідомий — вважаємо забраними всі відкриті рівні, щоб нагороди не видались удруге.
        else claimed = { free: all.slice(), prem: p.premium ? all.slice() : [] };
        u.pass = {
          season: curSeason, premium: !!p.premium,
          premiumMethod: p.premiumMethod || (p.premium ? 'balance' : null), premiumAt: p.premiumAt || p.boughtAt || null,
          claimed, bankXpFor: p.bankXpFor || null,
        };
      } else {
        u.pass = null;
      }
      u.v = 3;
      n++;
    }
    return n;
  },
};

function migrate(ctx) {
  const from = cache.meta.schema || 2;
  if (from >= SCHEMA) return 0;
  backupBeforeMigration(from);
  let total = 0;
  for (let v = from + 1; v <= SCHEMA; v++) {
    if (migrations[v]) {
      const n = migrations[v](cache, ctx);
      console.log(`🔁 Міграція бази до v${v}: оновлено записів — ${n}`);
      total += n;
    }
  }
  cache.meta.schema = SCHEMA;
  cache.meta.migratedAt = Date.now();
  flushNow();
  return total;
}

// ─── API ────────────────────────────────────────────────────────────────
const store = {
  DATA_DIR, DB_FILE, SCHEMA,
  migrate, flush, persist, appendLedger, flushLedger: writeLedger,
  raw: () => cache,

  getUser(uid) { return cache.users[String(uid)] || null; },
  upsertUser(uid, patch) {
    uid = String(uid);
    if (patch && patch.starBalance != null) patch = { ...patch, starBalance: Math.round(patch.starBalance * 100) / 100 };
    cache.users[uid] = { ...(cache.users[uid] || {}), ...patch };
    persist();
    return cache.users[uid];
  },
  allUsers() { return cache.users; },

  getGiveaway(id) { return cache.giveaways[id] || null; },
  setGiveaway(id, g) { cache.giveaways[id] = g; persist(); },
  allGiveaways() { return cache.giveaways || {}; },
  listGiveaways() { return cache.giveaways; },

  getEvent() { return cache.event || null; },
  setEvent(e) { cache.event = e; persist(); },
  getPasswordChallenge() { return cache.passwordChallenge || null; },
  setPasswordChallenge(pc) { cache.passwordChallenge = pc; persist(); },
  getExternalRefPool() { return cache.externalRefPool || null; },
  setExternalRefPool(p) { cache.externalRefPool = p; persist(); },

  getFeatureFlags() { return cache.featureFlags; },
  setFeatureFlags(patch) { cache.featureFlags = { ...cache.featureFlags, ...patch }; persist(); },
  save() { persist(); },

  addWheelLogEvent(ev) {
    cache.wheelLog.push(ev);
    if (cache.wheelLog.length > 1000) cache.wheelLog.splice(0, cache.wheelLog.length - 1000);
    persist();
  },
  getWheelLog() { return cache.wheelLog; },

  getPromoCode(code) {
    const p = cache.promoCodes[String(code).toUpperCase()];
    return p && !p.deleted ? p : null;
  },
  setPromoCode(code, data) { cache.promoCodes[String(code).toUpperCase()] = data; persist(); },
  listPromoCodes() { return cache.promoCodes; },

  addApplication(app) {
    app.id = cache.nextApplicationId++;
    cache.applications.push(app);
    persist();
    return app;
  },
  getApplication(id) { return cache.applications.find(a => a.id === Number(id)) || null; },
  listApplications(status) { return cache.applications.filter(a => !status || a.status === status); },
  removeApplicationsByUid(uid) {
    const before = cache.applications.length;
    cache.applications = cache.applications.filter(a => String(a.uid) !== String(uid));
    persist();
    return before - cache.applications.length;
  },
  wipeApplications() { const n = cache.applications.length; cache.applications = []; persist(); return n; },
  deleteApplication(id) {
    const i = cache.applications.findIndex(a => a.id === Number(id));
    if (i === -1) return false;
    cache.applications.splice(i, 1); persist();
    return true;
  },
  isLadderApp,
  hasApplicationFor(uid, tierId) {
    return cache.applications.some(a => a.uid === String(uid) && a.tierId === tierId && isLadderApp(a) && a.status !== 'cancelled');
  },
};
// Заявки без джерела — найстаріші, до появи поля source; усі вони були зі сходів.
function isLadderApp(a) { return !!a && (!a.source || a.source === 'ladder'); }

module.exports = store;
