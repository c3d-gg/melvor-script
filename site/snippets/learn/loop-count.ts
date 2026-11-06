// Lesson 3: a variable that changes. Count the chops as you go.
import { run, Trees, Items } from 'melvor-script';

run(async (m) => {
  let chops = 0;

  while (m.bank.count(Items.Normal_Logs) < 100) {
    await m.skills.woodcutting.cut(Trees.Normal);
    chops = chops + 1;
  }

  m.log(`That took ${chops} chops.`);
});
