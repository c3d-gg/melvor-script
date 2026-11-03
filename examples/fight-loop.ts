// Turn-based combat, Adventure Land style (Scripted gamemode).
// Each attack() is one round: you swing, then the monster swings. Nothing happens between
// rounds, so you can eat at exactly the right moment. Runs until you stop it.
//
// Equip some food first (e.g. run food-and-fight.ts, or do it in the game).
import { run, Items, Monsters } from 'melvor-script';

const EAT_BELOW = 0.5;

run((m) => {
  if (!m.instant) throw new Error('fight-loop is for the Scripted gamemode (instant actions)');
  let eating = false;

  setInterval(() => {
    // Eating, looting and burying aren't actions: no cooldown.
    if (!eating && m.player.hpFraction < EAT_BELOW && m.player.currentFood.quantity > 0) {
      eating = true;
      m.player.eat().finally(() => (eating = false));
    }
    if (Object.keys(m.combat.loot).length > 0) m.combat.collectLoot();
    if (m.bank.count(Items.Bones) >= 10) m.bank.bury(Items.Bones, 10);

    if (!m.ready) return;
    if (!m.combat.active) m.combat.start(Monsters.Chicken);
    else if (m.combat.fighting) m.combat.attack();
  }, 100);

  m.on('monsterKilled', () => m.log(`kill! hp ${m.player.hp}/${m.player.maxHp}`));
});
