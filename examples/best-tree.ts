// Always cut the tree with the best XP per second you can reach, selling logs
// when the bank fills up. Runs until you stop it (Ctrl+C or the in-game Stop button).
import { run, type TreeId } from 'melvor-script';

run(async (m) => {
  const wc = m.skills.woodcutting;

  m.on('levelUp', (e) => {
    if (e.skill === wc.id) m.success(`Woodcutting ${e.newLevel}!`);
  });

  for (;;) {
    const trees = await wc.actions(true); // refresh: "unlocked" changes as you level
    const best = trees.filter((t) => t.unlocked).sort((a, b) => rate(b) - rate(a))[0];
    if (!best) throw new Error('No tree unlocked?');

    m.log(`Cutting ${best.name} (${rate(best).toFixed(2)} xp/s base)`);
    const result = await wc.cut(best.id as TreeId, { count: 20, allowStop: true });

    if (result.status === 'stopped' && m.bank.full) {
      // Sell every log type to make room, then carry on.
      for (const { id } of m.bank.items().filter((i) => i.id.endsWith('_Logs'))) {
        const sale = await m.bank.sell(id);
        m.log(`Sold ${sale.sold} x ${id} for ${sale.gained} GP`);
      }
    } else if (result.status !== 'completed') {
      throw new Error(`Woodcutting stopped: ${result.reason}`);
    }
  }
});

function rate(t: { baseExperience: number | null; baseIntervalMs: number | null }) {
  return (t.baseExperience ?? 0) / ((t.baseIntervalMs ?? 3000) / 1000);
}
