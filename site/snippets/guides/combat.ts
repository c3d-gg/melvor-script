// Code for the combat guide (site/src/content/docs/guides/combat.mdx).
// Each `// #region` is shown on the page by <Snippet region="...">. Never run as a whole.
import {
  run,
  Items,
  Monsters,
  Dungeons,
  Prayers,
  Potions,
  AttackStyles,
  AttackSpells,
  RunecraftingRecipes,
  FightStoppedError,
  type AttackSpellId,
} from 'melvor-script';

run(async (m) => {
  // #region gear-melee
  await m.player.equip(Items.Bronze_Sword);
  await m.player.setAttackStyle(AttackStyles.Slash); // Stab, Slash or Block
  // #endregion

  // #region gear-ranged
  await m.player.equip(Items.Normal_Shortbow);
  // Arrows go in the quiver: equip all of them at once.
  await m.player.equip(Items.Bronze_Arrows, { quantity: m.bank.count(Items.Bronze_Arrows) });
  await m.player.setAttackStyle(AttackStyles.Rapid); // Accurate, Rapid or Longrange
  // #endregion

  // #region gear-magic
  // A staff makes every attack a spell. Staff of Fire: Runecrafting 14, 1 Normal Log + 100 Fire Runes.
  await m.skills.runecrafting.craft(RunecraftingRecipes.Staff_of_Fire);
  await m.player.equip(Items.Staff_of_Fire);
  await m.player.setAttackStyle(AttackStyles.Magic); // Magic or Defensive
  // Fire Strike (Magic 10) costs 1 Air, 1 Mind and 1 Fire Rune per cast; the staff covers the fire.
  await m.player.setSpells({ attack: AttackSpells.FireStrike });
  // #endregion

  // #region best-spell
  // The strongest standard spell you can cast right now.
  const spells = await m.data.spells();
  const best = spells
    .filter((s) => s.kind === 'attack' && s.unlocked && s.spellbook === 'melvorD:Standard')
    .sort((a, b) => (b.maxHit ?? 0) - (a.maxHit ?? 0))[0];
  if (best) await m.player.setSpells({ attack: best.id as AttackSpellId });
  // #endregion

  // #region fight
  const result = await m.combat.fight(Monsters.Chicken, { kills: 10 });
  m.log(`${result.kills} kills in ${Math.round(result.durationMs / 1000)}s`, result.items);
  // #endregion

  // #region eat-while-fighting
  // fight() doesn't eat for you (unless you have the game's Auto Eat). Watch your HP instead:
  // m.onState runs every time the game sends new state, several times a second.
  await m.player.equipFood(Items.Shrimp, m.bank.count(Items.Shrimp));
  let eating = false;
  const stopWatching = m.onState(() => {
    if (eating || m.player.hpFraction >= 0.5 || m.player.currentFood.quantity === 0) return;
    eating = true; // eat once, not on every update while the first bite is on its way
    m.player.eat().finally(() => (eating = false));
  });
  try {
    await m.combat.fight(Monsters.Cow, { kills: 20 });
  } finally {
    stopWatching();
  }
  // #endregion

  // #region stopped
  try {
    await m.combat.fight(Monsters.Cow, { kills: 50 });
  } catch (e) {
    if (!(e instanceof FightStoppedError)) throw e;
    m.warn(`The fight ended early: ${e.result.reason}`); // you died, fled, or ran out of ammo
  }

  // Or ask for the result instead of an error:
  const r = await m.combat.fight(Monsters.Cow, { kills: 50, allowStop: true });
  if (r.status !== 'completed') m.warn(`Only ${r.kills} kills: ${r.reason}`);
  // #endregion

  // #region loot-prayer-potion
  await m.combat.collectLoot(); // loot waits in a container until you collect it
  if (m.bank.count(Items.Bones) > 0) await m.bank.bury(Items.Bones, m.bank.count(Items.Bones));
  await m.player.togglePrayer(Prayers.Thick_Skin);
  await m.potions.use(Potions.Melee_Accuracy_Potion_I);
  // #endregion

  // #region dungeon
  const clear = await m.combat.dungeon(Dungeons.Chicken_Coop, { runs: 1 });
  m.log(`Cleared the Chicken Coop: ${clear.kills} kills`, clear.items);
  // #endregion
});

// #region turn-based
// Scripted Mode: one attack() is one round. You swing, then the monster swings, and nothing
// happens in between, so you can decide before every single round.
run((m) => {
  let eating = false;
  setInterval(() => {
    if (!eating && m.player.hpFraction < 0.5 && m.player.currentFood.quantity > 0) {
      eating = true;
      m.player.eat().finally(() => (eating = false));
    }
    if (!m.ready) return; // still cooling down from the last round
    if (!m.combat.active) m.combat.start(Monsters.Chicken);
    else if (m.combat.fighting) m.combat.attack();
  }, 100);
});
// #endregion
