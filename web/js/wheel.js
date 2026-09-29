// Колесо: SVG із секторів, які надсилає сервер (ті самі, що й на сервері),
// тож стрілка завжди зупиняється на секторі реального результату.
import { el, svg } from './dom.js';

const C = 100, R = 97;
const PAL = {
  stars: ['var(--btn)', 'color-mix(in srgb, var(--btn) 62%, var(--section))'],
  tickets: ['#ff9f0a', 'color-mix(in srgb, #ff9f0a 70%, var(--section))'],
  prize: ['color-mix(in srgb, var(--gold) 30%, var(--section))', 'color-mix(in srgb, var(--gold) 18%, var(--section))'],
};

function arc(a0, a1, r) {
  const p = (a) => [C + r * Math.sin(a * Math.PI / 180), C - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${C},${C} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}

export function createWheel(segments) {
  const n = segments.length;
  const step = 360 / n;
  const kids = [svg('circle', { cx: C, cy: C, r: R + 2, style: 'fill: var(--section)' })];
  segments.forEach((s, i) => {
    const a0 = i * step, mid = a0 + step / 2;
    const pal = PAL[s.kind] || PAL.stars;
    kids.push(svg('path', { d: arc(a0, a0 + step, R), style: 'fill: ' + pal[i % 2] + '; stroke: var(--section); stroke-width: 1.2' }));
    const g = svg('g', { transform: `rotate(${mid} ${C} ${C})` });
    // Нижня половина: перевертаємо підпис, щоб не читати догори дриґом.
    const flip = mid > 90 && mid < 270;
    const inner = svg('g', flip ? { transform: `rotate(180 ${C} 32)` } : {});
    g.appendChild(inner);
    if (s.kind === 'prize') {
      inner.appendChild(svg('image', { href: '/img/' + (s.img || 'gift') + '.png', x: C - 14, y: 12, width: 28, height: 28, preserveAspectRatio: 'xMidYMid meet' }));
    } else {
      const light = s.kind === 'stars' && i % 2 === 0;
      inner.appendChild(svg('text', {
        x: C, y: flip ? 38 : 34, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 800,
        style: 'fill: ' + (light ? 'var(--btn-text)' : 'var(--text)') + '; font-family: inherit',
      }, String(s.amount)));
      inner.appendChild(svg('text', { x: C, y: flip ? 22 : 50, 'text-anchor': 'middle', 'font-size': 12 }, s.kind === 'tickets' ? '🎫' : '⭐'));
    }
    kids.push(g);
  });
  kids.push(svg('circle', { cx: C, cy: C, r: R, style: 'fill: none; stroke: color-mix(in srgb, var(--text) 10%, transparent); stroke-width: 1' }));
  const disk = svg('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': 'wheel' }, kids);
  const wrap = el('div', { class: 'wheel-wrap' }, el('div', { class: 'wheel-pointer' }), disk, el('div', { class: 'wheel-hub' }, '⭐'));

  let rot = 0;
  disk.style.transition = 'none';
  disk.style.transform = 'rotate(0deg)';

  // Прокрутити так, щоб сектор index опинився під стрілкою.
  function spinTo(index, ms) {
    const dur = ms || 4200;
    const mid = index * step + step / 2;
    const jitter = (Math.random() - 0.5) * (step - 8);
    const target = -mid + jitter;
    const cur = ((rot % 360) + 360) % 360;
    const delta = ((target - cur) % 360 + 360) % 360;
    rot = rot + 360 * 6 + delta;
    disk.style.transition = `transform ${dur}ms cubic-bezier(.12,.72,.08,1)`;
    // Змушуємо браузер застосувати transition до нового значення.
    void disk.getBoundingClientRect();
    disk.style.transform = `rotate(${rot}deg)`;
    return new Promise((r) => setTimeout(r, dur + 80));
  }
  // Легке «підкручування», поки чекаємо відповідь сервера.
  function nudge() {
    rot += 40;
    disk.style.transition = 'transform 500ms ease-in';
    disk.style.transform = `rotate(${rot}deg)`;
  }
  return { el: wrap, spinTo, nudge };
}
