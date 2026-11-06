// The two ways to write a script, for the quick start and the concepts page.
import { run, Trees, Items, FiremakingLogs } from 'melvor-script';

// #region await
// Await style: every action resolves when you may act again, so a plain loop paces itself.
run(async (m) => {
  while (m.bank.count(Items.Oak_Logs) < 200) {
    await m.skills.woodcutting.cut(Trees.Oak);
  }
});
// #endregion

// #region loop
// Loop style (like Adventure Land): look at the game every tick, act when ready.
run((m) => {
  setInterval(() => {
    if (!m.ready) return; // still cooling down
    if (m.bank.count(Items.Normal_Logs) >= 20) m.skills.firemaking.burn(FiremakingLogs.Normal_Logs);
    else m.skills.woodcutting.cut(Trees.Normal);
  }, 100);
});
// #endregion
