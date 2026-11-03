// Mine copper and tin in equal amounts, then smelt bronze bars.
// Shows error handling: the game refuses jobs it can't start (LOCKED, MISSING_ITEMS).
import { run, Items, Rocks, SmithingRecipes, MelvorError } from 'melvor-script';

const BARS = 25;

run(async (m) => {
  const mining = m.skills.mining;

  while (m.bank.count(Items.Copper_Ore) < BARS || m.bank.count(Items.Tin_Ore) < BARS) {
    // Mine whichever ore we have less of. A depleted rock just waits for its respawn.
    const rock = m.bank.count(Items.Copper_Ore) <= m.bank.count(Items.Tin_Ore) ? Rocks.Copper_Ore : Rocks.Tin_Ore;
    await mining.mine(rock, { count: 5 });
  }

  try {
    const r = await m.skills.smithing.smith(SmithingRecipes.Bronze_Bar, { count: BARS });
    // Skill bonuses can double the bars or save the ore, so count what actually arrived.
    m.success(`${r.completed} smelts made ${r.items[Items.Bronze_Bar] ?? 0} bronze bars`, r.items);
  } catch (e) {
    if (e instanceof MelvorError && e.code === 'MISSING_ITEMS') {
      m.error('Not enough ore after all:', e.missing);
    } else {
      throw e;
    }
  }
});
