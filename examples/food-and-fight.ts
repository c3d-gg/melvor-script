// A tiny combat loop: catch and cook food, equip it, then fight chickens,
// eating whenever HP drops below half. Shows multi-skill planning + reacting to state.
import { run, Items, Fish, CookingRecipes, Monsters } from 'melvor-script';

const FOOD_TARGET = 20;
const KILLS = 25;

run(async (m) => {
  // 1. Food supply.
  while (m.bank.count(Items.Shrimp) + m.player.currentFood.quantity < FOOD_TARGET) {
    await m.skills.fishing.fish(Fish.Raw_Shrimp, { count: 5 });
    const raw = m.bank.count(Items.Raw_Shrimp);
    if (raw > 0) await m.skills.cooking.cook(CookingRecipes.Shrimp, { count: raw, allowStop: true });
  }
  if (m.bank.count(Items.Shrimp) > 0) await m.player.equipFood(Items.Shrimp, m.bank.count(Items.Shrimp));

  // 2. Eat below 50% HP. State is pushed a few times per second, so this reacts quickly.
  let eating = false;
  const stopWatching = m.onState((s) => {
    if (eating || s.player.hp >= s.player.maxHp * 0.5 || m.player.currentFood.quantity === 0) return;
    eating = true;
    m.player
      .eat()
      .then(({ hp }) => m.log(`ate, hp ${hp}/${m.player.maxHp}`))
      .catch((e) => m.warn('could not eat:', e.message))
      .finally(() => (eating = false));
  });

  // 3. Fight.
  try {
    const r = await m.combat.fight(Monsters.Chicken, { kills: KILLS });
    m.success(`Killed ${r.kills} chickens in ${(r.durationMs / 1000).toFixed(0)}s`, r.items);
  } finally {
    stopWatching();
  }

  // 4. Bury the bones for Prayer XP.
  if (m.bank.count(Items.Bones) > 0) await m.bank.bury(Items.Bones, m.bank.count(Items.Bones));
});
