// Обгортка над Telegram WebApp: працює й у звичайному браузері (для перевірки),
// де частина можливостей замінюється простими аналогами.
const W = window.Telegram && window.Telegram.WebApp;
export const tg = W && W.initData ? W : null;

export function ready() {
  if (!tg) return;
  document.documentElement.classList.add('tg');
  try { tg.ready(); tg.expand(); } catch (e) {}
  try { if (tg.isVersionAtLeast && tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) {}
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--tg-theme-secondary-bg-color').trim();
    if (bg && tg.setHeaderColor) tg.setHeaderColor('secondary_bg_color');
    if (tg.setBackgroundColor) tg.setBackgroundColor('secondary_bg_color');
    if (tg.setBottomBarColor) tg.setBottomBarColor('bottom_bar_bg_color');
  } catch (e) {}
}

export const initData = () => (tg ? tg.initData : (new URLSearchParams(location.search).get('initData') || ''));
export const startParam = () => (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || new URLSearchParams(location.search).get('tab') || '';
export const tgUser = () => (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
export const langCode = () => String((tgUser() || {}).language_code || navigator.language || 'uk').slice(0, 2);

export function haptic(kind) {
  if (!tg || !tg.HapticFeedback) return;
  try {
    if (kind === 'success' || kind === 'error' || kind === 'warning') tg.HapticFeedback.notificationOccurred(kind);
    else if (kind === 'select') tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.impactOccurred(kind || 'light');
  } catch (e) {}
}

// Кнопка «назад» у шапці Telegram.
let backFn = null;
export function setBack(fn) {
  backFn = fn;
  if (!tg || !tg.BackButton) return;
  try { if (fn) tg.BackButton.show(); else tg.BackButton.hide(); } catch (e) {}
}
if (tg && tg.BackButton) tg.BackButton.onClick(() => { if (backFn) backFn(); });

export function confirm(text) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) {
      try { tg.showConfirm(text, (ok) => resolve(!!ok)); return; } catch (e) {}
    }
    resolve(window.confirm(text));
  });
}
export function alert(text) {
  return new Promise((resolve) => {
    if (tg && tg.showAlert && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) {
      try { tg.showAlert(text, () => resolve()); return; } catch (e) {}
    }
    window.alert(text); resolve();
  });
}

export function openLink(url) {
  if (!url) return;
  if (tg && /^https:\/\/t\.me\//.test(url) && tg.openTelegramLink) { try { tg.openTelegramLink(url); return; } catch (e) {} }
  if (tg && tg.openLink) { try { tg.openLink(url); return; } catch (e) {} }
  window.open(url, '_blank', 'noopener');
}

// Оплата Telegram Stars. Повертає статус: paid | cancelled | failed | pending.
export function openInvoice(link) {
  return new Promise((resolve) => {
    if (tg && tg.openInvoice) {
      try { tg.openInvoice(link, (status) => resolve(status)); return; } catch (e) {}
    }
    window.open(link, '_blank', 'noopener');
    resolve('pending');
  });
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}

export function share(url, text) {
  openLink('https://t.me/share/url?url=' + encodeURIComponent(url) + (text ? '&text=' + encodeURIComponent(text) : ''));
}
