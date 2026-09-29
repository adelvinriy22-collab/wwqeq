// Спільне для тестів: фейковий Telegram Bot API і підписаний initData.
const http = require('http');
const crypto = require('crypto');

function startFakeTelegram() {
  const calls = [];
  const queue = [];      // апдейти, які «прийдуть» боту через getUpdates
  let nextUpdateId = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop().split('?')[0];
      let payload = {};
      try { payload = body && req.headers['content-type'] && req.headers['content-type'].includes('json') ? JSON.parse(body) : {}; } catch (e) {}
      calls.push({ method, payload });
      const ok = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      switch (method) {
        case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'Test', username: 'TestStarBot' });
        case 'getChatMember': return ok({ status: 'member', user: { id: payload.user_id } });
        case 'getUpdates': {
          const off = payload.offset || 0;
          const ready = queue.filter(u => u.update_id >= off);
          if (ready.length) return ok(ready);
          return setTimeout(() => ok(queue.filter(u => u.update_id >= off)), 150);
        }
        case 'sendDice': return ok({ message_id: 2, chat: { id: payload.chat_id }, dice: { emoji: payload.emoji || '🎲', value: 6 } });
        case 'createInvoiceLink': return ok('https://t.me/$invoice');
        default: return ok(method.startsWith('send') || method.startsWith('copy') ? { message_id: 1, chat: { id: payload.chat_id }, date: 0 } : true);
      }
    });
  });
  const push = (u) => { const upd = { update_id: nextUpdateId++, ...u }; queue.push(upd); return upd; };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, push, port: server.address().port })));
}

function signInitData(token, user, authDate) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate || Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAE' + crypto.randomBytes(4).toString('hex'));
  params.set('user', JSON.stringify(user));
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex'));
  return params.toString();
}

module.exports = { startFakeTelegram, signInitData };
