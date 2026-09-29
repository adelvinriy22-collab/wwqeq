// ==========================================================================
// HTTP-сервер: застосунок (web/), картинки, API.
// ==========================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const notify = require('../core/notify');
const { router } = require('./api');

const WEB = path.join(config.ROOT, 'web');

// Версія застосунку — відбиток усіх файлів web/. Змінився хоч один файл —
// змінилась версія, і застосунок у людей оновиться сам (без ручного bump).
function computeBuild() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(html|js|css)$/.test(f)) h.update(f).update(fs.readFileSync(p));
    }
  };
  try { walk(WEB); } catch (e) {}
  return h.digest('hex').slice(0, 10);
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.build = computeBuild();
  console.log('📦 Версія застосунку:', app.locals.build);

  try { app.use(require('compression')()); } catch (e) { console.warn('ℹ️ compression не встановлено'); }
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });

  // Великі тіла — лише для скріна-доказу.
  app.use('/api/tasks/proof', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '64kb' }));

  // Захист від флуду: не більше API_RATE_PER_MIN запитів на хвилину з адреси.
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.at > 60000) hits.delete(k); }, 60000).unref();
  app.use('/api/', (req, res, next) => {
    const ip = req.ip || 'x', now = Date.now();
    let x = hits.get(ip);
    if (!x || now - x.at > 60000) { x = { n: 0, at: now }; hits.set(ip, x); }
    if (++x.n > config.API_RATE_PER_MIN) return res.status(429).json({ ok: false, error: 'rate_limited' });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, build: app.locals.build, bot: !!notify.tg.botUsername, schema: store.SCHEMA }));

  // Сторінка застосунку: кеш лише з перевіркою (незмінена — 304 без тіла).
  let indexHtml = null;
  const sendIndex = (req, res) => {
    if (!indexHtml || process.env.NODE_ENV === 'development') {
      indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace(/%BUILD%/g, app.locals.build);
    }
    res.set({ 'Cache-Control': 'no-cache, must-revalidate', 'Content-Type': 'text/html; charset=utf-8', ETag: '"' + app.locals.build + '"' });
    if (req.get('if-none-match') === '"' + app.locals.build + '"') return res.status(304).end();
    res.send(indexHtml);
  };
  app.get(['/', '/wheel.html', '/app', '/index.html'], sendIndex);
  // js/css — модулі імпортують один одного без ?v=, тож кеш лише з
  // перевіркою ETag: незмінений файл — 304 без тіла, змінений — одразу новий.
  const revalidate = { maxAge: 0, etag: true, lastModified: true, fallthrough: false };
  app.use('/js', express.static(path.join(WEB, 'js'), revalidate));
  app.use('/css', express.static(path.join(WEB, 'css'), revalidate));
  app.use('/img', express.static(path.join(WEB, 'img'), { maxAge: '7d', fallthrough: false }));

  // Старі збережені копії застосунку питають /api/wheel-status — віддаємо
  // лише нову версію, і стара сторінка перезавантажиться сама.
  app.get('/api/wheel-status', (req, res) => { res.set('X-App-Build', app.locals.build); res.json({ build: app.locals.build, lang: 'uk', maintenance: { mode: 'off' } }); });

  // Аватарки: бот бере фото профілю й віддає лише байти (посилання містить токен бота).
  const avatars = new Map();
  app.get('/api/avatar/:uid', async (req, res) => {
    const uid = String(req.params.uid || '').replace(/\D/g, '');
    const u = uid && store.getUser(uid);
    if (!u || u.anonymous || !notify.tg.telegram) return res.status(404).end();
    const hit = avatars.get(uid);
    if (hit && Date.now() - hit.at < (hit.buf ? 6 : 1) * 3600000) {
      if (!hit.buf) return res.status(404).end();
      res.set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=21600' });
      return res.send(hit.buf);
    }
    try {
      const ph = await notify.tg.telegram.getUserProfilePhotos(Number(uid), 0, 1);
      const sizes = ph && ph.photos && ph.photos[0];
      if (!sizes || !sizes.length) { avatars.set(uid, { at: Date.now() }); return res.status(404).end(); }
      const pick = sizes.find(s => s.width >= 160) || sizes[sizes.length - 1];
      const link = await notify.tg.telegram.getFileLink(pick.file_id);
      const r = await fetch(String(link));
      if (!r.ok) throw new Error('fetch ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get('content-type') || 'image/jpeg';
      avatars.set(uid, { at: Date.now(), buf, type });
      if (avatars.size > 800) avatars.delete(avatars.keys().next().value);
      res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=21600' });
      res.send(buf);
    } catch (e) {
      avatars.set(uid, { at: Date.now() });
      res.status(404).end();
    }
  });

  app.use('/api', router);
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  app.use((err, req, res, next) => {
    if (err && err.status === 404) return res.status(404).end();
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'too_large' });
    console.error('HTTP error:', err && err.message);
    res.status(err && err.status || 500).json({ ok: false, error: 'server_error' });
  });
  return app;
}

module.exports = { createApp, computeBuild };
