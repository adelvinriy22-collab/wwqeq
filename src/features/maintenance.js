// Технічні роботи: off — усе працює; withdraw — заблоковано лише вивід;
// full — застосунок і бот показують екран техробіт. Таймер лежить у базі,
// тож переживає будь-яку кількість деплоїв.
const store = require('../store');

const DEFAULT_TEXT = 'Вивід тимчасово зупинено на технічні роботи. Зірки на балансі нікуди не зникають — щойно роботи закінчаться, заявку можна буде подати знову.';

function state() {
  const f = store.getFeatureFlags() || {};
  const m = f.maintenance || {};
  const mode = m.mode || 'off';
  const until = m.until || 0;
  if (mode !== 'off' && until && Date.now() >= until) {
    store.setFeatureFlags({ maintenance: { mode: 'off', text: m.text || DEFAULT_TEXT, since: 0, until: 0 } });
    console.log('🛠 Техроботи завершились за таймером');
    return { mode: 'off', text: m.text || DEFAULT_TEXT, since: 0, until: 0, left: 0 };
  }
  return { mode, text: m.text || DEFAULT_TEXT, since: m.since || 0, until, left: until ? Math.max(0, until - Date.now()) : 0 };
}

function set(patch) {
  const cur = state();
  const next = { ...cur, ...patch };
  if (patch.mode === 'off') { next.since = 0; next.until = 0; }
  else if (patch.mode && patch.mode !== cur.mode) next.since = Date.now();
  delete next.left;
  store.setFeatureFlags({ maintenance: next });
  return state();
}

module.exports = { state, set, DEFAULT_TEXT };
