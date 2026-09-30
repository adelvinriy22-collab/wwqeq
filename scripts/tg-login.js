// Одноразовий вхід в акаунт Telegram → друкує TG_SESSION для .env / Railway.
// Запуск: TG_API_ID=… TG_API_HASH=… node scripts/tg-login.js
require('dotenv').config();
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const q = (s) => new Promise(r => rl.question(s, r));

(async () => {
  const id = Number(process.env.TG_API_ID || await q('api_id: '));
  const hash = process.env.TG_API_HASH || await q('api_hash: ');
  const c = new TelegramClient(new StringSession(''), id, hash, { connectionRetries: 3 });
  await c.start({
    phoneNumber: () => q('Телефон (+380…): '),
    password: () => q('Пароль 2FA (якщо є): '),
    phoneCode: () => q('Код з Telegram: '),
    onError: (e) => console.error(e.message),
  });
  console.log('\nTG_SESSION=' + c.session.save() + '\n\nНікому не показуйте цей рядок — це повний доступ до акаунта.');
  rl.close();
  await c.disconnect();
  process.exit(0);
})();
