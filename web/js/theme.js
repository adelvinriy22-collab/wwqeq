// Похідні кольори теми (напівпрозорі підкладки, відтінки секторів колеса).
// Рахуємо їх тут, а не через CSS color-mix(): старі Android WebView, у яких
// працює Telegram, color-mix не знають — і шапка ставала прозорою (текст
// налазив на текст), а сектори колеса малювались чорними.
const root = document.documentElement;

function parse(c) {
  const s = String(c || '').trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split('').map(x => parseInt(x + x, 16));
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return [+m[1], +m[2], +m[3]].map(Math.round);
  return null;
}
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const mix = (a, b, p) => `rgb(${a.map((x, i) => Math.round(x * p + b[i] * (1 - p))).join(', ')})`;

export function applyTheme() {
  const cs = getComputedStyle(root);
  const get = (name, def) => parse(cs.getPropertyValue(name)) || parse(def);
  const btn = get('--btn', '#2481cc');
  const section = get('--section', '#ffffff');
  const text = get('--text', '#000000');
  const hint = get('--hint', '#8e8e93');
  const danger = get('--danger', '#e53935');
  const gold = [245, 179, 0], ok = [52, 199, 89], warn = [255, 149, 0], tix = [255, 159, 10];
  const set = (k, v) => root.style.setProperty(k, v);
  set('--tint', rgba(btn, 0.12));
  set('--tint2', rgba(btn, 0.22));
  set('--hint-t', rgba(hint, 0.16));
  set('--hint-t2', rgba(hint, 0.35));
  set('--text-t', rgba(text, 0.1));
  set('--toast-bg', rgba(text, 0.88));
  set('--gold-t', rgba(gold, 0.2));
  set('--ok-t', rgba(ok, 0.16));
  set('--danger-t', rgba(danger, 0.14));
  set('--warn-t', rgba(warn, 0.18));
  set('--prem-cell', rgba(gold, 0.08));
  set('--btn-sub', rgba(parse(cs.getPropertyValue('--btn-text')) || [255, 255, 255], 0.8));
  // Сектори колеса: основний колір і світліший для чергування.
  set('--w-star-a', mix(btn, section, 1));
  set('--w-star-b', mix(btn, section, 0.62));
  set('--w-tix-a', mix(tix, section, 1));
  set('--w-tix-b', mix(tix, section, 0.7));
  set('--w-prize-a', mix(gold, section, 0.32));
  set('--w-prize-b', mix(gold, section, 0.18));
}

// Деякі телефони (Android із великим шрифтом у системі) збільшують УВЕСЬ текст
// у WebView. Звичайні тексти від цього просто переносяться, а от емодзі в
// кружечках, підписи на колесах і нижнє меню мають фіксований розмір — і там
// збільшений текст налазив на картинки й сусідні написи. Міряємо, у скільки
// разів телефон збільшив текст, і для таких місць повертаємо задуманий розмір.
let fx = 1;
export const textFix = () => fx;
export function measureTextScale() {
  try {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:100px;line-height:1;white-space:nowrap;margin:0;padding:0;border:0';
    d.textContent = 'M';
    document.body.appendChild(d);
    const k = d.getBoundingClientRect().height / 100;
    d.remove();
    fx = k > 1.04 && k < 4 ? Math.max(0.4, 1 / k) : 1;
  } catch (e) { fx = 1; }
  document.documentElement.style.setProperty('--fx', String(fx));
  return fx;
}

export function watchTheme(tg) {
  measureTextScale();
  applyTheme();
  try { if (tg && tg.onEvent) tg.onEvent('themeChanged', () => setTimeout(applyTheme, 0)); } catch (e) {}
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTimeout(applyTheme, 0);
    if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
  } catch (e) {}
}
