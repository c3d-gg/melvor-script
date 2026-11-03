// Adventure Land style: a loop that looks at the game every 100ms and acts when it can.
// Chops Normal trees until there are 20 logs, burns them all, and repeats until you stop it
// (Ctrl+C or the in-game Stop button).
//
// Made for the Scripted gamemode, where every action is instant and then cools down
// (normal time ÷ your Speed setting). In real-time mode `m.ready` just waits for each action to finish.
import { run, Items, Trees, FiremakingLogs } from 'melvor-script';

const STACK = 20;

run((m) => {
  let burning = false;

  setInterval(() => {
    if (!m.ready) return; // cooling down: nothing to do this tick

    const logs = m.bank.count(Items.Normal_Logs);
    if (logs >= STACK) burning = true;
    if (logs === 0) burning = false;

    if (burning) m.skills.firemaking.burn(FiremakingLogs.Normal_Logs);
    else m.skills.woodcutting.cut(Trees.Normal);
  }, 100);

  m.on('levelUp', (e) => m.success(`${m.state.skills[e.skill]?.name} is now level ${e.newLevel}`));
});
