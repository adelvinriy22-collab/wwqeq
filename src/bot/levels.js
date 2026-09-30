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
const { withEmoji } = require('../emoji');

const T = {
  uk: {
    title: 'МІЙ РІВЕНЬ', lv: '{e} <b>{t}</b> — рівень {n} з {max} · {xp} XP',
    next: '{:lightning} До {e} {t}: ще <b>{left} XP</b> → нагорода <b>{reward}</b>', max: '{:trophy} Найвищий рівень — ти легенда!',
    perks: '{:crown} <b>Твої привілеї зараз:</b>', fee: '{:commission} Комісія виводу: <b>{f}%</b>', feeBase: ' (звичайна {b}%)',
    topup: '{:starIcon} Бонус до кожного поповнення: <b>+{p}%</b>', chat: '{:giftBox} Щоденний бонус у чаті: <b>+{n}🎫</b>',
    feeFrom: ' · знижка — з рівня {n}', topupLocked: '{:lockIcon} Бонус до кожного поповнення — з рівня {n}', chatLocked: '{:lockIcon} Більший бонус у чаті — з рівня {n}',
    ladder: '{:statsIcon} <b>Усі рівні:</b>',
    foot: 'Рівень не згорає. XP дають спіни, ігри на зірки, ставки в банк, друзі, поповнення, завдання й чат.',
    games: '🎲 ЗАРОБЛЯТИ XP В ІГРАХ', app: 'ВІДКРИТИ STARFORGE', btn: 'РІВЕНЬ {n} · {e} {t}',
  },
  en: {
    title: 'MY LEVEL', lv: '{e} <b>{t}</b> — level {n} of {max} · {xp} XP',
    next: '{:lightning} To {e} {t}: <b>{left} XP</b> more → reward <b>{reward}</b>', max: '{:trophy} Top level — you are a legend!',
    perks: '{:crown} <b>Your perks now:</b>', fee: '{:commission} Withdrawal fee: <b>{f}%</b>', feeBase: ' (normally {b}%)',
    topup: '{:starIcon} Bonus on every top-up: <b>+{p}%</b>', chat: '{:giftBox} Daily chat bonus: <b>+{n}🎫</b>',
    feeFrom: ' · discount from level {n}', topupLocked: '{:lockIcon} Bonus on every top-up — from level {n}', chatLocked: '{:lockIcon} Bigger chat bonus — from level {n}',
    ladder: '{:statsIcon} <b>All levels:</b>',
    foot: 'Your level never resets. XP comes from spins, star games, bank bets, friends, top-ups, quests and chat.',
    games: '🎲 EARN XP IN GAMES', app: 'OPEN STARFORGE', btn: 'LEVEL {n} · {e} {t}',
  },
  ru: {
    title: 'МОЙ УРОВЕНЬ', lv: '{e} <b>{t}</b> — уровень {n} из {max} · {xp} XP',
    next: '{:lightning} До {e} {t}: ещё <b>{left} XP</b> → награда <b>{reward}</b>', max: '{:trophy} Высший уровень — ты легенда!',
    perks: '{:crown} <b>Твои привилегии сейчас:</b>', fee: '{:commission} Комиссия вывода: <b>{f}%</b>', feeBase: ' (обычная {b}%)',
    topup: '{:starIcon} Бонус к каждому пополнению: <b>+{p}%</b>', chat: '{:giftBox} Ежедневный бонус в чате: <b>+{n}🎫</b>',
    feeFrom: ' · скидка — с уровня {n}', topupLocked: '{:lockIcon} Бонус к каждому пополнению — с уровня {n}', chatLocked: '{:lockIcon} Больше бонус в чате — с уровня {n}',
    ladder: '{:statsIcon} <b>Все уровни:</b>',
    foot: 'Уровень не сгорает. XP дают спины, игры на звёзды, ставки в банк, друзья, пополнения, задания и чат.',
    games: '🎲 ЗАРАБАТЫВАТЬ XP В ИГРАХ', app: 'ОТКРЫТЬ STARFORGE', btn: 'УРОВЕНЬ {n} · {e} {t}',
  },
};
const langOf = (u) => (u && T[u.lang] ? u.lang : 'uk');
const fill = (lang, k, p) => String((T[lang] || T.uk)[k] || T.uk[k]).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] !== undefined ? p[x] : m));
const tt = (lang, k, p) => withEmoji(fill(lang, k, p));     // текст повідомлення з преміум-емодзі
const bt = fill;                                           // підпис кнопки

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

// Що відкрилось на рівнях from…to (стрибок може бути на кілька рівнів).
function unlockedBetween(from, to) {
  const out = {};
  for (let n = from || to; n <= to; n++) Object.assign(out, E.perksUnlockedAt(n));
  return out;
}

// «🎉 НОВИЙ РІВЕНЬ!» — особисте повідомлення. rw — сума нагород за всі пройдені рівні.
function levelUpText(lang, info, rw, fromN) {
  const un = unlockText(lang, unlockedBetween(fromN, info.n));
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
  return ui.cb(bt(lang, 'btn', { n: lv.n, e: lv.e, t: String(lv.t).toUpperCase() }), 'my_level', 'primary', 'crown');
}

function levelsView(uid) {
  const u = users.get(uid) || {};
  const lang = langOf(u);
  const lv = progress.view(u, lang).level;
  const p = lv.perks;
  const lines = [tt(lang, 'lv', { e: lv.e, t: esc(lv.t), n: lv.n, max: lv.max, xp: Math.floor(lv.xp) }), bar(lv.pct) + ' ' + lv.pct + '%'];
  lines.push(lv.next ? tt(lang, 'next', { e: lv.next.e, t: esc(lv.next.t), left: lv.next.left, reward: rewardText(lv.next.reward) || '—' }) : tt(lang, 'max'));
  lines.push('', tt(lang, 'perks'));
  lines.push(tt(lang, 'fee', { f: p.withdrawFee }) + (p.withdrawFee < E.WITHDRAW.feePercent ? tt(lang, 'feeBase', { b: E.WITHDRAW.feePercent }) : tt(lang, 'feeFrom', { n: E.LEVEL_PERKS.withdrawFee[1][0] })));
  lines.push(p.topupBonus ? tt(lang, 'topup', { p: p.topupBonus }) : tt(lang, 'topupLocked', { n: firstLevelWith('topupBonus') }));
  lines.push(p.chatBonus ? tt(lang, 'chat', { n: p.chatBonus }) : tt(lang, 'chatLocked', { n: firstLevelWith('chatBonus') }));
  lines.push('', tt(lang, 'ladder'));
  const mk = { cur: withEmoji('{:lightning}'), done: withEmoji('{:check}'), lock: withEmoji('{:lockIcon}') };
  for (const L of progress.ladder(u, lang)) {
    const mark = L.n === lv.n ? mk.cur : L.reached ? mk.done : mk.lock;
    const extra = [rewardText(L.reward), unlockText(lang, L.unlocks)].filter(Boolean).join(' · ');
    const name = L.n === lv.n ? `<b>${L.e} ${esc(L.t)}</b>` : `${L.e} ${esc(L.t)}`;
    lines.push(`${mark} ${name}` + (L.reached ? '' : ` · ${L.at} XP`) + (extra ? ' — ' + extra : ''));
  }
  return {
    text: ui.card('crown', tt(lang, 'title'), lines, bt(lang, 'foot')),
    extra: { parse_mode: 'HTML', ...ui.kb([
      [ui.cb(bt(lang, 'games'), 'dice_menu', 'danger', 'starIcon')],
      [ui.app(bt(lang, 'app'), 'progress', 'success', 'rocket')],
      [ui.back(lang)],
    ]) },
  };
}

function register(bot) {
  const show = async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (ctx.chat && ctx.chat.type !== 'private') return;
    users.ensure(ctx.from);
    const uid = String(ctx.from.id);
    const v = levelsView(uid);
    await ctx.reply(v.text, v.extra).catch(() => {});
    await require('./menu').ensureBackKeyboard(ctx, uid);
  };
  bot.command(['level', 'levels', 'perks'], show);
  bot.action('my_level', show);
}

module.exports = { register, levelsView, levelUpText, menuButton, rewardText, unlockedBetween };
