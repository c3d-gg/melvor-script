// Slayer tasks back to back: get a task, top up HP and the combat potion, fight it, repeat.
// Runs until you stop it or a fight ends early. Works in real time and in the Scripted gamemode.
//
// Equip food first. The fight itself only eats if you have the game's Auto Eat, so this script
// eats between tasks. Getting tasks, potions and eating cost no cooldown.
import { run, Potions, SlayerCategories } from 'melvor-script';

const TIER = SlayerCategories.Easy;
const POTION = Potions.Melee_Accuracy_Potion_I;

run(async (m) => {
  const slayer = m.combat.slayer;
  for (;;) {
    // Keeps the task you have; after a task the game picks the next one in the same tier for free.
    const task = await slayer.ensureTask(TIER);
    m.log(`task: ${task.killsLeft} x ${task.monster}`);

    if (!m.potions.activeFor('melvorD:Combat') && m.bank.has(POTION)) await m.potions.use(POTION);
    while (m.player.hpFraction < 0.8 && m.player.currentFood.quantity > 0) await m.player.eat();

    const r = await slayer.fight({ allowStop: true });
    if (r.status !== 'completed') return m.warn(`fight ended early: ${r.reason}`);
    m.success(`task done: ${r.kills} kills in ${Math.round(r.durationMs / 1000)}s`, r.items);
  }
});
