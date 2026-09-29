// Перевірка підпису Telegram WebApp initData.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// Порівняння за сталий час і термін дії (раніше перехоплений initData діяв вічно).
const crypto = require('crypto');
const config = require('../config');

let SECRET = null;
function secret() {
  if (!SECRET) SECRET = crypto.createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();
  return SECRET;
}

// Повертає { uid, user } або null.
function verify(initData) {
  try {
    if (!initData || typeof initData !== 'string' || initData.length > 8192) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const computed = crypto.createHmac('sha256', secret()).update(pairs.join('\n')).digest();
    const given = Buffer.from(hash, 'hex');
    if (given.length !== computed.length || !crypto.timingSafeEqual(given, computed)) return null;
    if (config.INITDATA_MAX_AGE_SEC) {
      const authDate = parseInt(params.get('auth_date'), 10) || 0;
      if (!authDate || Date.now() / 1000 - authDate > config.INITDATA_MAX_AGE_SEC) return null;
    }
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return { uid: String(user.id), user, startParam: params.get('start_param') || null };
  } catch (e) {
    return null;
  }
}

function fromRequest(req) {
  const raw = req.get('x-init-data') || (req.body && req.body.initData) || (req.query && req.query.initData) || '';
  return verify(String(raw));
}

module.exports = { verify, fromRequest };
