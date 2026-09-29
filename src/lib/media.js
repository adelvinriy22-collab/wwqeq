// Картинки призів для повідомлень бота — ті самі файли, що в застосунку (web/img).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'web', 'img');
const cache = new Map();

function buffer(id) {
  if (!/^[a-z0-9_]+$/i.test(String(id || ''))) return null;
  if (!cache.has(id)) {
    let b = null;
    try { b = fs.readFileSync(path.join(DIR, id + '.png')); } catch (e) { b = null; }
    cache.set(id, b);
  }
  return cache.get(id);
}
function photo(id) { const b = buffer(id); return b ? { source: b, filename: id + '.png' } : null; }

module.exports = { photo, buffer, DIR };
