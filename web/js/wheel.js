// Колесо: SVG із секторів, які надсилає сервер (ті самі, що й на сервері),
// тож стрілка завжди зупиняється на секторі реального результату.
//
// Положення колеса пам'ятається між перемальовками екрана: раніше після
// закриття вікна з результатом колесо малювалось заново з нуля, і стрілка
// показувала зовсім інший сектор, ніж той, що випав.
import { el, svg } from './dom.js';

const C = 100, R = 97;
const XLINK = 'http://www.w3.org/1999/xlink';
const PAL = {
  stars: ['var(--w-star-a)', 'var(--w-star-b)'],
  tickets: ['var(--w-tix-a)', 'var(--w-tix-b)'],
  prize: ['var(--w-prize-a)', 'var(--w-prize-b)'],
};
const lastRot = {};          // ключ колеса -> кут, на якому воно зупинилось

function arc(a0, a1, r) {
  const p = (a) => [C + r * Math.sin(a * Math.PI / 180), C - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${C},${C} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}
function setHref(node, name) {
  const url = '/img/' + encodeURIComponent(name || 'gift') + '.png';
  node.setAttribute('href', url);
  node.setAttributeNS(XLINK, 'xlink:href', url);   // старі WebView знають лише xlink:href
}

export function createWheel(segments, key) {
  const n = segments.length;
  const step = 360 / n;
  // Зображення призу вписуємо в ширину сектора на його радіусі.
  const imgSize = Math.max(18, Math.min(28, Math.floor(2 * Math.PI * 58 * (step / 360)) - 4));
  const kids = [svg('circle', { cx: C, cy: C, r: R + 2, style: 'fill: var(--section)' })];
  const images = [];
  segments.forEach((s, i) => {
    const a0 = i * step, mid = a0 + step / 2;
    const pal = PAL[s.kind] || PAL.stars;
    const fill = pal[i % 2];
    kids.push(svg('path', { d: arc(a0, a0 + step, R), style: 'fill: ' + fill + '; stroke: var(--section); stroke-width: 1.2' }));
    const g = svg('g', { transform: `rotate(${mid} ${C} ${C})` });
    // Підпис завжди «ногами» до центру: сектор, що зупинився під стрілкою
    // (угорі), читається рівно. Перевертати нижні підписи не можна — колесо
    // обертається, і виграний сектор показав би число догори дриґом.
    const inner = svg('g');
    g.appendChild(inner);
    if (s.kind === 'prize') {
      const im = svg('image', { x: C - imgSize / 2, y: 30 - imgSize / 2, width: imgSize, height: imgSize, preserveAspectRatio: 'xMidYMid meet' });
      setHref(im, s.img);
      images[i] = { node: im, cycle: s.cycle && s.cycle.length ? s.cycle.filter(Boolean) : null, pos: 0 };
      inner.appendChild(im);
    } else {
      const light = s.kind === 'stars' && i % 2 === 0;
      const label = s.kind === 'tickets' ? '🎫' : '⭐';
      inner.appendChild(svg('text', {
        x: C, y: 30, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 15, 'font-weight': 800,
        style: 'fill: ' + (light ? 'var(--btn-text)' : 'var(--text)') + '; font-family: inherit',
      }, String(s.amount)));
      inner.appendChild(svg('text', { x: C, y: 46, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 11 }, label));
    }
    kids.push(g);
  });
  kids.push(svg('circle', { cx: C, cy: C, r: R, style: 'fill: none; stroke: var(--text-t); stroke-width: 1' }));
  const disk = svg('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': 'wheel', width: '100%', height: '100%' }, kids);
  disk.style.display = 'block';
  const wrap = el('div', { class: 'wheel-wrap' }, el('div', { class: 'wheel-pointer' }), disk, el('div', { class: 'wheel-hub' }, '⭐'));

  // Стартове положення: стрілка посередині сектора, а не на межі двох.
  let rot = key && lastRot[key] !== undefined ? lastRot[key] : -step / 2;
  disk.style.transformOrigin = '50% 50%';
  disk.style.webkitTransformOrigin = '50% 50%';
  const apply = (deg, ms, ease) => {
    const tr = ms ? `transform ${ms}ms ${ease}` : 'none';
    disk.style.webkitTransition = ms ? `-webkit-transform ${ms}ms ${ease}` : 'none';
    disk.style.transition = tr;
    disk.style.webkitTransform = `rotate(${deg}deg)`;
    disk.style.transform = `rotate(${deg}deg)`;
  };
  apply(rot, 0);

  // Сектор NFT по черзі показує можливі призи, поки колесо стоїть.
  let spinning = false;
  const cycler = setInterval(() => {
    if (!wrap.isConnected) { if (wrap.dataset.seen) clearInterval(cycler); return; }
    wrap.dataset.seen = '1';
    if (spinning) return;
    for (const im of images) {
      if (!im || !im.cycle || im.cycle.length < 2 || im.locked) continue;
      im.pos = (im.pos + 1) % im.cycle.length;
      setHref(im.node, im.cycle[im.pos]);
    }
  }, 1600);

  // Прокрутити так, щоб сектор index опинився під стрілкою.
  function spinTo(index, ms) {
    const dur = ms || 4200;
    spinning = true;
    const mid = index * step + step / 2;
    const jitter = (Math.random() - 0.5) * step * 0.6;
    const target = -mid + jitter;
    const cur = ((rot % 360) + 360) % 360;
    const delta = ((target - cur) % 360 + 360) % 360;
    rot = rot + 360 * 6 + delta;
    if (key) lastRot[key] = rot;
    void disk.getBoundingClientRect();
    apply(rot, dur, 'cubic-bezier(.12,.72,.08,1)');
    return new Promise((r) => setTimeout(() => { spinning = false; r(); }, dur + 80));
  }
  // Легке «підкручування», поки чекаємо відповідь сервера.
  function nudge() {
    rot += 40;
    if (key) lastRot[key] = rot;
    apply(rot, 500, 'ease-in');
  }
  // Показати в секторі саме той приз, що випав (для NFT-сектора).
  function showPrize(index, imgName) {
    const im = images[index];
    if (!im || !imgName) return;
    im.locked = true;
    setHref(im.node, imgName);
  }
  return { el: wrap, spinTo, nudge, showPrize };
}
