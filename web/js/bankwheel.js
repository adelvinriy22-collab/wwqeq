// Колесо спільного банку: кожен гравець — сектор завбільшки з його частку.
// Під час розіграшу колесо прокручується до сектора переможця.
import { el, svg } from './dom.js';

const C = 100, R = 97;
export const BANK_COLORS = ['#3E88F7', '#FF9F0A', '#34C759', '#AF52DE', '#FF375F', '#5AC8FA', '#FFCC00', '#FF6B35', '#30B0C7', '#BF5AF2', '#8E8E93', '#A2845E'];
const spun = {};   // id банку -> кут, на якому колесо зупинилось

function arc(a0, a1, r) {
  const p = (a) => [C + r * Math.sin(a * Math.PI / 180), C - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${C},${C} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}
const short = (s, n) => { const x = String(s || '').replace(/^@/, ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };

// sectors: [{ uid, name, percent, me }], youLabel — як підписати свій сектор.
export function createBankWheel(sectors, bankId, youLabel) {
  const kids = [svg('circle', { cx: C, cy: C, r: R + 2, style: 'fill: var(--section)' })];
  const spans = [];
  if (!sectors.length) {
    for (let i = 0; i < 8; i++) kids.push(svg('path', { d: arc(i * 45, i * 45 + 45, R), style: 'fill: ' + (i % 2 ? 'var(--w-star-b)' : 'var(--w-star-a)') + '; opacity: .35' }));
  } else {
    const total = sectors.reduce((a, s) => a + s.percent, 0) || 100;
    let acc = 0;
    sectors.forEach((s, i) => {
      const deg = Math.max(0.6, s.percent / total * 360);
      const a0 = acc, a1 = Math.min(360, acc + deg);
      const color = BANK_COLORS[i % BANK_COLORS.length];
      const style = 'fill: ' + color + '; stroke: var(--section); stroke-width: ' + (sectors.length > 1 ? 1.2 : 0);
      kids.push(sectors.length === 1 ? svg('circle', { cx: C, cy: C, r: R, style }) : svg('path', { d: arc(a0, a1, R), style }));
      spans.push({ uid: String(s.uid), a0, a1 });
      // Підпис уздовж радіуса («спицею») — поперек вузького сектора місця немає.
      if (a1 - a0 >= 14) {
        const mid = (a0 + a1) / 2;
        let rot = mid - 90;
        const flip = mid > 180;
        if (flip) rot += 180;
        const g = svg('g', { transform: `rotate(${rot} ${C} ${C})` });
        const x = flip ? C - 58 : C + 58;
        g.appendChild(svg('text', {
          x, y: C, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': a1 - a0 >= 30 ? 10 : 8.5, 'font-weight': 700,
          style: 'fill: #fff; font-family: inherit; paint-order: stroke; stroke: rgba(0,0,0,.25); stroke-width: 2px',
        }, (s.me ? youLabel : short(s.name, 11)) + ' · ' + s.percent + '%'));
        kids.push(g);
      }
      acc = a1;
    });
  }
  kids.push(svg('circle', { cx: C, cy: C, r: R, style: 'fill: none; stroke: var(--text-t); stroke-width: 1' }));
  const disk = svg('svg', { viewBox: '0 0 200 200', width: '100%', height: '100%', role: 'img', 'aria-label': 'bank' }, kids);
  disk.style.display = 'block';
  disk.style.transformOrigin = '50% 50%';
  const hub = el('div', { class: 'wheel-hub bank-hub' }, '🏦');
  const wrap = el('div', { class: 'wheel-wrap' }, el('div', { class: 'wheel-pointer' }), disk, hub);
  if (!sectors.length) wrap.appendChild(el('div', { class: 'bank-empty' }));

  let rot = spun[bankId] || 0;
  const apply = (deg, ms) => {
    disk.style.transition = ms ? `transform ${ms}ms cubic-bezier(.12,.72,.08,1)` : 'none';
    disk.style.webkitTransition = ms ? `-webkit-transform ${ms}ms cubic-bezier(.12,.72,.08,1)` : 'none';
    disk.style.transform = `rotate(${deg}deg)`;
    disk.style.webkitTransform = `rotate(${deg}deg)`;
  };
  apply(rot, 0);

  // Прокрутити до сектора переможця. Повторний виклик для того самого банку
  // лише ставить колесо на місце, без анімації.
  function spinToWinner(uid, ms) {
    const sp = spans.find(x => x.uid === String(uid));
    if (!sp) return Promise.resolve(false);
    const mid = (sp.a0 + sp.a1) / 2;
    const target = -mid + (Math.random() - 0.5) * Math.min(20, (sp.a1 - sp.a0) * 0.6);
    if (spun[bankId] !== undefined) { apply(spun[bankId], 0); return Promise.resolve(true); }
    rot = 360 * 7 + (((target % 360) + 360) % 360);
    spun[bankId] = rot;
    void disk.getBoundingClientRect();
    apply(rot, ms || 6000);
    return new Promise(r => setTimeout(() => r(true), (ms || 6000) + 100));
  }
  const alreadySpun = () => spun[bankId] !== undefined;
  return { el: wrap, spinToWinner, alreadySpun, colors: BANK_COLORS };
}
