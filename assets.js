// ==========================================================================
// Картинки нагород. Лежать у public/img — ті самі файли, що показує WebApp,
// тому в чаті й у застосунку людина бачить один і той самий приз.
//
// Раніше вони були вшиті в код base64-рядками (~300 КБ у цьому файлі й ще
// ~380 КБ у wheel.html), і застосунок завантажував їх щоразу заново, бо
// сторінка віддається без кешу. Тепер кожна картинка — окремий файл із
// довгим кешем, а тут вони читаються з диска один раз і тримаються в пам'яті.
// Якщо файлу немає, photo() повертає null — виклики sendPhoto мають
// запасний текстовий варіант, тож бот від цього не падає.
// ==========================================================================

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'img');
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

// Telegraf приймає { source: Buffer } як джерело фото.
function photo(id) {
  const b = buffer(id);
  return b ? { source: b, filename: id + '.png' } : null;
}

module.exports = { photo, buffer, has: (id) => !!buffer(id), DIR };
