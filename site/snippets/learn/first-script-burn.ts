// Lesson 2, challenge: chop five, then burn five.
import { run, Trees, FiremakingLogs } from 'melvor-script';

run(async (m) => {
  await m.skills.woodcutting.cut(Trees.Normal, { count: 5 });
  await m.skills.firemaking.burn(FiremakingLogs.Normal_Logs, { count: 5 });
  m.log(`Firemaking is level ${m.skills.firemaking.level}.`);
});
