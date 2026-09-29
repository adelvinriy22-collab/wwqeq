// Мінімальний «гіперскрипт»: el('div', { class: 'x', onclick }, 'текст', child).
// Рядки завжди стають текстовими вузлами — жодного innerHTML із даними
// сервера, тож XSS через ім'я гравця чи текст заявки неможливий.
export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
  }
  append(n, kids);
  return n;
}
function append(n, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false || k === true) continue;
    if (Array.isArray(k)) append(n, k);
    else if (k instanceof Node) n.appendChild(k);
    else n.appendChild(document.createTextNode(String(k)));
  }
}
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
export const mount = (n, ...kids) => { clear(n); append(n, kids); return n; };

// SVG
const NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

export const img = (name, cls) => name ? el('img', { src: '/img/' + encodeURIComponent(name) + '.png', alt: '', class: cls || null, loading: 'lazy', decoding: 'async' }) : null;
