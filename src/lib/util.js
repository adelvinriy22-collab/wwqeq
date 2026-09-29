// Дрібні спільні помічники.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 2.2 замість 2.1999999; ціле — без дробу.
function fmtStars(n) {
  const v = round2(n);
  return (v % 1 === 0) ? String(v) : String(v.toFixed(2)).replace(/0$/, '');
}

// Для parse_mode: 'HTML'.
function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// Як назвати людину в тексті: @username (завжди безпечний) або екранізоване ім'я.
function whoOf(u, fallback) {
  if (u && u.username) return '@' + u.username;
  return esc((u && u.name) || fallback || 'гравець');
}
function plainWho(u, fallback) {
  if (u && u.username) return '@' + u.username;
  return (u && u.name) || fallback || 'гравець';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Українська множина: 1 спін, 2 спіни, 5 спінів.
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

module.exports = { round2, fmtStars, esc, whoOf, plainWho, sleep, plural, has };
