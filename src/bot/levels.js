// ==========================================================================
// РІВНІ В БОТІ: «🏅 Мій рівень» — прогрес, нагорода за наступний рівень,
// привілеї, які вже діють, і всі сходинки. Плюс текст «новий рівень!».
// ==========================================================================
const E = require('../economy');
const users = require('../core/users');
const progress = require('../core/progress');
const i18n = require('../i18n');
const ui = require('./ui');
const { esc } = require('../lib/util');

const T = {
  uk: {
    title: '🏅 <b>Твій рівень</b>', lv: '{e} <b>{t}</b> — рівень {n} з {max} · {xp} XP',
    next: 'До {e} {t}: ще <b>{left} XP</b> → нагорода <b>{reward}</b>', max: '🏆 Найвищий рівень — ти легенда!',
    perks: '✨ <b>Твої привілеї зараз:</b>', fee: '💸 Комісія виводу: <b>{f}%</b>', feeBase: ' (звичайна {b}%)',
    topup: '⭐ Бонус до кожного поповнення: <b>+{p}%</b>', chat: '🎁 Щоденний бонус у чаті: <b>+{n}🎫</b>',
    feeFrom: ' · знижка — з рівня {n}', topupLocked: '⭐ Бонус до кожного поповнення — з рівня {n}', chatLocked: '🎁 Більший бонус у чаті — з рівня {n}',
    ladder: '📈 <b>Усі рівні:</b>',
    foot: '<i>Рівень не згорає. XP дають спіни, ігри на зірки, ставки в банк, друзі, поповнення, завдання й чат.</i>',
    games: '🎲 Заробляти XP в іграх', app: '🎰 Відкрити StarForge', back: '⬅️ Меню', btn: '🏅 Рівень {n} · {e} {t}',
  },
  en: {
    title: '🏅 <b>Your level</b>', lv: '{e} <b>{t}</b> — level {n} of {max} · {xp} XP',
    next: 'To {e} {t}: <b>{left} XP</b> more → reward <b>{reward}</b>', max: '🏆 Top level — you are a legend!',
    perks: '✨ <b>Your perks now:</b>', fee: '💸 Withdrawal fee: <b>{f}%</b>', feeBase: ' (normally {b}%)',
    topup: '⭐ Bonus on every top-up: <b>+{p}%</b>', chat: '🎁 Daily chat bonus: <b>+{n}🎫</b>',
    feeFrom: ' · discount from level {n}', topupLocked: '⭐ Bonus on every top-up — from level {n}', chatLocked: '🎁 Bigger chat bonus — from level {n}',
    ladder: '📈 <b>All levels:</b>',
    foot: '<i>Your level never resets. XP comes from spins, star games, bank bets, friends, top-ups, quests and chat.</i>',
    games: '🎲 Earn XP in games', app: '🎰 Open StarForge', back: '⬅️ Menu', btn: '🏅 Level {n} · {e} {t}',
  },
  ru: {
    title: '🏅 <b>Твой уровень</b>', lv: '{e} <b>{t}</b> — уровень {n} из {max} · {xp} XP',
    next: 'До {e} {t}: ещё <b>{left} XP</b> → награда <b>{reward}</b>', max: '🏆 Высший уровень — ты легенда!',
    perks: '✨ <b>Твои привилегии сейчас:</b>', fee: '💸 Комиссия вывода: <b>{f}%</b>', feeBase: ' (обычная {b}%)',
    topup: '⭐ Бонус к каждому пополнению: <b>+{p}%</b>', chat: '🎁 Ежедневный бонус в чате: <b>+{n}🎫</b>',
    feeFrom: ' · скидка — с уровня {n}', topupLocked: '⭐ Бонус к каждому пополнению — с уровня {n}', chatLocked: '🎁 Больше бонус в чате — с уровня {n}',
    ladder: '📈 <b>Все уровни:</b>',
    foot: '<i>Уровень не сгорает. XP дают спины, игры на звёзды, ставки в банк, друзья, пополнения, задания и чат.</i>',
    games: '🎲 Зарабатывать XP в играх', app: '🎰 Открыть StarForge', back: '⬅️ Меню', btn: '🏅 Уровень {n} · {e} {t}',
  },
};
const langOf = (u) => (u && T[u.lang] ? u.lang : 'uk');
const tt = (lang, k, p) => String((T[lang] || T.uk)[k] || T.uk[k]).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m));

function rewardText(rw) {
  return [rw && rw.tickets ? '+' + rw.tickets + '🎫' : null, rw && rw.stars ? '+' + rw.stars + '⭐' : null].filter(Boolean).join(' ');
}
// Що відкриває рівень: «комісія виводу 3% · +2% до кожного поповнення».
function unlockText(lang, un) {
  const out = [];
  if (un.withdrawFee != null) out.push(i18n.t(lang, 'perk.fee', { f: un.withdrawFee }));
  if (un.topupBonus != null) out.push(i18n.t(lang, 'perk.topup', { p: un.topupBonus }));
  if (un.chatBonus != null) out.push(i18n.t(lang, 'perk.chat', { n: un.chatBonus }));
  return out.join(' · ');
}
const firstLevelWith = (key) => { const x = E.LEVEL_PERKS[key].find(([, v]) => v > 0); return x ? x[0] : null; };
const bar = (pct) => { const k = Math.round(Math.max(0, Math.min(100, pct)) / 10); return '▰'.repeat(k) + '▱'.repeat(10 - k); };

// «🎉 НОВИЙ РІВЕНЬ!» — особисте повідомлення.
function levelUpText(lang, info, rw) {
  const un = unlockText(lang, E.perksUnlockedAt(info.n));
  const nx = info.next;
  const next = nx
    ? i18n.t(lang, 'level.next', { e: nx.e, t: esc(nx.t), left: nx.left, reward: rewardText(nx.reward) || '—', perks: unlockText(lang, nx.unlocks) ? ' · ' + unlockText(lang, nx.unlocks) : '' })
    : i18n.t(lang, 'level.max');
  return i18n.t(lang, 'level.up', {
    e: info.e, t: esc(info.t), n: info.n, max: E.LEVELS.length, reward: rewardText(rw) || '—',
    perks: un ? i18n.t(lang, 'level.perks', { list: un }) : '', next,
  });
}

function menuButton(u) {
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  return ui.cb(tt(lang, 'btn', { n: lv.n, e: lv.e, t: lv.t }), 'my_level', 'primary');
}

function levelsView(uid) {
  const u = users.get(uid) || {};
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  const p = lv.perks;
  const lines = [tt(lang, 'title'), '', tt(lang, 'lv', { e: lv.e, t: esc(lv.t), n: lv.n, max: lv.max, xp: Math.floor(lv.xp) }), bar(lv.pct) + ' ' + lv.pct + '%'];
  lines.push(lv.next ? tt(lang, 'next', { e: lv.next.e, t: esc(lv.next.t), left: lv.next.left, reward: rewardText(lv.next.reward) || '—' }) : tt(lang, 'max'));
  lines.push('', tt(lang, 'perks'));
  lines.push(tt(lang, 'fee', { f: p.withdrawFee }) + (p.withdrawFee < E.WITHDRAW.feePercent ? tt(lang, 'feeBase', { b: E.WITHDRAW.feePercent }) : tt(lang, 'feeFrom', { n: E.LEVEL_PERKS.withdrawFee[1][0] })));
  lines.push(p.topupBonus ? tt(lang, 'topup', { p: p.topupBonus }) : tt(lang, 'topupLocked', { n: firstLevelWith('topupBonus') }));
  lines.push(p.chatBonus ? tt(lang, 'chat', { n: p.chatBonus }) : tt(lang, 'chatLocked', { n: firstLevelWith('chatBonus') }));
  lines.push('', tt(lang, 'ladder'));
  for (const L of progress.ladder(u, lang)) {
    const mark = L.n === lv.n ? '👉' : L.reached ? '✅' : '🔒';
    const extra = [rewardText(L.reward), unlockText(lang, L.unlocks)].filter(Boolean).join(' · ');
    lines.push(`${mark} ${L.e} ${esc(L.t)}` + (L.reached ? '' : ` · ${L.at} XP`) + (extra ? ' — ' + extra : ''));
  }
  lines.push('', tt(lang, 'foot'));
  return {
    text: lines.join('\n'),
    extra: { parse_mode: 'HTML', ...ui.kb([
      [ui.cb(tt(lang, 'games'), 'dice_menu', 'danger')],
      [ui.app(tt(lang, 'app'), 'progress', 'success')],
      [ui.cb(tt(lang, 'back'), 'back_to_menu')],
    ]) },
  };
}

function register(bot) {
  const show = async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (ctx.chat && ctx.chat.type !== 'private') return;
    users.ensure(ctx.from);
    const v = levelsView(String(ctx.from.id));
    await ctx.reply(v.text, v.extra).catch(() => {});
  };
  bot.command(['level', 'levels', 'perks'], show);
  bot.action('my_level', show);
}

module.exports = { register, levelsView, levelUpText, menuButton, rewardText };
