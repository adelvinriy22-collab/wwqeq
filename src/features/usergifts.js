// ==========================================================================
// ТЕСТ: подарунки Telegram від імені АКАУНТА власника (MTProto, бібліотека
// `telegram`/GramJS). Оплачуються зірками з балансу акаунта, не бота.
// Потрібні TG_API_ID, TG_API_HASH (my.telegram.org) і TG_SESSION
// (рядок сесії — `node scripts/tg-login.js`). Без них модуль вимкнений.
// ==========================================================================
const config = require('../config');
const tggifts = require('./tggifts');

const TEXT_MAX = 255;   // ліміт підпису подарунка для акаунтів
const fs = require('fs');
const path = require('path');

// Сесія: TG_SESSION з оточення або збережена через /tg_login (QR) у DATA_DIR.
const SESSION_FILE = path.join(config.DATA_DIR, 'tg-session.txt');
function session() {
  if (config.TG_SESSION) return config.TG_SESSION;
  try { return fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch (e) { return ''; }
}
// Зберегти (або '' — видалити) сесію. → чи була збережена раніше.
function saveSession(s) {
  let had = false;
  try { had = fs.existsSync(SESSION_FILE); } catch (e) {}
  if (s) { fs.mkdirSync(config.DATA_DIR, { recursive: true }); fs.writeFileSync(SESSION_FILE, s, { mode: 0o600 }); }
  else { try { fs.unlinkSync(SESSION_FILE); } catch (e) {} }
  if (clientP) clientP.then(c => c.disconnect()).catch(() => {});
  clientP = null;
  return had;
}

const dryRun = () => config.USERGIFT_DRY_RUN;
// Справжній акаунт підключено (без сухого прогону).
const accountReady = () => !!(config.TG_API_ID && config.TG_API_HASH && session());
const enabled = () => dryRun() || !!(config.TG_API_ID && config.TG_API_HASH && session());

let clientP = null;
function client() {
  if (!clientP) {
    clientP = (async () => {
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');
      const c = new TelegramClient(new StringSession(session()), Number(config.TG_API_ID), config.TG_API_HASH, { connectionRetries: 3 });
      c.setLogLevel('error');
      await c.connect();
      if (!(await c.checkAuthorization())) throw new Error('сесія недійсна — увійдіть знову: /tg_login');
      return c;
    })().catch(e => { clientP = null; throw e; });
  }
  return clientP;
}

// Подарунок з каталогу акаунта за нашим tierId (емодзі + ціна), інакше fallback id.
async function findGift(c, tierId) {
  const { Api } = require('telegram');
  const t = tggifts.CATALOG[tierId];
  if (!t) return null;
  try {
    const r = await c.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
    const list = (r && r.gifts) || [];
    const emo = (g) => g.sticker && (g.sticker.attributes || []).map(a => a.alt).find(Boolean);
    const g = list.find(x => !x.soldOut && !x.limited && Number(x.stars) === t.stars && emo(x) === t.emoji)
      || list.find(x => !x.soldOut && emo(x) === t.emoji);
    if (g) return g.id;
  } catch (e) { console.error('getStarGifts:', e.message); }
  return t.fallbackId;
}

// Форматування підпису: Bot API → MTProto (жирний, курсив, преміум-емодзі…).
const ENT = { bold: 'MessageEntityBold', italic: 'MessageEntityItalic', underline: 'MessageEntityUnderline',
  strikethrough: 'MessageEntityStrike', spoiler: 'MessageEntitySpoiler', custom_emoji: 'MessageEntityCustomEmoji' };
function toMtEntities(Api, bigInt, ents) {
  return tggifts.cleanEntities(ents).filter(e => ENT[e.type]).map(e => new Api[ENT[e.type]]({
    offset: e.offset, length: e.length, ...(e.type === 'custom_emoji' ? { documentId: bigInt(String(e.custom_emoji_id)) } : {}),
  }));
}

// Надіслати подарунок від акаунта. target — @нік або числовий id.
// → { ok: true, stars } або { ok: false, error }
async function send(target, tierId, text, entities) {
  if (!enabled()) return { ok: false, error: 'not_configured' };
  if (!tggifts.CATALOG[tierId]) return { ok: false, error: 'unknown_gift' };
  if (dryRun()) return { ok: true, stars: tggifts.CATALOG[tierId].stars, dry: true };
  try {
    const { Api } = require('telegram');
    const bigInt = require('big-integer');
    const c = await client();
    const peer = await c.getInputEntity(/^\d+$/.test(String(target)) ? bigInt(String(target)) : String(target));
    const id = await findGift(c, tierId);
    const t = String(text || '').slice(0, TEXT_MAX);
    const invoice = new Api.InputInvoiceStarGift({
      peer, giftId: bigInt(String(id)),
      message: t ? new Api.TextWithEntities({ text: t, entities: toMtEntities(Api, bigInt, (entities || []).filter(e => e.offset + e.length <= t.length)) }) : undefined,
    });
    const form = await c.invoke(new Api.payments.GetPaymentForm({ invoice }));
    await c.invoke(new Api.payments.SendStarsForm({ formId: form.formId, invoice }));
    return { ok: true, stars: tggifts.CATALOG[tierId].stars };
  } catch (e) {
    return { ok: false, error: String((e && (e.errorMessage || e.message)) || e).slice(0, 300) };
  }
}

module.exports = { send, enabled, accountReady, dryRun, saveSession, TEXT_MAX };
