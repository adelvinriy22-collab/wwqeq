// Преміум-емодзі (custom emoji) для повідомлень бота й чату.
// fallback — звичайний символ, якщо в людини немає Telegram Premium.
const EMOJI = {
  flagUk:     { fallback: '🇺🇦', id: '5447309366568953338' },
  flagEn:     { fallback: '🇬🇧', id: '5202196682497859879' },
  flagRu:     { fallback: '🇷🇺', id: '5449408995691341691' },
  back:       { fallback: '🔙', id: '5406745015365943482' },
  lightning:  { fallback: '⚡', id: '5456140674028019486' },
  eye:        { fallback: '👁', id: '5210956306952758910' },
  teddyBear:  { fallback: '🧸', id: '5280598054901145762' },
  almost:     { fallback: '🔥', id: '5440660757194744323' },
  check:      { fallback: '✅', id: '5206607081334906820' },
  warn:       { fallback: '⚠️', id: '5420323339723881652' },
  giftBox:    { fallback: '🎁', id: '5280615440928758599' },
  rocket:     { fallback: '🚀', id: '5283080528818360566' },
  trophy:     { fallback: '🏆', id: '5280769763398671636' },
  inventoryBag: { fallback: '🎒', id: '5388630359434867505' },
  withdrawBox:  { fallback: '📦', id: '6334602442591700514' },
  commission:   { fallback: '💳', id: '5332822894420435903' },
  lockIcon:     { fallback: '🔒', id: '5296369303661067030' },
  starIcon:     { fallback: '⭐', id: '5267500801240092311' },
  greenCircle:  { fallback: '🟢', id: '5416081784641168838' },
  redCircle:    { fallback: '🔴', id: '5411225014148014586' },
  goldMedal:    { fallback: '🥇', id: '5440539497383087970' },
  silverMedal:  { fallback: '🥈', id: '5447203607294265305' },
  bronzeMedal:  { fallback: '🥉', id: '5453902265922376865' },
  crown:        { fallback: '👑', id: '5217822164362739968' },
  statsIcon:    { fallback: '📊', id: '5231200819986047254' },
  megaphone:    { fallback: '📣', id: '5424818078833715060' },
  infoIcon:     { fallback: 'ℹ️', id: '5334544901428229844' },
  clockIcon:    { fallback: '⏰', id: '5440621591387980068' },
  settingsIcon: { fallback: '⚙️', id: null },
  applicationsIcon: { fallback: '📋', id: '5402108679774282930' },
  pendingIcon: { fallback: '⏳', id: '5451732530048802485' },
  anonymityIcon: { fallback: '🕶️', id: '5371017798065592581' },
  lunarSnake: { fallback: '🐍' },
  lolPop: { fallback: '🍭' },
  evilEye: { fallback: '🧿' },
  premium: { fallback: '💎' },
  xmasStocking: { fallback: '🧦', id: '5427369620120037285' },
  freshSocks:   { fallback: '🧦', id: '5364209677901000500' },
  diamondRing:  { fallback: '💍', id: '5357128638334526881' },
  promoCode:    { fallback: '💎', id: '5427168083074628963' },
};

// HTML-варіант для parse_mode: 'HTML'.
function E(key, alt) {
  const e = EMOJI[key];
  if (e && e.id) return '<tg-emoji emoji-id="' + e.id + '">' + e.fallback + '</tg-emoji>';
  return (e && e.fallback) || alt || '';
}

module.exports = { EMOJI, E };
