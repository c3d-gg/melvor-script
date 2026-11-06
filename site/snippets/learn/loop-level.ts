// Lesson 3, challenge: stop at 100 logs, or as soon as Woodcutting reaches level 15.
import { run, Trees, Items } from 'melvor-script';

run(async (m) => {
  while (m.bank.count(Items.Normal_Logs) < 100 && m.skills.woodcutting.level < 15) {
    await m.skills.woodcutting.cut(Trees.Normal);
  }
  m.log(`Stopped with ${m.bank.count(Items.Normal_Logs)} logs at level ${m.skills.woodcutting.level}.`);
});
