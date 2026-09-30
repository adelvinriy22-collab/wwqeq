// ==========================================================================
// СПРАВЖНІ ПОДАРУНКИ TELEGRAM від бота (Bot API sendGift). Подарунок оплачується
// зірками з балансу бота. Використовують автовивід і джекпот у чаті.
// ==========================================================================
const notify = require('../core/notify');

// Наші призи → подарунки з каталогу Telegram (емодзі й ціна у зірках).
// fallbackId — на випадок, якщо каталог тимчасово не відповів.
const CATALOG = {
  bear:   { emoji: '🧸', stars: 15,  fallbackId: '5170233102089322756' },
  gift:   { emoji: '🎁', stars: 25,  fallbackId: '5170250947678437525' },
  rocket: { emoji: '🚀', stars: 50,  fallbackId: '5170564780938756245' },
  trophy: { emoji: '🏆', stars: 100, fallbackId: '5168043875654172773' },
};
const TEXT_MAX = 128;
const KEEP_ENTITIES = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'custom_emoji']);

let cache = { at: 0, gifts: [] };
async function catalog() {
  if (cache.gifts.length && Date.now() - cache.at < 3600e3) return cache.gifts;
  try {
    const r = await notify.tg.telegram.callApi('getAvailableGifts', {});
    const gifts = (r && Array.isArray(r.gifts)) ? r.gifts : [];
    if (gifts.length) cache = { at: Date.now(), gifts };
  } catch (e) { console.error('getAvailableGifts:', e.message); }
  return cache.gifts;
}
const canSend = (tierId) => !!CATALOG[tierId];

async function giftId(tierId) {
  const c = CATALOG[tierId];
  if (!c) return null;
  const list = await catalog();
  const g = list.find(x => x.star_count === c.stars && x.sticker && x.sticker.emoji === c.emoji && !x.total_count)
    || list.find(x => x.sticker && x.sticker.emoji === c.emoji && x.star_count === c.stars)
    || list.find(x => x.sticker && x.sticker.emoji === c.emoji);
  return g ? g.id : c.fallbackId;
}

// Лише те форматування, яке Telegram приймає в підписі подарунка (включно з преміум-емодзі).
function cleanEntities(ents) {
  return (ents || []).filter(e => KEEP_ENTITIES.has(e.type)).map(e => {
    const o = { type: e.type, offset: e.offset, length: e.length };
    if (e.type === 'custom_emoji') o.custom_emoji_id = e.custom_emoji_id;
    return o;
  });
}

// Надіслати подарунок. → { ok: true } або { ok: false, error, lowBalance }
async function send(uid, tierId, text, entities) {
  if (!notify.tg.telegram) return { ok: false, error: 'bot_offline' };
  const id = await giftId(tierId);
  if (!id) return { ok: false, error: 'unknown_gift' };
  const payload = { user_id: Number(uid), gift_id: id };
  const t = String(text || '').slice(0, TEXT_MAX);
  if (t) { payload.text = t; const en = cleanEntities(entities); if (en.length) payload.text_entities = en; }
  try {
    await notify.tg.telegram.callApi('sendGift', payload);
    return { ok: true, giftId: id, stars: CATALOG[tierId].stars };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: msg.slice(0, 300), lowBalance: /BALANCE_TOO_LOW|not enough|STARGIFT_/i.test(msg) };
  }
}

module.exports = { send, giftId, canSend, cleanEntities, CATALOG, TEXT_MAX };
