// ==========================================================================
// Малює картинки рівнів для бота й застосунку: web/img/levels/
//   lvl-1.jpg … lvl-15.jpg — картка рівня (іконка, шкала, нагорода, привілеї)
//   ladder.jpg             — усі 15 рівнів однією драбиною
//   xp.jpg                 — за що дають XP
// і web/img/jackpot/jp-<приз>.jpg — «JACKPOT FOR ACTIVITY» для чату (мішка, подарунок, зірки, білети, XP).
// Картинки без слів конкретною мовою (цифри й емодзі) — підходять для uk/en/ru.
// Нагороди й привілеї беруться з src/economy.js: змінив їх — перезапусти:
//   node scripts/render-level-images.js
// Потрібен Playwright із Chromium (є в середовищі розробки, не в залежностях бота).
// ==========================================================================
const fs = require('fs');
const path = require('path');
const E = require('../src/economy');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* далі */ } }
  throw new Error('Playwright не знайдено. Встанови його або вкажи PLAYWRIGHT_MODULE.');
}

const OUT = path.join(__dirname, '..', 'web', 'img', 'levels');
const W = 1280, H = 720;
const N = E.LEVELS.length;

// Колір рівня: від зеленого новачка до космічного «Бога удачі».
const TIERS = [
  { to: 3, a: '#1fbf75', b: '#0a3d2c', glow: '#5dffb0' },
  { to: 6, a: '#2f8cff', b: '#0b2250', glow: '#7cc4ff' },
  { to: 9, a: '#a24dff', b: '#2a0b52', glow: '#d2a6ff' },
  { to: 12, a: '#ffb020', b: '#4a2600', glow: '#ffe08a' },
  { to: 15, a: '#ff3d8a', b: '#1c0633', glow: '#ffd36b' },
];
const tierOf = (n) => TIERS.find(t => n <= t.to) || TIERS[TIERS.length - 1];

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body { font-family: 'Inter', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; color: #fff; }
  .emo { font-family: 'Noto Color Emoji', sans-serif; }
  .spark { position: absolute; border-radius: 50%; background: #fff; opacity: .5; }
`;
// Зірочки на тлі — однакові щоразу (псевдовипадкові за номером).
function sparks(seed, count) {
  let x = seed * 9301 + 49297;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  let out = '';
  for (let i = 0; i < count; i++) {
    const s = 2 + rnd() * 4;
    out += `<div class="spark" style="left:${rnd() * W}px;top:${rnd() * H}px;width:${s}px;height:${s}px;opacity:${0.15 + rnd() * 0.5}"></div>`;
  }
  return out;
}
const chip = (html, strong) => `<div class="chip${strong ? ' strong' : ''}">${html}</div>`;

function levelHtml(n) {
  const i = n - 1, L = E.LEVELS[i], t = tierOf(n);
  const rw = E.levelReward(i), p = E.levelPerks(n), un = E.perksUnlockedAt(n);
  const pips = Array.from({ length: N }, (_, k) => `<div class="pip ${k < n - 1 ? 'on' : k === n - 1 ? 'cur' : ''}"></div>`).join('');
  const reward = [rw.tickets ? chip(`+${rw.tickets} <span class="emo">🎫</span>`, true) : '', rw.stars ? chip(`+${rw.stars} <span class="emo">⭐</span>`, true) : ''].join('')
    || chip('<span class="emo">🌱</span> START', true);
  const perks = [
    chip(`<span class="emo">💸</span> ${p.withdrawFee}%`, un.withdrawFee != null),
    p.topupBonus ? chip(`<span class="emo">⭐</span> +${p.topupBonus}%`, un.topupBonus != null) : '',
    p.chatBonus ? chip(`<span class="emo">💬</span> +${p.chatBonus}<span class="emo">🎫</span>`, un.chatBonus != null) : '',
  ].join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { background: radial-gradient(circle at 26% 50%, ${t.a}cc 0%, ${t.b} 55%, #07060d 100%); position: relative; }
    .ring { position: absolute; left: 70px; top: 110px; width: 500px; height: 500px; border-radius: 50%;
      background: radial-gradient(circle, ${t.glow}55 0%, ${t.a}33 45%, transparent 70%); }
    .badge { position: absolute; left: 150px; top: 190px; width: 340px; height: 340px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #ffffff33, ${t.a}88 60%, ${t.b}); border: 6px solid ${t.glow};
      box-shadow: 0 0 80px ${t.glow}aa, inset 0 0 50px #0006; display: grid; place-items: center; }
    .badge .emo { font-size: 190px; line-height: 1; filter: drop-shadow(0 10px 18px #0008); }
    .right { position: absolute; left: 610px; top: 110px; width: 610px; }
    .lvl { font-size: 44px; font-weight: 800; letter-spacing: 10px; color: ${t.glow}; text-shadow: 0 2px 12px #0008; }
    .num { font-size: 190px; font-weight: 900; line-height: .95; letter-spacing: -6px; text-shadow: 0 8px 30px #0009; }
    .num small { font-size: 64px; letter-spacing: 0; opacity: .6; font-weight: 800; }
    .pips { display: flex; gap: 8px; margin: 26px 0 30px; }
    .pip { flex: 1; height: 16px; border-radius: 8px; background: #ffffff26; }
    .pip.on { background: ${t.glow}; opacity: .8; }
    .pip.cur { background: #fff; box-shadow: 0 0 18px #fff, 0 0 30px ${t.glow}; }
    .row { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 18px; }
    .chip { font-size: 40px; font-weight: 800; padding: 10px 22px; border-radius: 999px; background: #0007; border: 3px solid #ffffff30; }
    .chip.strong { background: ${t.glow}; color: #1a1030; border-color: #fff; box-shadow: 0 6px 24px ${t.glow}88; }
    .chip .emo { font-size: 36px; }
    .brand { position: absolute; right: 44px; bottom: 30px; font-size: 26px; font-weight: 800; letter-spacing: 6px; opacity: .55; }
  </style></head><body>
    ${sparks(n, 70)}
    <div class="ring"></div>
    <div class="badge"><span class="emo">${L.e}</span></div>
    <div class="right">
      <div class="lvl">LEVEL</div>
      <div class="num">${n}<small> / ${N}</small></div>
      <div class="pips">${pips}</div>
      <div class="row">${reward}</div>
      <div class="row">${perks}</div>
    </div>
    <div class="brand">STARFORGE</div>
  </body></html>`;
}

function ladderHtml() {
  const tiles = E.LEVELS.map((L, i) => {
    const n = i + 1, t = tierOf(n), rw = E.levelReward(i);
    const stars = rw.stars ? `<div class="st">+${rw.stars}<span class="emo">⭐</span></div>` : `<div class="tk">${rw.tickets ? '+' + rw.tickets + '<span class="emo">🎫</span>' : '&nbsp;'}</div>`;
    return `<div class="tile" style="background: linear-gradient(160deg, ${t.a}, ${t.b}); box-shadow: 0 8px 26px ${t.a}55;">
      <div class="n">${n}</div><div class="e emo">${L.e}</div>${stars}</div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { background: radial-gradient(circle at 50% 0%, #3a1d6e 0%, #120a24 60%, #07060d 100%); position: relative; }
    h1 { position: absolute; top: 34px; left: 0; right: 0; text-align: center; font-size: 46px; letter-spacing: 12px; font-weight: 900; color: #ffd36b; text-shadow: 0 4px 20px #000a; }
    .grid { position: absolute; left: 60px; right: 60px; top: 120px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 22px; }
    .tile { height: 176px; border-radius: 26px; border: 3px solid #ffffff40; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .tile .n { position: absolute; left: 14px; top: 8px; font-size: 28px; font-weight: 900; opacity: .9; }
    .tile .e { font-size: 76px; line-height: 1; margin-top: 18px; }
    .tile .st { margin-top: 6px; font-size: 30px; font-weight: 900; color: #1a1030; background: #ffd36b; padding: 2px 16px; border-radius: 999px; }
    .tile .tk { margin-top: 6px; font-size: 28px; font-weight: 800; opacity: .9; }
    .emo { font-family: 'Noto Color Emoji', sans-serif; }
    .tile .st .emo, .tile .tk .emo { font-size: 24px; }
  </style></head><body>${sparks(99, 90)}<h1>LEVELS 1 → ${N}</h1><div class="grid">${tiles}</div></body></html>`;
}

function xpHtml() {
  const X = E.XP, R = E.XP_RATES;
  const items = [
    ['🎰', '+' + X.spin.per, 'XP'], ['🎲', '+' + R.gamePerStar, 'XP / ⭐'], ['🏦', '+' + X.bank.per, 'XP'],
    ['💬', '+1', 'XP'], ['👥', '+' + X.friend.per, 'XP'], ['💳', '+' + X.deposit.per, 'XP'],
  ];
  const cards = items.map(([e, v, u]) => `<div class="card"><div class="e emo">${e}</div><div class="v">${v}</div><div class="u">${u.replace('⭐', '<span class="emo">⭐</span>')}</div></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { background: radial-gradient(circle at 50% 110%, #ff8a2a 0%, #6b1d6e 45%, #0d0820 100%); position: relative; }
    h1 { position: absolute; top: 40px; left: 0; right: 0; text-align: center; font-size: 64px; font-weight: 900; letter-spacing: 8px; color: #fff; text-shadow: 0 6px 30px #000a; }
    h1 .emo { font-size: 58px; }
    .grid { position: absolute; left: 80px; right: 80px; top: 170px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; }
    .card { height: 230px; border-radius: 30px; background: #ffffff18; border: 3px solid #ffffff38; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 10px 40px #0006; }
    .card .e { font-size: 90px; line-height: 1.05; }
    .card .v { font-size: 58px; font-weight: 900; color: #ffd36b; }
    .card .u { font-size: 28px; font-weight: 800; opacity: .8; letter-spacing: 3px; }
    .card .u .emo { font-size: 26px; }
  </style></head><body>${sparks(7, 80)}<h1><span class="emo">⚡</span> XP <span class="emo">⚡</span></h1><div class="grid">${cards}</div></body></html>`;
}

// ─── Джекпот у чаті: jp-<приз>.jpg у web/img/jackpot ────────────────────
const JP_OUT = path.join(__dirname, '..', 'web', 'img', 'jackpot');
const JP_KINDS = { heart: '💝', bear: '🧸', rose: '🌹', gift: '🎁', cake: '🎂', bouquet: '💐', champagne: '🍾', stars: '⭐', tickets: '🎫', xp: '⚡' };
function jackpotHtml(kind) {
  // Для подарунків — справжня картинка подарунка (web/img/<kind>.png), інакше емодзі.
  const png = path.join(__dirname, '..', 'web', 'img', kind + '.png');
  const e = fs.existsSync(png)
    ? `<img src="data:image/png;base64,${fs.readFileSync(png).toString('base64')}" style="width:250px;height:250px;object-fit:contain;filter:drop-shadow(0 14px 24px #0009)">`
    : JP_KINDS[kind];
  const rays = Array.from({ length: 24 }, (_, i) => `<div class="ray" style="transform: rotate(${i * 15}deg)"></div>`).join('');
  let conf = '';
  let x = 42;
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const colors = ['#ffd36b', '#ff3d8a', '#5dffb0', '#7cc4ff', '#d2a6ff', '#ffffff'];
  for (let i = 0; i < 90; i++) {
    const w = 8 + rnd() * 14, h = 4 + rnd() * 8;
    conf += `<div class="cf" style="left:${rnd() * W}px;top:${rnd() * H}px;width:${w}px;height:${h}px;background:${colors[i % colors.length]};transform:rotate(${rnd() * 360}deg);opacity:${0.5 + rnd() * 0.5}"></div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { background: radial-gradient(circle at 50% 55%, #ffb020 0%, #b3245f 42%, #2a0b52 75%, #07060d 100%); position: relative; }
    .rays { position: absolute; left: 50%; top: 58%; width: 0; height: 0; }
    .ray { position: absolute; left: -40px; top: -900px; width: 80px; height: 900px; transform-origin: 40px 900px;
      background: linear-gradient(to top, #ffffff38, transparent 80%); clip-path: polygon(45% 100%, 55% 100%, 100% 0, 0 0); }
    .cf { position: absolute; border-radius: 2px; }
    h1 { position: absolute; top: 20px; left: 0; right: 0; text-align: center; font-size: 150px; font-weight: 900; letter-spacing: 14px;
      color: #ffe08a; text-shadow: 0 6px 0 #b3245f, 0 12px 40px #000c, 0 0 60px #ffd36b; }
    .ring { position: absolute; left: 50%; top: 58%; width: 380px; height: 380px; margin: -190px 0 0 -190px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #ffffff55, #ffb020cc 55%, #b3245f); border: 8px solid #ffe08a;
      box-shadow: 0 0 120px #ffd36bcc, inset 0 0 60px #0006; display: grid; place-items: center; }
    .ring .emo { font-size: 220px; line-height: 1; filter: drop-shadow(0 14px 24px #0009); }
    .brand { position: absolute; right: 44px; bottom: 30px; font-size: 26px; font-weight: 800; letter-spacing: 6px; opacity: .7; }
    .slot { position: absolute; left: 44px; bottom: 26px; font-size: 64px; }
    .sub { position: absolute; top: 196px; left: 0; right: 0; text-align: center; font-size: 34px; font-weight: 900; letter-spacing: 12px; color: #fff; text-shadow: 0 3px 14px #000b; }
  </style></head><body>
    <div class="rays">${rays}</div>${conf}
    <h1>JACKPOT</h1>
    <div class="ring"><span class="emo">${e}</span></div>
    <div class="slot emo">💬</div>
    <div class="sub">FOR ACTIVITY</div>
    <div class="brand">STARFORGE</div>
  </body></html>`;
}

(async () => {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const shot = async (html, name) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, name), type: 'jpeg', quality: 86 });
    console.log('✓', name);
  };
  for (let n = 1; n <= N; n++) await shot(levelHtml(n), `lvl-${n}.jpg`);
  await shot(ladderHtml(), 'ladder.jpg');
  await shot(xpHtml(), 'xp.jpg');
  fs.mkdirSync(JP_OUT, { recursive: true });
  for (const k of Object.keys(JP_KINDS)) {
    await page.setContent(jackpotHtml(k), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.screenshot({ path: path.join(JP_OUT, 'jp-' + k + '.jpg'), type: 'jpeg', quality: 78 });
    console.log('✓ jackpot/jp-' + k + '.jpg');
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
