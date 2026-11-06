// Lesson 3, challenge: three rounds of "chop 20, burn 20". A for loop counts the rounds.
import { run, Trees, FiremakingLogs } from 'melvor-script';

run(async (m) => {
  for (let round = 1; round <= 3; round++) {
    await m.skills.woodcutting.cut(Trees.Normal, { count: 20 });
    await m.skills.firemaking.burn(FiremakingLogs.Normal_Logs, { count: 20 });
    m.log(`Round ${round} done`);
  }
});
