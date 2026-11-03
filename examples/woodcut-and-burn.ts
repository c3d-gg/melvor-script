// Chop logs until we have enough, then burn them all (await style).
// Each cut() is one woodcutting action. In the Scripted gamemode it happens instantly and the
// await resolves when the cooldown is over; in real-time mode it takes the normal interval.
import { run, Items, Trees, FiremakingLogs } from 'melvor-script';

const TARGET = 50;

run(async (m) => {
  const wc = m.skills.woodcutting;

  while (m.bank.count(Items.Normal_Logs) < TARGET) {
    await wc.cut(Trees.Normal);
  }
  m.log(`Have ${m.bank.count(Items.Normal_Logs)} logs. Lighting them up.`);

  // One job for the whole stack: no round trips between logs.
  const result = await m.skills.firemaking.burn(FiremakingLogs.Normal_Logs, { count: m.bank.count(Items.Normal_Logs) });
  m.success(`Burned ${result.completed} logs for ${result.xp['melvorD:Firemaking'] ?? 0} Firemaking XP`);
});
