// Lesson 3: keep chopping until there are 100 logs in the bank.
import { run, Trees, Items } from 'melvor-script';

run(async (m) => {
  const target = 100;

  while (m.bank.count(Items.Normal_Logs) < target) {
    await m.skills.woodcutting.cut(Trees.Normal);
  }

  m.log(`I have ${m.bank.count(Items.Normal_Logs)} logs!`);
});
