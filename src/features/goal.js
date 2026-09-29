// Спільна ціль: усі разом крутять N спінів — випадковий учасник отримує приз.
const store = require('../store');
const E = require('../economy');
const notify = require('../core/notify');
const applications = require('./applications');
const crypto = require('crypto');

function get() {
  const f = store.getFeatureFlags() || {};
  return { count: f.goalCount || 0, participants: f.goalParticipants || [], done: !!f.goalDone };
}

function view(uid) {
  const g = get();
  return { count: g.count, target: E.GOAL.target, done: g.done, joined: g.participants.includes(String(uid)),
           participants: g.participants.length, prize: E.GOAL.prize };
}

function addSpin(uid) {
  const g = get();
  if (g.done) return;
  const id = String(uid);
  const parts = g.participants.includes(id) ? g.participants : g.participants.concat([id]);
  const count = g.count + 1;
  store.setFeatureFlags({ goalCount: count, goalParticipants: parts });
  if (count >= E.GOAL.target) finish(parts).catch(e => console.error('goal finish:', e.message));
}

async function finish(parts) {
  store.setFeatureFlags({ goalDone: true });
  if (!parts.length) return;
  const winner = parts[crypto.randomInt(parts.length)];
  const t = E.getTier(E.GOAL.prize);
  const a = applications.create(winner, E.GOAL.prize, 'goal');
  for (const uid of parts) {
    const txt = uid === winner
      ? `🎯 <b>Спільну ціль досягнуто!</b>\n\nПриз дістався тобі — ${t.emoji} ${t.name.uk}. Заявка #${a.id}.`
      : `🎯 <b>Спільну ціль досягнуто!</b>\n\nРазом накрутили ${E.GOAL.target} спінів. Приз ${t.emoji} дістався іншому учаснику — дякуємо, що був з нами 🙌`;
    await notify.dm(uid, txt);
    await new Promise(r => setTimeout(r, 80));
  }
}

function reset() { store.setFeatureFlags({ goalCount: 0, goalParticipants: [], goalDone: false }); }

module.exports = { get, view, addSpin, reset };
