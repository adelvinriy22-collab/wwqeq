const fs = require('fs');
const path = require('path');

// ВАЖЛИВО: за замовчуванням дані лежать у папці проєкту, а вона на Railway
// стирається при КОЖНОМУ деплої — звідси зникнення балансів. Щоб цього не
// було, треба підключити Volume і задати змінну DATA_DIR на його шлях.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_BACKUP = path.join(DATA_DIR, 'db.backup.json');

function emptyDb() {
  return {
    users: {},
    giveaways: {},          // id -> {tierId, minReferrals, active, participants, startedAt, endsAt, winnerId}
    applications: [],       // {id, uid, tierId, status: pending|approved|rejected, createdAt, decidedAt, reason, source}
    nextApplicationId: 1,
    featureFlags: { eventUnlocked: false },
    event: null,            // {active, endsAt, startedAt}
    passwordChallenge: null, // {active, password, tierId, winnerId}
    externalRefPool: null,   // {active, poolCap, winnersCount, tierId, participants:[], winners:[], messageId, link}
    wheelLog: [],            // {ts, uid, wheel, kind, name, username, extra} — тепер живе в базі, не в пам'яті
    promoCodes: {},          // CODE -> {amount, usesLeft, usedBy: [uid,...], createdAt}
  };
}

console.log('📁 База даних: ' + DB_FILE);
console.log('📁 DATA_DIR зі змінної: ' + (process.env.DATA_DIR || 'НЕ ЗАДАНО (використано папку проєкту)'));

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2));
}
ensureFile();

// Читаємо обережно: якщо основний файл побився (наприклад, процес убили
// посеред запису), беремо резервну копію, а не створюємо порожню базу.
let cache;
try {
  cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!cache || typeof cache !== 'object') throw new Error('bad shape');
} catch (e) {
  console.error('⚠️ Основний db.json не читається:', e.message);
  try {
    cache = JSON.parse(fs.readFileSync(DB_BACKUP, 'utf8'));
    console.error('✅ Відновлено з резервної копії');
  } catch (e2) {
    console.error('⚠️ Резервної копії теж немає — стартуємо з порожньої бази');
    cache = emptyDb();
  }
}
// на випадок, якщо база була створена старою версією коду — доповнюємо відсутні поля
const defaults = emptyDb();
for (const key of Object.keys(defaults)) {
  if (!(key in cache)) cache[key] = defaults[key];
}
// міграція: стара база могла мати featureFlags: { advancedUnlocked } —
// додаємо нові поля, якщо їх ще нема, не чіпаючи решту.
if (cache.featureFlags && !('eventUnlocked' in cache.featureFlags)) {
  cache.featureFlags.eventUnlocked = false;
}
if (cache.featureFlags && !('inventoryUnlocked' in cache.featureFlags)) {
  cache.featureFlags.inventoryUnlocked = false;
}

// Відкладений запис: один спін робив ДЕВʼЯТЬ звернень до бази, і кожне
// переписувало весь файл (майже мегабайт). Через це бот підвисав.
// Тепер зміни накопичуються в памʼяті й падають на диск раз на 800мс.
let lastBackupAt = 0;
let flushTimer = null;
let dirty = false;

// Компроміс між швидкістю і надійністю:
//   - серія записів (один спін = 9 звернень) зливається в один запис;
//   - але чекаємо лише 120мс, тож вікно можливої втрати мізерне;
//   - і не відкладаємо довше ніж на 400мс, навіть якщо запити йдуть безперервно.
const FLUSH_DELAY_MS = 120;
const MAX_DEFER_MS = 400;
let firstDirtyAt = 0;

function persist() {
  dirty = true;
  if (!firstDirtyAt) firstDirtyAt = Date.now();

  // Якщо зміни чекають уже надто довго — пишемо негайно.
  if (Date.now() - firstDirtyAt >= MAX_DEFER_MS) {
    clearTimeout(flushTimer);
    flushTimer = null;
    dirty = false;
    firstDirtyAt = 0;
    flushNow();
    return;
  }

  if (flushTimer) return;
  flushTimer = setTimeout(function () {
    flushTimer = null;
    if (dirty) { dirty = false; firstDirtyAt = 0; flushNow(); }
  }, FLUSH_DELAY_MS);
}

// Примусовий запис — на випадок зупинки процесу.
function flushNow() {
  const json = JSON.stringify(cache, null, 2);
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
    // Резервна копія раз на 5 хвилин — щоб було звідки відновитись.
    if (Date.now() - lastBackupAt > 5 * 60 * 1000) {
      fs.writeFileSync(DB_BACKUP, json);
      lastBackupAt = Date.now();
    }
  } catch (e) {
    console.error('❌ Не вдалось зберегти базу:', e.message);
  }
}

// Перед вимкненням дописуємо все, що ще не встигло лягти на диск.
process.on('SIGTERM', function () { if (dirty) flushNow(); });
process.on('SIGINT',  function () { if (dirty) flushNow(); });
process.on('exit',    function () { if (dirty) flushNow(); });

module.exports = {
  getUser(uid) { return cache.users[uid] || null; },
  upsertUser(uid, patch) {
    // Баланс округлюємо ЗАВЖДИ і в одному місці. Дробові нарахування
    // (0.2⭐ за банан) у двійковій арифметиці дають 2.1999999999999997,
    // і це вилазить людям в інтерфейс.
    if (patch && patch.starBalance != null) {
      patch = { ...patch, starBalance: Math.round(patch.starBalance * 100) / 100 };
    }
    cache.users[uid] = { ...(cache.users[uid] || {}), ...patch };
    persist();
    return cache.users[uid];
  },

  // Одноразова чистка вже зіпсованих балансів у базі.
  fixAllBalances() {
    let fixed = 0;
    for (const [uid, u] of Object.entries(cache.users)) {
      if (u && typeof u.starBalance === 'number') {
        const r = Math.round(u.starBalance * 100) / 100;
        if (r !== u.starBalance) { u.starBalance = r; fixed++; }
      }
    }
    if (fixed) persist();
    return fixed;
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
  save() { persist(); }, // явне збереження після мутації об'єктів по референсу (напр. app.status = ...)

  // Журнал колеса — тепер у файлі бази, переживає перезапуск сервера.
  addWheelLogEvent(ev) {
    cache.wheelLog.push(ev);
    if (cache.wheelLog.length > 500) cache.wheelLog.splice(0, cache.wheelLog.length - 500);
    persist();
  },
  getWheelLog() { return cache.wheelLog; },

  getPromoCode(code) { return cache.promoCodes[code.toUpperCase()] || null; },
  setPromoCode(code, data) { cache.promoCodes[code.toUpperCase()] = data; persist(); },
  listPromoCodes() { return cache.promoCodes; },

  addApplication(app) {
    app.id = cache.nextApplicationId++;
    cache.applications.push(app);
    persist();
    return app;
  },
  getApplication(id) { return cache.applications.find(a => a.id === Number(id)); },

  // Видалити всі заявки конкретного юзера (для чистки власних тестових).
  removeApplicationsByUid(uid) {
    const before = cache.applications.length;
    cache.applications = cache.applications.filter(a => String(a.uid) !== String(uid));
    persist();
    return before - cache.applications.length;
  },
  listApplications(status) { return cache.applications.filter(a => !status || a.status === status); },

  // Повне очищення історії заявок. Зірки не чіпаємо — це саме прибирання.
  wipeApplications() {
    const n = cache.applications.length;
    cache.applications = [];
    persist();
    return n;
  },
  deleteApplication(id) {
    const idx = cache.applications.findIndex(a => a.id === Number(id));
    if (idx === -1) return false;
    cache.applications.splice(idx, 1);
    persist();
    return true;
  },
  hasApplicationFor(uid, tierId) {
    // Раніше виключали rejected (дозволяючи нескінченні повторні спроби) —
    // це і був баг, яким користувачі спамили заявки. Тепер БУДЬ-яка заявка
    // (pending/approved/rejected) закриває цей рівень назавжди для юзера.
    // Враховуємо лише заявки зі "сходів" (не event/giveaway) — виграш призу
    // в події чи розіграші не повинен блокувати окрему заявку через сходи.
    // Тепер рахуємо ТІЛЬКИ заявки зі сходів. Раніше був чорний список джерел,
    // і кожне нове джерело (колесо, магазин, квести) доводилось туди дописувати —
    // а поки не дописали, виграна в колесі мішка блокувала мішку за рефералів.
    return cache.applications.some(a =>
      a.uid === uid && a.tierId === tierId && a.source === 'ladder'
    );
  },
};
