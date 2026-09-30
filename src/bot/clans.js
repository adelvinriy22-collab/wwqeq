// ==========================================================================
// КЛАНИ в особистих з ботом: ті самі команди, що й у чаті, плюс кнопки
// заявок (лідер отримує їх сюди й приймає чи відхиляє одним натиском).
// Уся логіка — features/clans.js.
// ==========================================================================
const users = require('../core/users');
const clans = require('../features/clans');

function register(bot, hooks) {
  // Назва клану після кнопки «Свій клан» і автовступ після /start clan_…
  hooks.onText.push((ctx, uid, text) => clans.onPrivateText(ctx, uid, text));
  hooks.onStartPayload.push((ctx, uid, payload) => clans.onStart(ctx, uid, payload));
  const names = clans.COMMANDS.map(c => c.slice(1));
  bot.command(names, async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    users.ensure(ctx.from);
    const cmd = String(ctx.message.text || '').split(/\s|@/)[0].toLowerCase();
    return clans.command(ctx, cmd);
  });
  bot.command('clanwar', (ctx) => {
    if (!(ctx.from && users.isAdmin(ctx.from.id)) || (ctx.chat && ctx.chat.type !== 'private')) return;
    return clans.adminCommand(ctx);
  });
  bot.action(/^cl:/, (ctx) => clans.callback(ctx));
}

module.exports = { register };
